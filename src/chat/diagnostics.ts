import * as fs from 'node:fs';
import * as readline from 'node:readline';
import { listTranscripts, transcriptRoot } from './transcriptStore';

/**
 * 会話ログの形式は Claude Code の内部仕様で、公開された契約ではない。
 * 変わったときに「一致はありません」としか出ないのが最悪なので、
 * 何を読んで何を取り出せたかを数えて、黙って壊れない状態にする。
 */

/** 診断のコスト上限。全部読むと数百 MB になるので、新しいものから標本を取る。 */
const MAX_FILES = 20;
const MAX_RECORDS_PER_FILE = 2000;

/** 取り出し対象として実装しているブロック種別。 */
const KNOWN_BLOCKS = new Set(['text', 'thinking', 'tool_use', 'tool_result']);
/**
 * user / assistant 以外の正規のレコード種別。「読めない」のではなく「読む必要がない」もの。
 *
 * 実物の transcript (Claude Code 2.1.x) を走査して確認した一覧。ここに載せておかないと
 * 診断の「その他の種別」が正常な種別で埋まり、本当に新しいものが現れても気付けない。
 *  - last-prompt        : 直前のプロンプトの控え。user 発言と重複するので取ると二重に出る
 *  - attachment         : ツール定義の差分などのメタデータ。会話本文ではない
 *  - ai-title           : 自動生成されたセッション名
 *  - file-history-*     : ファイル変更の記録。内容は tool_use 側にある
 *  - queue-operation    : 入力キューの操作ログ
 *  - mode               : モード切り替えの記録
 */
const IGNORABLE_RECORD_TYPES = new Set([
  'summary',
  'system',
  'last-prompt',
  'attachment',
  'ai-title',
  'file-history-snapshot',
  'file-history-delta',
  'queue-operation',
  'mode',
]);

export interface RecordAnalysis {
  records: number;
  /** JSON として解釈できなかった行。 */
  jsonErrors: number;
  /** type が user / assistant で message を持つレコード。 */
  conversational: number;
  /** 取り出せたブロック数。種別ごと。 */
  blocks: Record<string, number>;
  /** 実装が知らない content ブロックの種別と件数。形式変化の一次シグナル。 */
  unknownBlocks: Record<string, number>;
  /** user / assistant 以外のレコード種別と件数。 */
  otherRecordTypes: Record<string, number>;
}

export type Verdict =
  | { level: 'ok'; message: string }
  | { level: 'info'; message: string }
  | { level: 'warn'; message: string }
  | { level: 'error'; message: string };

export interface ChatDiagnosis {
  root: string;
  rootExists: boolean;
  files: number;
  scannedFiles: number;
  newestIso: string;
  oldestIso: string;
  analysis: RecordAnalysis;
  verdicts: Verdict[];
}

function bump(counter: Record<string, number>, key: string): void {
  counter[key] = (counter[key] ?? 0) + 1;
}

/**
 * 生のレコード列を数える。ファイル入出力から切り離してあるのでテストできる。
 * `extractEntries` と対で保守すること — あちらが増えたらここの KNOWN_BLOCKS も増やす。
 */
export function analyzeRecords(lines: string[], into?: RecordAnalysis): RecordAnalysis {
  const a: RecordAnalysis = into ?? {
    records: 0,
    jsonErrors: 0,
    conversational: 0,
    blocks: {},
    unknownBlocks: {},
    otherRecordTypes: {},
  };

  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    a.records++;
    let record: { type?: unknown; message?: { content?: unknown } };
    try {
      record = JSON.parse(line);
    } catch {
      a.jsonErrors++;
      continue;
    }
    const type = typeof record?.type === 'string' ? record.type : '(type なし)';
    if (type !== 'user' && type !== 'assistant') {
      bump(a.otherRecordTypes, type);
      continue;
    }
    const content = record.message?.content;
    if (content === undefined) {
      bump(a.otherRecordTypes, `${type} (message.content なし)`);
      continue;
    }
    a.conversational++;
    if (typeof content === 'string') {
      bump(a.blocks, 'text');
      continue;
    }
    if (!Array.isArray(content)) {
      bump(a.unknownBlocks, `content が ${typeof content}`);
      continue;
    }
    for (const block of content) {
      const kind = block && typeof block === 'object' && typeof block.type === 'string' ? block.type : '(type なし)';
      if (KNOWN_BLOCKS.has(kind)) {
        bump(a.blocks, kind);
      } else {
        bump(a.unknownBlocks, kind);
      }
    }
  }
  return a;
}

/** 数えた結果から「で、壊れているのか」を言い切る。 */
export function judge(d: Omit<ChatDiagnosis, 'verdicts'>): Verdict[] {
  const out: Verdict[] = [];
  const a = d.analysis;
  const totalBlocks = Object.values(a.blocks).reduce((s, n) => s + n, 0);

  if (!d.rootExists) {
    out.push({
      level: 'error',
      message: `会話ログの保存先がありません: ${d.root}\nClaude Code を使っていないか、CLAUDE_CONFIG_DIR が別の場所を指しています。`,
    });
    return out;
  }
  if (d.files === 0) {
    out.push({ level: 'error', message: '保存先はありますが .jsonl が 1 本もありません。' });
    return out;
  }
  if (a.records === 0) {
    out.push({ level: 'error', message: 'ファイルはありますが、中身が空です。' });
    return out;
  }
  if (a.conversational === 0) {
    out.push({
      level: 'error',
      message:
        `${a.records} 件のレコードを読みましたが、発言レコード (type が user / assistant) が 1 件もありませんでした。\n` +
        '会話ログの形式が変わった可能性が高いです。この診断結果を添えて報告してください。',
    });
  } else if (totalBlocks === 0) {
    out.push({
      level: 'error',
      message:
        `発言レコードは ${a.conversational} 件ありますが、本文を 1 つも取り出せませんでした。\n` +
        'content の構造が変わった可能性が高いです。',
    });
  } else {
    out.push({
      level: 'ok',
      message: `${d.scannedFiles} 本 / ${a.records} レコードから ${totalBlocks} ブロックを取り出せました。正常です。`,
    });
  }

  const unknown = Object.entries(a.unknownBlocks).filter(([k]) => k !== 'image');
  if (unknown.length > 0) {
    out.push({
      level: 'warn',
      message:
        '知らないブロック種別があります (検索対象外になっています):\n' +
        unknown.map(([k, n]) => `  ${k} — ${n} 件`).join('\n'),
    });
  }
  const surprising = Object.entries(a.otherRecordTypes).filter(([k]) => !IGNORABLE_RECORD_TYPES.has(k));
  if (surprising.length > 0) {
    out.push({
      level: 'info',
      message:
        '発言以外のレコード種別 (読み飛ばしています):\n' + surprising.map(([k, n]) => `  ${k} — ${n} 件`).join('\n'),
    });
  }
  if (a.jsonErrors > 0) {
    out.push({ level: 'warn', message: `JSON として読めなかった行が ${a.jsonErrors} 件ありました。` });
  }
  return out;
}

/** 新しい transcript から標本を取って診断する。 */
export async function diagnoseChatLogs(): Promise<ChatDiagnosis> {
  const root = transcriptRoot();
  const rootExists = fs.existsSync(root);
  const all = rootExists ? listTranscripts() : [];
  const sample = all.slice(0, MAX_FILES);

  const analysis = analyzeRecords([]);
  for (const file of sample) {
    try {
      const rl = readline.createInterface({
        input: fs.createReadStream(file.file, { encoding: 'utf8' }),
        crlfDelay: Infinity,
      });
      const lines: string[] = [];
      for await (const raw of rl) {
        lines.push(raw);
        if (lines.length >= MAX_RECORDS_PER_FILE) {
          break;
        }
      }
      rl.close();
      analyzeRecords(lines, analysis);
    } catch {
      // 読めないファイルは件数に出ないだけで、診断そのものは続ける。
    }
  }

  const times = all.map((f) => f.mtimeMs);
  const base = {
    root,
    rootExists,
    files: all.length,
    scannedFiles: sample.length,
    newestIso: times.length > 0 ? new Date(Math.max(...times)).toISOString() : '—',
    oldestIso: times.length > 0 ? new Date(Math.min(...times)).toISOString() : '—',
    analysis,
  };
  return { ...base, verdicts: judge(base) };
}

/** 出力チャネルにそのまま貼れる報告文にする。 */
export function formatDiagnosis(d: ChatDiagnosis): string {
  const a = d.analysis;
  const lines: string[] = [];
  const mark = { ok: '✓', info: 'i', warn: '!', error: '✗' };

  lines.push('===== BlitzGrep 会話ログ診断 =====');
  for (const v of d.verdicts) {
    lines.push(`[${mark[v.level]}] ${v.message}`);
  }
  lines.push('');
  lines.push(`保存先        : ${d.root}`);
  lines.push(`transcript    : ${d.files} 本 (うち ${d.scannedFiles} 本を標本として読みました)`);
  lines.push(`最終更新      : ${d.newestIso}`);
  lines.push(`最古の更新    : ${d.oldestIso}`);
  lines.push(`レコード      : ${a.records} (JSON エラー ${a.jsonErrors})`);
  lines.push(`発言レコード  : ${a.conversational}`);
  lines.push(`ブロック内訳  : ${format(a.blocks)}`);
  lines.push(`未知ブロック  : ${format(a.unknownBlocks)}`);
  lines.push(`その他の種別  : ${format(a.otherRecordTypes)}`);
  lines.push('');
  lines.push('会話ログは既定 30 日で自動削除されます (Claude Code の cleanupPeriodDays)。');
  lines.push('=================================');
  return lines.join('\n');
}

function format(counter: Record<string, number>): string {
  const entries = Object.entries(counter).sort((a, b) => b[1] - a[1]);
  return entries.length === 0 ? '(なし)' : entries.map(([k, n]) => `${k}=${n}`).join(', ');
}
