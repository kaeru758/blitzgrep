import * as vscode from 'vscode';
import { gitPath } from '../git/gitService';
import { log } from '../log';
import type { HitOrigin, HitSink, SearchHit, SearchOptions } from '../types';
import { buildJsRegex, clampLine, findMatches, stripEol } from '../util/pattern';
import { runStreaming } from '../util/proc';
import { toPathspecs } from './gitGrepProvider';

/** コミット見出しとして自前で差し込むマーカー。diff 本文と衝突しない文字列にする。 */
const MARK = 'BG';
const FIELD = '\u001f';

export function buildPickaxeArgs(
  opts: SearchOptions,
  scope: { allRefs: boolean; maxCommits: number },
): string[] {
  const args = [
    '--no-pager',
    'log',
    `--format=${MARK}%H${FIELD}%h${FIELD}%an${FIELD}%aI${FIELD}%s`,
    '--patch',
    '--unified=0',
    // マージコミットの差分は親ごとに重複するのでノイズになる。
    '--no-merges',
    '--no-color',
    '--no-textconv',
    `--max-count=${Math.max(1, scope.maxCommits)}`,
  ];
  if (scope.allRefs) {
    args.push('--all');
  }
  if (opts.isRegex) {
    // -G は「差分そのもの」を正規表現で見る。出現回数の増減に関係なく拾えるので
    // 「この文字列が触られたコミット」を探す用途に合う。
    args.push(`-G${opts.query}`);
  } else {
    args.push(`-S${opts.query}`);
  }
  if (!opts.isCaseSensitive) {
    args.push('--regexp-ignore-case');
  }
  const specs = toPathspecs(opts.includeGlobs, opts.excludeGlobs);
  if (specs.length > 0) {
    args.push('--', ...specs);
  }
  return args;
}

interface CommitHeader {
  sha: string;
  shortSha: string;
  author: string;
  date: string;
  subject: string;
}

export function parseCommitHeader(line: string): CommitHeader | undefined {
  if (!line.startsWith(MARK)) {
    return undefined;
  }
  const [sha, shortSha, author, date, ...rest] = line.slice(MARK.length).split(FIELD);
  if (!sha || !shortSha) {
    return undefined;
  }
  return { sha, shortSha, author: author ?? '', date: date ?? '', subject: rest.join(FIELD) };
}

/** `@@ -12,3 +14,5 @@` から、新旧それぞれの開始行を取り出す。 */
export function parseHunkHeader(line: string): { oldStart: number; newStart: number } | undefined {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  if (!m) {
    return undefined;
  }
  return { oldStart: Number(m[1]), newStart: Number(m[2]) };
}

/** `+++ b/path/to/file` / `--- a/path` からパスを取り出す。 */
function parseFileHeader(line: string): string | undefined {
  if (line.startsWith('+++ ')) {
    const p = line.slice(4).trim();
    if (p === '/dev/null') {
      return undefined;
    }
    return p.replace(/^b\//, '');
  }
  return undefined;
}

/**
 * `git log -S/-G -p` の出力を流しながら、検索語を含む追加/削除行だけをヒットにする。
 * 「いつ入ったか」だけでなく「そのとき一緒に何が入ったか」も同じコミットの下に並ぶ。
 */
export async function searchHistory(
  root: string,
  opts: SearchOptions,
  scope: { allRefs: boolean; maxCommits: number },
  sink: HitSink,
  token: vscode.CancellationToken,
  nextId: () => number,
): Promise<void> {
  const re = buildJsRegex(opts);
  if (!re) {
    sink.error('正規表現が不正です。');
    return;
  }

  const args = buildPickaxeArgs(opts, scope);
  log.debug(`git ${args.join(' ')}  (cwd=${root})`);

  let commit: CommitHeader | undefined;
  let file = '';
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  let buffered: SearchHit[] = [];
  let sinkWantsMore = true;

  const flush = (): boolean => {
    if (buffered.length > 0) {
      sinkWantsMore = sink.push(buffered);
      buffered = [];
    }
    return sinkWantsMore;
  };

  const result = await runStreaming(gitPath(), args, {
    cwd: root,
    token,
    onLine: (raw) => {
      const line = stripEol(raw);

      const header = parseCommitHeader(line);
      if (header) {
        flush();
        commit = header;
        file = '';
        inHunk = false;
        return sinkWantsMore;
      }
      if (!commit) {
        return sinkWantsMore;
      }

      if (line.startsWith('diff --git ')) {
        file = '';
        inHunk = false;
        return sinkWantsMore;
      }
      const headerPath = parseFileHeader(line);
      if (headerPath !== undefined) {
        file = headerPath;
        return sinkWantsMore;
      }
      const hunk = parseHunkHeader(line);
      if (hunk) {
        oldLine = hunk.oldStart;
        newLine = hunk.newStart;
        inHunk = true;
        return sinkWantsMore;
      }
      if (!inHunk || !file) {
        return sinkWantsMore;
      }

      const marker = line[0];
      if (marker !== '+' && marker !== '-') {
        // --unified=0 なので文脈行はほぼ来ないが、来たら行番号だけ進める。
        oldLine++;
        newLine++;
        return sinkWantsMore;
      }

      const content = line.slice(1);
      const lineNumber = marker === '+' ? newLine : oldLine;
      if (marker === '+') {
        newLine++;
      } else {
        oldLine++;
      }

      const matches = findMatches(re, content);
      if (matches.length === 0) {
        return sinkWantsMore;
      }
      const clamped = clampLine(content, matches);
      const origin: HitOrigin = {
        kind: 'commit',
        sha: commit.sha,
        shortSha: commit.shortSha,
        author: commit.author,
        date: commit.date,
        subject: commit.subject,
        change: marker,
      };
      buffered.push({
        id: nextId(),
        // 追加行は「そのコミットの版」を、削除行は「その親の版」を開くのが自然。
        ref: marker === '+' ? commit.sha : `${commit.sha}^`,
        file,
        line: lineNumber,
        col: matches[0][0] + 1,
        len: matches[0][1],
        text: clamped.text,
        matches: clamped.matches,
        origin,
      });
      if (buffered.length >= 200) {
        return flush();
      }
      return sinkWantsMore;
    },
  });

  flush();

  if (result.code !== 0 && result.code !== 1 && !result.stopped) {
    const msg = result.stderr.split(/\r?\n/).find((l) => l.trim()) ?? `git log が終了コード ${result.code} で失敗`;
    sink.error(msg);
  }
}
