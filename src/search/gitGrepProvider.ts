import * as vscode from 'vscode';
import { getConfig } from '../config';
import { gitPath, supportsPcre } from '../git/gitService';
import { log } from '../log';
import type { HitSink, SearchHit, SearchOptions } from '../types';
import { buildJsRegex, byteOffsetToCharIndex, clampLine, findMatches, stripEol } from '../util/pattern';
import { pool, runStreaming } from '../util/proc';

/** include/exclude グロブを git の pathspec に変換する。 */
export function toPathspecs(includeGlobs: string[], excludeGlobs: string[]): string[] {
  const specs: string[] = [];
  for (const g of includeGlobs) {
    const t = g.trim();
    if (t) {
      specs.push(`:(glob)${normalizeGlob(t)}`);
    }
  }
  if (specs.length === 0) {
    specs.push(':(glob)**');
  }
  for (const g of excludeGlobs) {
    const t = g.trim().replace(/^!/, '');
    if (t) {
      specs.push(`:(exclude,glob)${normalizeGlob(t)}`);
    }
  }
  return specs;
}

function normalizeGlob(g: string): string {
  // ripgrep 風の "*.ts" は git の pathspec では先頭から評価されるので、全階層に広げる。
  if (!g.includes('/')) {
    return `**/${g}`;
  }
  return g.replace(/^\.\//, '');
}

export function buildGitGrepArgs(opts: SearchOptions, ref: string, usePcre: boolean): string[] {
  const args = [
    '--no-pager',
    'grep',
    '--no-color',
    '--full-name',
    '-I', // バイナリをスキップ
    '--line-number',
    '--column',
    '-z', // ファイル名の直後の区切りを NUL にする -> パスに ":" があっても壊れない
  ];
  if (!opts.isCaseSensitive) {
    args.push('--ignore-case');
  }
  if (opts.matchWholeWord) {
    args.push('--word-regexp');
  }
  if (opts.isRegex) {
    args.push(usePcre ? '--perl-regexp' : '--extended-regexp');
  } else {
    args.push('--fixed-strings');
  }
  args.push('-e', opts.query);
  args.push(ref);
  const specs = toPathspecs(opts.includeGlobs, opts.excludeGlobs);
  if (specs.length > 0) {
    args.push('--', ...specs);
  }
  return args;
}

/**
 * `git grep <ref>` の -z 出力 1 レコードをパースする。
 * 形式: `<ref>:<path>\0<line>\0<column>\0<content>`
 */
export function parseGitGrepLine(
  record: string,
  ref: string,
): { file: string; line: number; col: number; text: string } | undefined {
  const prefix = `${ref}:`;
  if (!record.startsWith(prefix)) {
    return undefined;
  }
  const rest = record.slice(prefix.length);
  const nul1 = rest.indexOf('\0');
  if (nul1 < 0) {
    return undefined;
  }
  const file = rest.slice(0, nul1);
  const nul2 = rest.indexOf('\0', nul1 + 1);
  if (nul2 < 0) {
    return undefined;
  }
  const line = Number(rest.slice(nul1 + 1, nul2));
  const nul3 = rest.indexOf('\0', nul2 + 1);
  if (nul3 < 0) {
    return undefined;
  }
  const col = Number(rest.slice(nul2 + 1, nul3));
  const text = stripEol(rest.slice(nul3 + 1));
  if (!Number.isFinite(line) || !Number.isFinite(col)) {
    return undefined;
  }
  return { file, line, col, text };
}

/** 指定した ref 群を git grep で横断検索する。 */
export async function searchRefs(
  root: string,
  refs: string[],
  opts: SearchOptions,
  sink: HitSink,
  token: vscode.CancellationToken,
  nextId: () => number,
  /** ref を 1 本終えるたびに呼ぶ。UI の進捗表示に使う。 */
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  const cfg = getConfig();
  const usePcre = opts.isRegex ? await supportsPcre(root) : false;
  const re = buildJsRegex(opts);
  let sinkWantsMore = true;
  let done = 0;
  // 打ち切った ref も「終わった」として数える。進捗が途中で止まって見えないように。
  const advance = () => onProgress?.(++done, refs.length);

  await pool(refs, cfg.branchConcurrency, async (ref) => {
    if (token.isCancellationRequested || !sinkWantsMore) {
      advance();
      return;
    }
    const args = buildGitGrepArgs(opts, ref, usePcre);
    log.debug(`git ${args.join(' ')}  (cwd=${root})`);

    let buffered: SearchHit[] = [];
    const flush = () => {
      if (buffered.length > 0) {
        sinkWantsMore = sink.push(buffered);
        buffered = [];
      }
      return sinkWantsMore;
    };

    try {
      const result = await runStreaming(gitPath(), args, {
        cwd: root,
        token,
        onLine: (record) => {
          const parsed = parseGitGrepLine(record, ref);
          if (!parsed) {
            return sinkWantsMore;
          }
          const matches = locateMatches(parsed.text, parsed.col, re, opts.query.length);
          const clamped = clampLine(parsed.text, matches);
          buffered.push({
            id: nextId(),
            ref,
            file: parsed.file,
            line: parsed.line,
            col: (matches[0]?.[0] ?? 0) + 1,
            len: matches[0]?.[1] ?? 0,
            text: clamped.text,
            matches: clamped.matches,
          });
          if (buffered.length >= 300) {
            return flush();
          }
          return sinkWantsMore;
        },
      });
      flush();

      // git grep の終了コード: 0 = 一致あり, 1 = 一致なし, それ以外はエラー。
      if (result.code !== 0 && result.code !== 1 && !result.stopped) {
        const msg = result.stderr.split(/\r?\n/).find((l) => l.trim()) ?? `git grep が終了コード ${result.code} で失敗`;
        sink.warn(`${ref}: ${msg}`);
      }
    } catch (err) {
      sink.warn(`${ref}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      advance();
    }
  });
}

/**
 * git grep は一致位置を 1 箇所しか返さないので、同じ行を JS 正規表現で再走査して
 * 全ての一致位置を得る。再走査で見つからなければ (POSIX と JS の構文差など)、
 * git が返した column をそのまま使う。
 */
function locateMatches(
  text: string,
  col: number,
  re: RegExp | undefined,
  fallbackLength: number,
): Array<[number, number]> {
  if (re) {
    const found = findMatches(re, text);
    if (found.length > 0) {
      return found;
    }
  }
  const start = byteOffsetToCharIndex(text, Math.max(0, col - 1));
  const len = Math.max(1, Math.min(fallbackLength, text.length - start));
  return start < text.length ? [[start, len]] : [];
}
