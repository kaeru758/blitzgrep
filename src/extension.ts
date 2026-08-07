import * as vscode from 'vscode';
import { CHAT_SCHEME, ChatContentProvider } from './chat/chatDocument';
import { clearTranscriptCache } from './chat/transcriptStore';
import { resetGitCaches } from './git/gitService';
import { initLog, log } from './log';
import { clearRepoContextCache } from './repoContext';
import { clearGitHubCache } from './search/githubProvider';
import { resetRipgrepCache } from './search/rgLocator';
import { BLOB_SCHEME, BlobContentProvider } from './ui/blobProvider';
import { MatchHighlighter } from './ui/decorations';
import { ResultNavigator } from './ui/navigator';
import { SearchViewProvider } from './ui/searchView';

export function activate(context: vscode.ExtensionContext): void {
  initLog();
  log.info('BlitzGrep を起動しました。');

  const highlighter = new MatchHighlighter(context.extensionUri);
  const navigator = new ResultNavigator(highlighter);
  const view = new SearchViewProvider(context.extensionUri, context.workspaceState, navigator, highlighter);
  const blobProvider = new BlobContentProvider();
  const chatProvider = new ChatContentProvider();

  context.subscriptions.push(
    highlighter,
    navigator,
    view,
    blobProvider,
    chatProvider,
    vscode.workspace.registerTextDocumentContentProvider(BLOB_SCHEME, blobProvider),
    vscode.workspace.registerTextDocumentContentProvider(CHAT_SCHEME, chatProvider),
    vscode.window.registerWebviewViewProvider(SearchViewProvider.viewType, view, {
      webviewOptions: { retainContextWhenHidden: true },
    }),

    vscode.commands.registerCommand('blitzgrep.focusSearch', () => view.focus()),
    vscode.commands.registerCommand('blitzgrep.traceOrigin', () => traceOrigin(view)),
    vscode.commands.registerCommand('blitzgrep.searchSelection', () => searchSelection(view, false)),
    vscode.commands.registerCommand('blitzgrep.searchSelectionAllBranches', () => searchSelection(view, true)),
    vscode.commands.registerCommand('blitzgrep.nextMatch', () => navigator.next()),
    vscode.commands.registerCommand('blitzgrep.prevMatch', () => navigator.prev()),
    vscode.commands.registerCommand('blitzgrep.refresh', () => view.rerun()),
    vscode.commands.registerCommand('blitzgrep.clear', () => view.clearResults()),
    vscode.commands.registerCommand('blitzgrep.refreshBranches', () => view.refreshBranches()),
    vscode.commands.registerCommand('blitzgrep.toggleHighlight', () => {
      const next = !highlighter.isEnabled();
      highlighter.setEnabled(next);
      void vscode.window.setStatusBarMessage(
        `BlitzGrep: エディタ内ハイライトを${next ? 'オン' : 'オフ'}にしました`,
        2000,
      );
    }),
    vscode.commands.registerCommand('blitzgrep.copyResults', async () => {
      const hits = navigator.allHits();
      if (hits.length === 0) {
        void vscode.window.showInformationMessage('BlitzGrep: コピーする結果がありません。');
        return;
      }
      const text = hits
        .map((h) => `${h.ref ? `${h.ref}:` : ''}${h.file}:${h.line}:${h.col}: ${h.text.trim()}`)
        .join('\n');
      await vscode.env.clipboard.writeText(text);
      void vscode.window.showInformationMessage(`BlitzGrep: ${hits.length} 件をコピーしました。`);
    }),

    vscode.commands.registerCommand('blitzgrep.clearCaches', () => {
      clearGitHubCache();
      clearTranscriptCache();
      resetGitCaches();
      clearRepoContextCache();
      void vscode.window.showInformationMessage('BlitzGrep: キャッシュを破棄しました。');
    }),

    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      clearRepoContextCache();
      resetGitCaches();
      clearGitHubCache();
      view.onFoldersChanged();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('blitzgrep.ripgrepPath')) {
        resetRipgrepCache();
      }
      if (
        e.affectsConfiguration('blitzgrep.highlightInEditor') ||
        e.affectsConfiguration('blitzgrep.highlightCurrentLine')
      ) {
        highlighter.refresh();
      }
    }),
  );
}

/**
 * 「この実装どこから来た?」— カーソル行 (または選択範囲) を起点に、
 * blame・履歴・会話ログをまとめて引く。
 */
async function traceOrigin(view: SearchViewProvider): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showInformationMessage('BlitzGrep: 出所を追う対象のエディタがありません。');
    return;
  }
  const selection = editor.selection;
  const line = selection.active.line;
  const text = selection.isEmpty
    ? editor.document.lineAt(line).text.trim()
    : editor.document.getText(selection).trim();

  if (!text) {
    void vscode.window.showInformationMessage('BlitzGrep: 空行からは出所を追えません。');
    return;
  }
  // 複数行を選んだ場合は最初の非空行だけを使う (pickaxe は 1 つの文字列しか扱えない)。
  const query = text.split('\n').map((l) => l.trim()).find(Boolean) ?? text;

  const anchor =
    editor.document.uri.scheme === 'file'
      ? { file: editor.document.uri.fsPath, line: line + 1 }
      : undefined;
  await view.traceOrigin(query, anchor);
}

async function searchSelection(view: SearchViewProvider, allBranches: boolean): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    await view.focus();
    return;
  }
  const selection = editor.selection;
  const text = selection.isEmpty
    ? editor.document.getText(editor.document.getWordRangeAtPosition(selection.active))
    : editor.document.getText(selection);
  if (!text || text.includes('\n')) {
    await view.focus();
    return;
  }
  await view.searchText(text, allBranches);
}

export function deactivate(): void {
  // 破棄は context.subscriptions に任せる。
}
