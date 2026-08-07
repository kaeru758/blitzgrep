import * as vscode from 'vscode';
import { chatTargetLine, chatUri } from '../chat/chatDocument';
import { getConfig } from '../config';
import { errorMessage, log } from '../log';
import { fileUri } from '../repoContext';
import type { RepoContext, SearchHit } from '../types';
import { blobUri } from './blobProvider';
import type { MatchHighlighter } from './decorations';

export interface OpenRequest {
  hit: SearchHit;
  preview: boolean;
  focus: boolean;
}

/** 検索結果のフラットな並びを保持し、開く・次へ・前へ を担う。 */
export class ResultNavigator implements vscode.Disposable {
  private hits: SearchHit[] = [];
  private ctx: RepoContext | undefined;
  private index = -1;
  private readonly indexChanged = new vscode.EventEmitter<number>();
  readonly onDidChangeIndex = this.indexChanged.event;

  constructor(private readonly highlighter: MatchHighlighter) {}

  get count(): number {
    return this.hits.length;
  }

  get currentIndex(): number {
    return this.index;
  }

  allHits(): readonly SearchHit[] {
    return this.hits;
  }

  reset(ctx: RepoContext): void {
    this.hits = [];
    this.ctx = ctx;
    this.index = -1;
    void vscode.commands.executeCommand('setContext', 'blitzGrep.hasResults', false);
  }

  append(hits: SearchHit[]): void {
    this.hits.push(...hits);
    if (this.hits.length > 0) {
      void vscode.commands.executeCommand('setContext', 'blitzGrep.hasResults', true);
    }
  }

  clear(): void {
    this.hits = [];
    this.index = -1;
    this.highlighter.clearCurrent();
    void vscode.commands.executeCommand('setContext', 'blitzGrep.hasResults', false);
  }

  findIndexById(id: number): number {
    return this.hits.findIndex((h) => h.id === id);
  }

  async openById(id: number, preview: boolean, focus: boolean): Promise<void> {
    const i = this.findIndexById(id);
    if (i < 0) {
      return;
    }
    this.index = i;
    this.indexChanged.fire(i);
    await this.openAt(i, preview, focus);
  }

  async next(): Promise<void> {
    await this.step(1);
  }

  async prev(): Promise<void> {
    await this.step(-1);
  }

  private async step(delta: number): Promise<void> {
    if (this.hits.length === 0) {
      return;
    }
    this.index = (this.index + delta + this.hits.length) % this.hits.length;
    this.indexChanged.fire(this.index);
    // F4 での移動中はフォーカスを動かさない (検索ボックスに留まれるようにする)。
    await this.openAt(this.index, true, false);
  }

  private async openAt(index: number, preview: boolean, focus: boolean): Promise<void> {
    const hit = this.hits[index];
    const ctx = this.ctx;
    if (!hit || !ctx) {
      return;
    }
    const uri = this.uriFor(ctx, hit);
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc, {
        preview: preview && getConfig().openPreview,
        preserveFocus: !focus,
        viewColumn: vscode.ViewColumn.Active,
      });
      const range = this.rangeFor(doc, hit);
      editor.selection = new vscode.Selection(range.start, range.end);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      this.highlighter.setCurrent(editor, range);
    } catch (err) {
      log.error(`結果を開けませんでした (${hit.ref ?? 'worktree'}:${hit.file}): ${errorMessage(err)}`);
      void vscode.window.showErrorMessage(`BlitzGrep: ${hit.file} を開けませんでした — ${errorMessage(err)}`);
    }
  }

  /** ヒットの種類に応じて、開くべきドキュメントの URI を決める。 */
  private uriFor(ctx: RepoContext, hit: SearchHit): vscode.Uri {
    if (hit.origin?.kind === 'chat') {
      // hit.file は transcript の絶対パス。読める Markdown に組み立て直して開く。
      // 通し番号を振ったときと同じ並びで組み立てないと、番号がズレて別の場所へ飛ぶ。
      return chatUri(hit.origin.sessionFile, hit.origin.entryIndex, hit.origin.withToolResults);
    }
    // コミットのヒットは ref に SHA (削除行なら SHA^) が入っているので、そのまま blob として開ける。
    return hit.ref === null ? fileUri(ctx, hit.file) : blobUri(ctx, hit.ref, hit.file);
  }

  /** ヒットの行・桁からエディタ上の範囲を作る。ファイルが変わっていても壊れないよう検証する。 */
  private rangeFor(doc: vscode.TextDocument, hit: SearchHit): vscode.Range {
    if (hit.origin?.kind === 'chat') {
      return this.chatRange(doc, hit);
    }
    const line = Math.min(Math.max(hit.line - 1, 0), Math.max(doc.lineCount - 1, 0));
    const lineLength = doc.lineAt(line).text.length;
    const start = Math.min(Math.max(hit.col - 1, 0), lineLength);
    const end = Math.min(start + Math.max(hit.len, 0), lineLength);
    return doc.validateRange(new vscode.Range(line, start, line, end));
  }

  /**
   * 会話ログは元の transcript ではなく組み立て直した Markdown を開くので、行番号を写像する。
   *
   * 写像は 3 段構えにする。狙いは「検索語が実際にある行」に必ず着地させること。
   * 発言の位置を取り違えたまま文書の先頭を光らせるのが、いちばん分かりにくい外し方なので。
   */
  private chatRange(doc: vscode.TextDocument, hit: SearchHit): vscode.Range {
    const origin = hit.origin as Extract<NonNullable<SearchHit['origin']>, { kind: 'chat' }>;
    const start = hit.matches[0]?.[0] ?? 0;
    const needle = hit.text.slice(start, start + (hit.matches[0]?.[1] ?? 0));
    const guess = chatTargetLine(doc.getText(), origin.entryIndex, origin.block, hit.line);

    // 1. 予想した行の近く。整形の都合で数行ずれることがある。
    const near = guess >= 0 ? findNeedle(doc, needle, guess, 40) : undefined;
    if (near) {
      return near;
    }
    // 2. 近くに無ければ文書全体から、予想に近い順に探す。
    const anywhere = findNeedle(doc, needle, Math.max(guess, 0), doc.lineCount);
    if (anywhere) {
      return anywhere;
    }
    // 3. 検索語が見当たらない (切り詰められた行など)。せめて発言の先頭へ。
    if (guess < 0) {
      log.warn(`会話ログ内の位置を特定できませんでした (発言 ${origin.entryIndex} / ${origin.sessionFile})`);
      void vscode.window.setStatusBarMessage('BlitzGrep: 会話の中の該当箇所を特定できませんでした', 3000);
    }
    const safe = Math.min(Math.max(guess, 0), Math.max(doc.lineCount - 1, 0));
    return doc.validateRange(new vscode.Range(safe, 0, safe, 0));
  }

  dispose(): void {
    this.indexChanged.dispose();
  }
}

/** center から外へ広げながら、needle を含む行を探す。近い候補を優先する。 */
function findNeedle(
  doc: vscode.TextDocument,
  needle: string,
  center: number,
  radius: number,
): vscode.Range | undefined {
  if (!needle) {
    return undefined;
  }
  for (let delta = 0; delta <= radius; delta++) {
    for (const line of delta === 0 ? [center] : [center + delta, center - delta]) {
      if (line < 0 || line >= doc.lineCount) {
        continue;
      }
      const col = doc.lineAt(line).text.indexOf(needle);
      if (col >= 0) {
        return doc.validateRange(new vscode.Range(line, col, line, col + needle.length));
      }
    }
  }
  return undefined;
}
