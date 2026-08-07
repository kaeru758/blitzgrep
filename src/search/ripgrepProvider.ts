import * as vscode from 'vscode';
import { getConfig } from '../config';
import { log } from '../log';
import type { HitSink, SearchHit, SearchOptions } from '../types';
import { byteOffsetToCharIndex, clampLine, stripEol } from '../util/pattern';
import { runStreaming } from '../util/proc';
import { locateRipgrep } from './rgLocator';

interface RgText {
  text?: string;
  bytes?: string;
}

interface RgSubmatch {
  match: RgText;
  start: number;
  end: number;
}

interface RgMessage {
  type: 'begin' | 'end' | 'match' | 'context' | 'summary';
  data: {
    path?: RgText;
    lines?: RgText;
    line_number?: number | null;
    submatches?: RgSubmatch[];
  };
}

function decode(t: RgText | undefined): string {
  if (!t) {
    return '';
  }
  if (typeof t.text === 'string') {
    return t.text;
  }
  if (typeof t.bytes === 'string') {
    return Buffer.from(t.bytes, 'base64').toString('utf8');
  }
  return '';
}

export function buildRipgrepArgs(opts: SearchOptions): string[] {
  const cfg = getConfig();
  const args = ['--json', '--crlf', '--no-config'];

  if (!opts.isRegex) {
    args.push('--fixed-strings');
  }
  if (!opts.isCaseSensitive) {
    args.push('--ignore-case');
  }
  if (opts.matchWholeWord) {
    args.push('--word-regexp');
  }
  if (cfg.includeHidden) {
    args.push('--hidden');
  }
  if (!cfg.useGitignore) {
    args.push('--no-ignore');
  }
  if (cfg.followSymlinks) {
    args.push('--follow');
  }
  if (cfg.maxFileSizeKb > 0) {
    args.push('--max-filesize', `${Math.floor(cfg.maxFileSizeKb)}K`);
  }
  if (cfg.contextLines > 0) {
    args.push('--before-context', String(cfg.contextLines));
    args.push('--after-context', String(cfg.contextLines));
  }
  for (const g of opts.includeGlobs) {
    if (g.trim()) {
      args.push('--glob', g.trim());
    }
  }
  for (const g of opts.excludeGlobs) {
    const t = g.trim();
    if (t) {
      args.push('--glob', t.startsWith('!') ? t : `!${t}`);
    }
  }
  args.push('--regexp', opts.query);
  args.push('--', '.');
  return args;
}

/**
 * ワーキングツリーを ripgrep で検索する。
 * 見つからない場合は呼び出し側が Node フォールバックへ切り替えられるよう false を返す。
 */
export async function searchWithRipgrep(
  cwd: string,
  opts: SearchOptions,
  sink: HitSink,
  token: vscode.CancellationToken,
  nextId: () => number,
): Promise<boolean> {
  const rg = await locateRipgrep();
  if (!rg) {
    return false;
  }

  const cfg = getConfig();
  const args = buildRipgrepArgs(opts);
  log.debug(`rg ${args.join(' ')}  (cwd=${cwd})`);

  // ファイル単位でバッファし、コンテキスト行を確定させてから push する。
  let currentFile = '';
  let buffered: SearchHit[] = [];
  let pendingBefore: string[] = [];
  let lastHit: SearchHit | undefined;
  let afterRemaining = 0;
  let sinkWantsMore = true;

  const flush = (): boolean => {
    if (buffered.length === 0) {
      return sinkWantsMore;
    }
    sinkWantsMore = sink.push(buffered);
    buffered = [];
    return sinkWantsMore;
  };

  const resetFileState = (file: string) => {
    currentFile = file;
    pendingBefore = [];
    lastHit = undefined;
    afterRemaining = 0;
  };

  const result = await runStreaming(rg, args, {
    cwd,
    token,
    onLine: (line) => {
      let msg: RgMessage;
      try {
        msg = JSON.parse(line) as RgMessage;
      } catch {
        return true; // JSON でない行 (エラーメッセージ等) は無視
      }

      switch (msg.type) {
        case 'begin': {
          flush();
          resetFileState(normalizePath(decode(msg.data.path)));
          return sinkWantsMore;
        }
        case 'end': {
          return flush();
        }
        case 'context': {
          if (cfg.contextLines === 0) {
            return sinkWantsMore;
          }
          const text = stripEol(decode(msg.data.lines));
          if (afterRemaining > 0 && lastHit) {
            (lastHit.after ??= []).push(text);
            afterRemaining--;
          } else {
            pendingBefore.push(text);
            if (pendingBefore.length > cfg.contextLines) {
              pendingBefore.shift();
            }
          }
          return sinkWantsMore;
        }
        case 'match': {
          const raw = decode(msg.data.lines);
          const text = stripEol(raw);
          const subs = msg.data.submatches ?? [];
          const matches: Array<[number, number]> = [];
          for (const s of subs) {
            const start = byteOffsetToCharIndex(text, s.start);
            const end = byteOffsetToCharIndex(text, s.end);
            if (end > start) {
              matches.push([start, end - start]);
            }
          }
          const clamped = clampLine(text, matches);
          const hit: SearchHit = {
            id: nextId(),
            ref: null,
            file: currentFile,
            line: msg.data.line_number ?? 1,
            col: (matches[0]?.[0] ?? 0) + 1,
            len: matches[0]?.[1] ?? 0,
            text: clamped.text,
            matches: clamped.matches,
          };
          if (cfg.contextLines > 0) {
            if (pendingBefore.length > 0) {
              hit.before = pendingBefore;
              pendingBefore = [];
            }
            lastHit = hit;
            afterRemaining = cfg.contextLines;
          }
          buffered.push(hit);
          if (cfg.contextLines === 0 && buffered.length >= 300) {
            return flush();
          }
          return sinkWantsMore;
        }
        default:
          return sinkWantsMore;
      }
    },
  });

  flush();

  // rg の終了コード: 0 = 一致あり, 1 = 一致なし, 2 = エラー
  if (result.code === 2 && result.stderr.trim() && !result.stopped) {
    sink.error(firstLine(result.stderr));
  }
  return true;
}

function firstLine(s: string): string {
  return s.split(/\r?\n/).find((l) => l.trim().length > 0) ?? s.trim();
}

function normalizePath(p: string): string {
  let s = p.replace(/\\/g, '/');
  if (s.startsWith('./')) {
    s = s.slice(2);
  }
  return s;
}
