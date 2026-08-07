import * as vscode from 'vscode';
import {
  type ChatEntry,
  listTranscripts,
  loadTranscript,
  type TranscriptFile,
  transcriptRoot,
  transcriptsForWorkspace,
} from '../chat/transcriptStore';
import { log } from '../log';
import type { ChatBlockFilter, HitOrigin, HitSink, SearchHit, SearchOptions } from '../types';
import { buildJsRegex, clampLine, findMatches } from '../util/pattern';

export interface ChatScope {
  allProjects: boolean;
  blocks: ChatBlockFilter;
  /** 現在のワークスペースの絶対パス。プロジェクト絞り込みに使う。 */
  workspacePath?: string;
}

function wanted(block: string, filter: ChatBlockFilter): boolean {
  switch (block) {
    case 'text':
      return filter.text;
    case 'thinking':
      return filter.thinking;
    case 'tool_use':
      return filter.toolUse;
    case 'tool_result':
      return filter.toolResult;
    default:
      return false;
  }
}

/** 検索対象の transcript を決める。戻り値が空なら該当なし。 */
export function selectTranscripts(scope: ChatScope, all: TranscriptFile[]): TranscriptFile[] {
  if (scope.allProjects) {
    return all;
  }
  return transcriptsForWorkspace(scope.workspacePath, all);
}

/**
 * Claude Code の会話ログを検索する。
 * 「なぜその実装になったのか」がコミットにもファイルにも残っていないときの最後の手がかり。
 */
export async function searchChat(
  scope: ChatScope,
  opts: SearchOptions,
  sink: HitSink,
  token: vscode.CancellationToken,
  nextId: () => number,
): Promise<void> {
  const re = buildJsRegex(opts);
  if (!re) {
    sink.error('正規表現が不正です。');
    return;
  }

  const all = listTranscripts();
  if (all.length === 0) {
    sink.error(`Claude Code の会話ログが見つかりません (${transcriptRoot()})。`);
    return;
  }
  const targets = selectTranscripts(scope, all);
  if (targets.length === 0) {
    sink.warn('このワークスペースに対応する会話ログがありません。「全プロジェクト」に切り替えると横断検索できます。');
    return;
  }

  const includeToolResult = scope.blocks.toolResult;
  log.debug(`会話ログ検索: ${targets.length} ファイル (tool_result=${includeToolResult})`);

  let sinkWantsMore = true;
  for (const file of targets) {
    if (token.isCancellationRequested || !sinkWantsMore) {
      return;
    }
    let entries: ChatEntry[];
    try {
      entries = await loadTranscript(file, includeToolResult);
    } catch (err) {
      sink.warn(`${file.project}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    const hits: SearchHit[] = [];
    for (const entry of entries) {
      if (!wanted(entry.block, scope.blocks)) {
        continue;
      }
      const lines = entry.text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const raw = lines[i].endsWith('\r') ? lines[i].slice(0, -1) : lines[i];
        const matches = findMatches(re, raw);
        if (matches.length === 0) {
          continue;
        }
        const clamped = clampLine(raw, matches);
        const origin: HitOrigin = {
          kind: 'chat',
          project: file.project,
          cwd: entry.cwd,
          gitBranch: entry.gitBranch,
          sessionId: entry.sessionId,
          sessionFile: file.file,
          uuid: entry.uuid,
          entryIndex: entry.index,
          withToolResults: includeToolResult,
          role: entry.role,
          block: entry.block,
          tool: entry.tool,
          date: entry.timestamp,
          isSidechain: entry.isSidechain,
        };
        hits.push({
          id: nextId(),
          ref: null,
          // 会話ビューア上の見出しになる。セッション単位でまとまるようにする。
          file: file.file,
          line: i + 1,
          col: matches[0][0] + 1,
          len: matches[0][1],
          text: clamped.text,
          matches: clamped.matches,
          origin,
        });
      }
    }
    if (hits.length > 0) {
      sinkWantsMore = sink.push(hits);
    }
  }
}
