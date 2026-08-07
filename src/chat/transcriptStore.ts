import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { errorMessage, log } from '../log';

/** 検索対象として取り出した 1 発言 (1 ブロック)。 */
export interface ChatEntry {
  uuid: string;
  parentUuid: string;
  sessionId: string;
  /** ISO8601 */
  timestamp: string;
  role: 'user' | 'assistant';
  /** text | thinking | tool_use | tool_result */
  block: string;
  /** tool_use のときのツール名。 */
  tool?: string;
  cwd: string;
  gitBranch: string;
  isSidechain: boolean;
  /** 検索・表示対象のプレーンテキスト。 */
  text: string;
  /** transcript ファイル内での行番号 (1 始まり)。 */
  recordLine: number;
  /** セッション内での通し番号。会話ビューア上の位置を一意に決めるのに使う。 */
  index: number;
}

export interface TranscriptFile {
  /** ~/.claude/projects 直下のディレクトリ名 (プロジェクト識別子)。 */
  project: string;
  /** .jsonl の絶対パス。 */
  file: string;
  sizeBytes: number;
  mtimeMs: number;
}

/** transcript の保存場所。CLAUDE_CONFIG_DIR で移動できる。 */
export function transcriptRoot(): string {
  const configured = process.env.CLAUDE_CONFIG_DIR;
  const base = configured && configured.trim() ? configured : path.join(os.homedir(), '.claude');
  return path.join(base, 'projects');
}

/**
 * ワークスペースの絶対パスを、~/.claude/projects 配下のディレクトリ名の規則に合わせて符号化する。
 *
 * Claude Code は **英数字以外をすべて** "-" に潰す。区切り文字だけではない:
 *   "OneDrive - TeamRK1992" -> "OneDrive---TeamRK1992"   (空白も - になる)
 *   "md-visual-editor_debug" -> "md-visual-editor-debug" (_ も - になる)
 *   "Vtuber運用計画"          -> "Vtuber----"             (非 ASCII は 1 文字 1 個)
 * 区切り文字だけを置換していた頃は、空白を含むパス (Windows では珍しくない) が
 * ことごとく照合できず、「このプロジェクトの会話が無い」ように見えていた。
 */
export function encodeProjectDir(fsPath: string): string {
  return fsPath.replace(/[^a-zA-Z0-9]/g, '-');
}

/** encoded が親、name が子 (またはそれ自身) の関係か。境界を見て "demo" と "demo2" を混同しない。 */
function isSameOrUnder(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}-`);
}

/**
 * transcript を列挙する。
 * プロジェクトディレクトリの直下だけでなく、セッション UUID のサブディレクトリ配下にも
 * サブエージェントの会話が置かれるので再帰する (深さは念のため制限する)。
 */
export function listTranscripts(): TranscriptFile[] {
  const root = transcriptRoot();
  let dirs: fs.Dirent[];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: TranscriptFile[] = [];
  for (const dir of dirs) {
    if (dir.isDirectory()) {
      collect(path.join(root, dir.name), dir.name, 3, out);
    }
  }
  // 新しいセッションから見たいので降順。
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

function collect(dir: string, project: string, depth: number, out: TranscriptFile[]): void {
  if (depth < 0) {
    return;
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collect(full, project, depth - 1, out);
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      try {
        const st = fs.statSync(full);
        out.push({ project, file: full, sizeBytes: st.size, mtimeMs: st.mtimeMs });
      } catch {
        // 読めないものは飛ばす
      }
    }
  }
}

/**
 * ワークスペースに対応する transcript を選ぶ。
 *
 * まず完全一致だけを見る。符号化が合っている限り、これが唯一の正解。
 * 空振りしたときだけ親子関係で拾い直す — 規則がまた変わっても全滅しないための保険で、
 * 平時にこれを混ぜると無関係なプロジェクトが紛れ込む。
 *
 * 一致が無ければ空を返す (呼び出し側が「全プロジェクト」に切り替えるかを決める)。
 * パスが分からないとき (仮想ワークスペースなど) も空。黙って全件に広げると、
 * 「このプロジェクトだけ」のつもりで他所の会話まで検索してしまう。
 */
export function transcriptsForWorkspace(fsPath: string | undefined, all: TranscriptFile[]): TranscriptFile[] {
  if (!fsPath) {
    return [];
  }
  const encoded = encodeProjectDir(fsPath).toLowerCase();
  const exact = all.filter((t) => t.project.toLowerCase() === encoded);
  if (exact.length > 0) {
    return exact;
  }
  return all.filter((t) => {
    const name = t.project.toLowerCase();
    return isSameOrUnder(encoded, name) || isSameOrUnder(name, encoded);
  });
}

// ---------------------------------------------------------------- 抽出

interface ContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
}

interface TranscriptRecord {
  type?: string;
  uuid?: string;
  parentUuid?: string;
  sessionId?: string;
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  isSidechain?: boolean;
  message?: { role?: string; content?: string | ContentBlock[] };
}

/** tool_result の content は文字列だったりブロック配列だったりする。 */
function flattenToolResult(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const c of content) {
      if (c && typeof c === 'object' && typeof (c as ContentBlock).text === 'string') {
        parts.push((c as ContentBlock).text as string);
      }
    }
    return parts.join('\n');
  }
  return '';
}

/**
 * 1 レコードから検索対象のブロックを取り出す。
 * tool_result は巨大 (1 行 1 MB 超もある) なので、必要なときだけ取り出す。
 */
export function extractEntries(
  record: TranscriptRecord,
  recordLine: number,
  includeToolResult: boolean,
): ChatEntry[] {
  const type = record.type;
  if (type !== 'user' && type !== 'assistant') {
    return [];
  }
  const message = record.message;
  if (!message) {
    return [];
  }
  const base = {
    uuid: record.uuid ?? '',
    parentUuid: record.parentUuid ?? '',
    sessionId: record.sessionId ?? '',
    timestamp: record.timestamp ?? '',
    cwd: record.cwd ?? '',
    gitBranch: record.gitBranch ?? '',
    isSidechain: record.isSidechain === true,
    role: type as 'user' | 'assistant',
    recordLine,
    // 通し番号は呼び出し側 (loadTranscript) が確定させる。
    index: -1,
  };

  if (typeof message.content === 'string') {
    return message.content.trim() ? [{ ...base, block: 'text', text: message.content }] : [];
  }
  if (!Array.isArray(message.content)) {
    return [];
  }

  const out: ChatEntry[] = [];
  for (const block of message.content) {
    if (!block || typeof block !== 'object') {
      continue;
    }
    switch (block.type) {
      case 'text':
        if (block.text?.trim()) {
          out.push({ ...base, block: 'text', text: block.text });
        }
        break;
      case 'thinking':
        if (block.thinking?.trim()) {
          out.push({ ...base, block: 'thinking', text: block.thinking });
        }
        break;
      case 'tool_use': {
        // Edit / Write の引数など「実際に書かれた内容」がここに入る。
        const text = block.input === undefined ? '' : safeStringify(block.input);
        if (text.trim()) {
          out.push({ ...base, block: 'tool_use', tool: block.name, text });
        }
        break;
      }
      case 'tool_result': {
        if (!includeToolResult) {
          break;
        }
        const text = flattenToolResult(block.content);
        if (text.trim()) {
          out.push({ ...base, block: 'tool_result', text });
        }
        break;
      }
      default:
        break;
    }
  }
  return out;
}

function safeStringify(value: unknown): string {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------- キャッシュ

interface CachedFile {
  mtimeMs: number;
  sizeBytes: number;
  entries: ChatEntry[];
  bytes: number;
}

/**
 * 抽出結果のキャッシュ。tool_result を含む結果はキャッシュしない (巨大なため)。
 *
 * 実測: 145 MB / 25 ファイルの全行 JSON.parse が約 460 ms、
 * 生の行に対する部分一致で足切りしても約 390 ms で差がほぼ無かった。
 * 行数自体は 1.3 万行しかなく、サイズは少数の巨大な tool_result が占めているため。
 * よって足切りはせず、素直に全部読んで抽出結果を保持する。
 */
const cache = new Map<string, CachedFile>();
let cachedBytes = 0;
const MAX_CACHE_BYTES = 64 * 1024 * 1024;

export function clearTranscriptCache(): void {
  cache.clear();
  cachedBytes = 0;
}

export function transcriptCacheStats(): { files: number; megabytes: number } {
  return { files: cache.size, megabytes: Math.round((cachedBytes / 1024 / 1024) * 10) / 10 };
}

/** 1 ファイルを解析して発言列を返す。mtime と size が変わっていなければキャッシュを使う。 */
export async function loadTranscript(file: TranscriptFile, includeToolResult: boolean): Promise<ChatEntry[]> {
  if (!includeToolResult) {
    const cached = cache.get(file.file);
    if (cached && cached.mtimeMs === file.mtimeMs && cached.sizeBytes === file.sizeBytes) {
      return cached.entries;
    }
  }

  const entries: ChatEntry[] = [];
  let bytes = 0;
  let lineNumber = 0;
  try {
    const rl = readline.createInterface({
      input: fs.createReadStream(file.file, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    for await (const raw of rl) {
      lineNumber++;
      if (!raw) {
        continue;
      }
      let record: TranscriptRecord;
      try {
        record = JSON.parse(raw) as TranscriptRecord;
      } catch {
        continue;
      }
      for (const entry of extractEntries(record, lineNumber, includeToolResult)) {
        entry.index = entries.length;
        entries.push(entry);
        bytes += entry.text.length * 2;
      }
    }
    rl.close();
  } catch (err) {
    log.warn(`transcript を読めませんでした ${file.file}: ${errorMessage(err)}`);
    return entries;
  }

  if (!includeToolResult) {
    evictIfNeeded(bytes);
    cache.set(file.file, { mtimeMs: file.mtimeMs, sizeBytes: file.sizeBytes, entries, bytes });
    cachedBytes += bytes;
  }
  return entries;
}

function evictIfNeeded(incoming: number): void {
  while (cachedBytes + incoming > MAX_CACHE_BYTES && cache.size > 0) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) {
      return;
    }
    cachedBytes -= cache.get(oldest)?.bytes ?? 0;
    cache.delete(oldest);
  }
}

/** セッション 1 本を全部読む。会話ビューアで使う。 */
export async function loadSession(file: string, includeToolResult: boolean): Promise<ChatEntry[]> {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch (err) {
    throw new Error(`transcript が見つかりません: ${errorMessage(err)}`);
  }
  return loadTranscript(
    { project: path.basename(path.dirname(file)), file, sizeBytes: st.size, mtimeMs: st.mtimeMs },
    includeToolResult,
  );
}
