import * as vscode from 'vscode';
import { getConfig } from '../config';
import type { SearchOptions } from '../types';
import { buildJsRegex } from '../util/pattern';

const MAX_DECORATIONS_PER_EDITOR = 3000;
/** ジャンプ直後に行を光らせておく時間 (ms)。 */
const FLASH_MS = 700;

/**
 * 開いているエディタ内の一致をハイライトする。
 *
 * 下から順に重ねる。役割を分けないと、行の目印が一致そのものを飲み込んでしまう。
 *  1. all         — 同じ語の他の一致 (控えめ)
 *  2. currentLine — 飛んだ「行」。無彩色の薄い地 + 行頭の帯 + gutter の ▶
 *  3. flash       — 飛んだ直後だけ行を光らせる (700ms)
 *  4. current     — 飛んだ「一致そのもの」。不透明に塗り潰して文字色まで変える
 */
export class MatchHighlighter implements vscode.Disposable {
  /** 同じ語の他の一致 (控えめ)。 */
  private readonly all: vscode.TextEditorDecorationType;
  /** 飛んだ直後だけ行を光らせる。 */
  private readonly flash: vscode.TextEditorDecorationType;
  /** 一致が幅ゼロでも (会話ログの行マッピングが外れたとき) 必ず見える行全体の目印。 */
  private readonly currentLine: vscode.TextEditorDecorationType;
  /** ピンポイントの目印。一致した文字だけを蛍光ペンのように塗り潰す。 */
  private readonly current: vscode.TextEditorDecorationType;

  private regex: RegExp | undefined;
  private enabled = true;
  private currentRange: { uriKey: string; range: vscode.Range } | undefined;
  private flashRange: { uriKey: string; range: vscode.Range } | undefined;
  private flashTimer: NodeJS.Timeout | undefined;
  private refreshTimer: NodeJS.Timeout | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(extensionUri: vscode.Uri) {
    // 生成順がそのまま重ね順になる (後から作ったものが上)。
    // 行全体の背景がピンポイントの目印を上塗りしないよう、current を最後に作る。
    this.all = vscode.window.createTextEditorDecorationType({
      backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
      borderColor: new vscode.ThemeColor('editor.findMatchHighlightBorder'),
      borderStyle: 'solid',
      borderWidth: '1px',
      overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.findMatchForeground'),
      overviewRulerLane: vscode.OverviewRulerLane.Center,
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    });

    this.currentLine = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor('blitzgrep.currentLineBackground'),
      borderColor: new vscode.ThemeColor('blitzgrep.currentMatchBorder'),
      borderStyle: 'solid',
      borderWidth: '0 0 0 2px',
      gutterIconPath: vscode.Uri.joinPath(extensionUri, 'media', 'current-line.svg'),
      gutterIconSize: 'contain',
      overviewRulerColor: new vscode.ThemeColor('blitzgrep.currentMatchBorder'),
      overviewRulerLane: vscode.OverviewRulerLane.Full,
    });

    this.flash = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor('blitzgrep.flashBackground'),
    });

    // 背景を半透明にすると行全体の目印と同じ色味に沈むので、ここだけは不透明にして
    // 文字色まで指定する。行が「どこか」を示し、これが「どこの何か」を示す役割分担。
    this.current = vscode.window.createTextEditorDecorationType({
      backgroundColor: new vscode.ThemeColor('blitzgrep.currentMatchBackground'),
      color: new vscode.ThemeColor('blitzgrep.currentMatchForeground'),
      borderColor: new vscode.ThemeColor('blitzgrep.currentMatchBorder'),
      borderStyle: 'solid',
      borderWidth: '1px',
      borderRadius: '3px',
      overviewRulerColor: new vscode.ThemeColor('blitzgrep.currentMatchBorder'),
      overviewRulerLane: vscode.OverviewRulerLane.Full,
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    });

    this.disposables.push(
      vscode.window.onDidChangeVisibleTextEditors(() => this.scheduleRefresh(0)),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (vscode.window.visibleTextEditors.some((ed) => ed.document === e.document)) {
          this.scheduleRefresh(200);
        }
      }),
    );
  }

  setQuery(opts: Pick<SearchOptions, 'query' | 'isRegex' | 'isCaseSensitive' | 'matchWholeWord'> | undefined): void {
    this.regex = opts && opts.query ? buildJsRegex(opts) : undefined;
    this.currentRange = undefined;
    this.stopFlash();
    this.scheduleRefresh(0);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.scheduleRefresh(0);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setCurrent(editor: vscode.TextEditor, range: vscode.Range): void {
    const uriKey = editor.document.uri.toString();
    this.currentRange = { uriKey, range };
    this.startFlash(uriKey, range);
    this.refresh();
  }

  clearCurrent(): void {
    this.currentRange = undefined;
    this.stopFlash();
    this.refresh();
  }

  /** 飛んだ直後だけ行を強く光らせ、少ししたら通常の目印に戻す。 */
  private startFlash(uriKey: string, range: vscode.Range): void {
    this.stopFlash();
    if (!getConfig().flashOnJump) {
      return;
    }
    this.flashRange = { uriKey, range };
    this.flashTimer = setTimeout(() => {
      this.flashTimer = undefined;
      this.flashRange = undefined;
      this.refresh();
    }, FLASH_MS);
  }

  private stopFlash(): void {
    if (this.flashTimer) {
      clearTimeout(this.flashTimer);
      this.flashTimer = undefined;
    }
    this.flashRange = undefined;
  }

  private scheduleRefresh(delayMs: number): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      this.refresh();
    }, delayMs);
  }

  refresh(): void {
    const cfg = getConfig();
    // 「他の一致」と「いま飛んだ行」は別の関心事なので、設定も別に効かせる。
    const showAll = this.enabled && cfg.highlightInEditor && this.regex !== undefined;
    const showCurrent = this.enabled && cfg.highlightCurrentLine;

    for (const editor of vscode.window.visibleTextEditors) {
      const key = editor.document.uri.toString();
      const cur = showCurrent && this.currentRange?.uriKey === key ? this.currentRange.range : undefined;
      const ranges = showAll ? this.computeRanges(editor.document, this.regex!) : [];

      editor.setDecorations(this.all, cur ? ranges.filter((r) => !r.isEqual(cur)) : ranges);
      // 幅ゼロの範囲に枠を出しても見えないので、そこは行全体の目印だけに任せる。
      editor.setDecorations(this.current, cur && !cur.isEmpty ? [cur] : []);
      editor.setDecorations(this.currentLine, cur ? [lineSpan(cur)] : []);

      const flashing = showCurrent && this.flashRange?.uriKey === key ? this.flashRange.range : undefined;
      editor.setDecorations(this.flash, flashing ? [lineSpan(flashing)] : []);
    }
  }

  private computeRanges(doc: vscode.TextDocument, re: RegExp): vscode.Range[] {
    // 巨大ファイルで固まらないように上限を設ける。
    if (doc.lineCount > 200000) {
      return [];
    }
    const ranges: vscode.Range[] = [];
    const text = doc.getText();
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length > 0) {
        ranges.push(new vscode.Range(doc.positionAt(m.index), doc.positionAt(m.index + m[0].length)));
        if (ranges.length >= MAX_DECORATIONS_PER_EDITOR) {
          break;
        }
      }
      if (m.index === re.lastIndex) {
        re.lastIndex++;
      }
    }
    return ranges;
  }

  dispose(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.stopFlash();
    this.all.dispose();
    this.current.dispose();
    this.currentLine.dispose();
    this.flash.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

/** isWholeLine の装飾に渡す、行だけを指す範囲。 */
function lineSpan(range: vscode.Range): vscode.Range {
  return new vscode.Range(range.start.line, 0, range.end.line, 0);
}
