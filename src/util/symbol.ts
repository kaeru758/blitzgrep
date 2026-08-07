/**
 * コード 1 行から「会話ログで探す価値がある語」を 1 つ選ぶ。
 *
 * 行そのものは履歴検索 (pickaxe) には有効だが、会話の地の文に一字一句そのまま出てくることは稀。
 * そこで完全一致が空振りしたときの再検索用に、行の中で最も特徴的な識別子を取り出す。
 */

/** どの言語にも大量にあり、検索語として役に立たない語。 */
const STOPWORDS = new Set([
  'const', 'let', 'var', 'function', 'return', 'import', 'export', 'from', 'default',
  'class', 'interface', 'type', 'enum', 'extends', 'implements', 'public', 'private',
  'protected', 'static', 'readonly', 'async', 'await', 'new', 'this', 'super', 'null',
  'undefined', 'true', 'false', 'void', 'string', 'number', 'boolean', 'object', 'any',
  'if', 'else', 'for', 'while', 'switch', 'case', 'break', 'continue', 'throw', 'try',
  'catch', 'finally', 'def', 'self', 'None', 'True', 'False', 'elif', 'pass', 'lambda',
  'func', 'struct', 'impl', 'pub', 'fn', 'mut', 'use', 'mod', 'end', 'do', 'then',
  'and', 'or', 'not', 'in', 'is', 'as', 'with', 'print', 'console', 'log',
]);

/**
 * 識別子っぽい語と、日本語の内容語を拾う。
 *
 * 日本語は形態素解析なしでは単語に切れないが、漢字列とカタカナ列だけを取れば
 * 内容語にだいたい一致する。ひらがなは助詞・活用語尾がほとんどなので対象外にする
 * (混ぜると「この値は合言葉の有効期限」が丸ごと 1 語になってしまい、検索語として使えない)。
 */
const TOKEN = /[A-Za-z_$][A-Za-z0-9_$]{2,}|[一-龠々]{2,}|[ァ-ヴー]{2,}/gu;

/**
 * 特徴語を返す。適当な語が無ければ undefined。
 * 選定基準は「長い」「大文字小文字が混ざっている(=固有の命名)」「記号を含む」ほど高スコア。
 */
export function extractSymbol(line: string): string | undefined {
  const candidates = line.match(TOKEN);
  if (!candidates) {
    return undefined;
  }

  let best: string | undefined;
  let bestScore = -1;
  for (const raw of candidates) {
    if (STOPWORDS.has(raw) || STOPWORDS.has(raw.toLowerCase())) {
      continue;
    }
    const score = scoreOf(raw);
    if (score > bestScore) {
      bestScore = score;
      best = raw;
    }
  }
  return best;
}

function scoreOf(token: string): number {
  let score = token.length;
  // camelCase / PascalCase / snake_case は、その場限りの語より固有名詞である可能性が高い。
  if (/[a-z]/.test(token) && /[A-Z]/.test(token)) {
    score += 6;
  }
  if (token.includes('_') || token.includes('$')) {
    score += 4;
  }
  // 日本語の語はドキュメント由来の用語であることが多く、会話にも出やすい。
  if (/[ァ-ヴー一-龠々]/.test(token)) {
    score += 8;
  }
  return score;
}
