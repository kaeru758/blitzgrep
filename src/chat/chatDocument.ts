import * as path from 'node:path';
import * as vscode from 'vscode';
import { errorMessage } from '../log';
import { type ChatEntry, loadSession } from './transcriptStore';

export const CHAT_SCHEME = 'blitzgrep-chat';

interface ChatDocRef {
  sessionFile: string;
  /** ここに印を付けたい発言のセッション内通し番号。 */
  entryIndex: number;
  includeToolResult: boolean;
}

/**
 * 会話ログを読める Markdown として開くための URI。
 * 拡張子を .md にしておくと VS Code が Markdown として色付けし、プレビューも開ける。
 */
export function chatUri(sessionFile: string, entryIndex: number, includeToolResult: boolean): vscode.Uri {
  const name = path.basename(sessionFile, '.jsonl');
  const payload: ChatDocRef = { sessionFile, entryIndex, includeToolResult };
  return vscode.Uri.from({
    scheme: CHAT_SCHEME,
    path: `/${name}.md`,
    query: JSON.stringify(payload),
  });
}

function formatTimestamp(iso: string): string {
  if (!iso) {
    return '';
  }
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function speaker(entry: ChatEntry): string {
  const who = entry.role === 'user' ? '👤 あなた' : '🤖 Claude';
  const kind =
    entry.block === 'thinking'
      ? '（思考）'
      : entry.block === 'tool_use'
        ? `（ツール: ${entry.tool ?? '?'}）`
        : entry.block === 'tool_result'
          ? '（ツール結果）'
          : '';
  const side = entry.isSidechain ? ' ⑂サブエージェント' : '';
  return `${who}${kind}${side}`;
}

/** コードブロックの中身に ``` が含まれていても壊れないようフェンスを伸ばす。 */
function fence(text: string): string {
  let longest = 0;
  for (const m of text.matchAll(/`{3,}/g)) {
    longest = Math.max(longest, m[0].length);
  }
  return '`'.repeat(Math.max(3, longest + 1));
}

/**
 * transcript を、人が読める Markdown に組み立てる。
 * 発言 1 件につき必ず `## ` 見出しを 1 行出す。この不変条件を `chatTargetLine` が利用する。
 */
export function renderSession(entries: ChatEntry[], highlightIndex: number): string {
  const out: string[] = [];
  const first = entries[0];
  out.push(`# 会話ログ`);
  if (first) {
    out.push('');
    out.push(`- セッション: \`${first.sessionId}\``);
    if (first.cwd) {
      out.push(`- 作業ディレクトリ: \`${first.cwd}\``);
    }
    const branches = [...new Set(entries.map((e) => e.gitBranch).filter(Boolean))];
    if (branches.length > 0) {
      out.push(`- ブランチ: ${branches.map((b) => `\`${b}\``).join(', ')}`);
    }
    out.push(`- 期間: ${formatTimestamp(first.timestamp)} 〜 ${formatTimestamp(entries[entries.length - 1].timestamp)}`);
    out.push(`- 発言ブロック数: ${entries.length}`);
  }
  out.push('');

  for (const entry of entries) {
    const marker = entry.index === highlightIndex ? ' ⬅︎ **ここ**' : '';
    out.push(`## ${speaker(entry)} · ${formatTimestamp(entry.timestamp)}${marker}`);
    out.push('');
    if (entry.block === 'text') {
      out.push(entry.text);
    } else {
      const f = fence(entry.text);
      out.push(`${f}${entry.block === 'tool_use' ? 'json' : 'text'}`);
      out.push(entry.text);
      out.push(f);
    }
    out.push('');
  }
  return out.join('\n');
}

/**
 * 発言の見出し行かどうか。
 *
 * 本文にも Markdown の見出し (`## まとめ` など) は普通に現れるので、`## ` だけでは数を誤る。
 * `speaker()` が必ず話者マークから始めることを利用して、そこまで込みで形を固定する。
 */
const HEADING_RE = /^## (?:👤|🤖)/;

/**
 * 発言 N の本文 M 行目が、組み立てた Markdown の何行目 (0 始まり) になるかを求める。
 * renderSession が「発言 1 件 = 見出し 1 行」を守っているので、見出しを数えれば特定できる。
 *
 * 特定できなければ -1 を返す。0 (= `# 会話ログ` の行) を返すと、
 * 呼び出し側からは正しく飛べたのか失敗したのか区別が付かない。
 */
export function chatTargetLine(markdown: string, entryIndex: number, block: string, lineInBlock: number): number {
  const lines = markdown.split('\n');
  let seen = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!HEADING_RE.test(lines[i])) {
      continue;
    }
    seen++;
    if (seen !== entryIndex) {
      continue;
    }
    // 見出し / 空行 / (コードフェンス) / 本文…
    const bodyStart = i + 2 + (block === 'text' ? 0 : 1);
    return Math.min(bodyStart + Math.max(0, lineInBlock - 1), lines.length - 1);
  }
  return -1;
}

export class ChatContentProvider implements vscode.TextDocumentContentProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    let payload: ChatDocRef;
    try {
      payload = JSON.parse(uri.query) as ChatDocRef;
    } catch {
      return '<!-- BlitzGrep: URI が壊れています -->';
    }
    try {
      const entries = await loadSession(payload.sessionFile, payload.includeToolResult);
      if (entries.length === 0) {
        return `<!-- BlitzGrep: ${payload.sessionFile} から発言を取り出せませんでした -->`;
      }
      return renderSession(entries, payload.entryIndex);
    } catch (err) {
      return `<!-- BlitzGrep: 会話ログを読めませんでした\n${errorMessage(err)} -->`;
    }
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
