import { MAX_LINE_CHARS } from '../config';
import type { SearchOptions } from '../types';

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * オプションから JS の RegExp を組み立てる。
 * git grep の結果 (一致位置を返さない) と、エディタ内ハイライトの両方で使う。
 * 不正な正規表現なら undefined。
 */
export function buildJsRegex(opts: Pick<SearchOptions, 'query' | 'isRegex' | 'isCaseSensitive' | 'matchWholeWord'>): RegExp | undefined {
  if (!opts.query) {
    return undefined;
  }
  let source = opts.isRegex ? opts.query : escapeRegExp(opts.query);
  if (opts.matchWholeWord) {
    source = `\\b(?:${source})\\b`;
  }
  const flags = opts.isCaseSensitive ? 'gu' : 'giu';
  try {
    return new RegExp(source, flags);
  } catch {
    // `u` フラグは一部のパターン (\p 以外のエスケープなど) を拒否するので緩めて再挑戦。
    try {
      return new RegExp(source, opts.isCaseSensitive ? 'g' : 'gi');
    } catch {
      return undefined;
    }
  }
}

/** 行テキスト内の一致位置を [開始, 長さ] で返す。空一致でも無限ループしない。 */
export function findMatches(re: RegExp, text: string, limit = 200): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[0].length > 0) {
      out.push([m.index, m[0].length]);
      if (out.length >= limit) {
        break;
      }
    }
    if (m.index === re.lastIndex) {
      re.lastIndex++;
    }
  }
  return out;
}

/**
 * 長すぎる行を、最初の一致が見えるように窓で切り出す。
 * 返り値の matches はトリム後のオフセットに変換済み。
 */
export function clampLine(
  text: string,
  matches: Array<[number, number]>,
): { text: string; matches: Array<[number, number]>; truncatedStart: boolean } {
  if (text.length <= MAX_LINE_CHARS) {
    return { text, matches, truncatedStart: false };
  }
  const first = matches.length > 0 ? matches[0][0] : 0;
  // 一致の少し手前から窓を取る。
  const start = Math.max(0, first - 40);
  const end = Math.min(text.length, start + MAX_LINE_CHARS);
  const sliced = text.slice(start, end);
  const shifted: Array<[number, number]> = [];
  for (const [s, len] of matches) {
    if (s >= start && s + len <= end) {
      shifted.push([s - start, len]);
    }
  }
  return { text: sliced, matches: shifted, truncatedStart: start > 0 };
}

/** UTF-8 バイトオフセットを、JS 文字列のインデックスに変換する (ripgrep の submatch 用)。 */
export function byteOffsetToCharIndex(line: string, byteOffset: number): number {
  if (byteOffset <= 0) {
    return 0;
  }
  let bytes = 0;
  for (let i = 0; i < line.length; i++) {
    if (bytes >= byteOffset) {
      return i;
    }
    const code = line.codePointAt(i)!;
    if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code <= 0xffff) {
      bytes += 3;
    } else {
      bytes += 4;
      i++; // サロゲートペアの後半をスキップ
    }
  }
  return line.length;
}

export function stripEol(s: string): string {
  let end = s.length;
  while (end > 0 && (s[end - 1] === '\n' || s[end - 1] === '\r')) {
    end--;
  }
  return s.slice(0, end);
}
