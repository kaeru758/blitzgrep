import * as vscode from 'vscode';
import { listTranscripts } from '../chat/transcriptStore';
import { getConfig } from '../config';
import { listBranches } from '../git/gitService';
import { errorMessage, log } from '../log';
import { defaultFolder, resolveRepoContext, workspaceFolders } from '../repoContext';
import { selectTranscripts } from '../search/chatProvider';
import { SearchController } from '../search/controller';
import { listGitHubBranches } from '../search/githubProvider';
import type {
  BranchInfo,
  ChatBlockFilter,
  RepoContext,
  SearchHit,
  SearchOptions,
  SearchStage,
  SearchStats,
} from '../types';
import type { MatchHighlighter } from './decorations';
import type { ResultNavigator } from './navigator';

const STATE_KEY = 'blitzgrep.viewState.v2';

type ScopeMode = 'worktree' | 'branches' | 'history' | 'chat' | 'trace';

interface ViewState {
  query: string;
  isRegex: boolean;
  isCaseSensitive: boolean;
  matchWholeWord: boolean;
  include: string;
  exclude: string;
  scopeMode: ScopeMode;
  selectedBranches: string[];
  dedupe: boolean;
  showAdvanced: boolean;
  folderUri: string;
  /** 履歴検索: すべての ref を対象にする (--all)。 */
  historyAllRefs: boolean;
  /** 会話ログ検索: 現在のプロジェクト以外も対象にする。 */
  chatAllProjects: boolean;
  chatText: boolean;
  chatThinking: boolean;
  chatToolUse: boolean;
  chatToolResult: boolean;
}

const DEFAULT_STATE: ViewState = {
  query: '',
  isRegex: false,
  isCaseSensitive: false,
  matchWholeWord: false,
  include: '',
  exclude: '',
  scopeMode: 'worktree',
  selectedBranches: [],
  dedupe: true,
  showAdvanced: false,
  folderUri: '',
  historyAllRefs: true,
  chatAllProjects: false,
  chatText: true,
  chatThinking: true,
  chatToolUse: true,
  chatToolResult: false,
};

export class SearchViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewType = 'blitzgrep.searchView';

  private view?: vscode.WebviewView;
  private ready = false;
  private pending: unknown[] = [];
  private readyWaiters: Array<() => void> = [];
  private state: ViewState;
  private ctx?: RepoContext;
  private branches: BranchInfo[] = [];
  private branchesLoadedFor?: string;
  /** traceOrigin コマンドで起動したときの起点。手動で検索し直すときは現在のエディタを見る。 */
  private traceAnchor?: { file: string; line: number };
  private readonly controller: SearchController;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly memento: vscode.Memento,
    private readonly navigator: ResultNavigator,
    private readonly highlighter: MatchHighlighter,
  ) {
    this.state = { ...DEFAULT_STATE, ...(memento.get<Partial<ViewState>>(STATE_KEY) ?? {}) };
    this.controller = new SearchController({
      onBatch: (id, hits) => this.onBatch(id, hits),
      onStages: (id: number, stages: SearchStage[]) => this.post({ type: 'stages', id, stages }),
      onDone: (id, stats) => this.onDone(id, stats),
    });
    this.disposables.push(
      this.controller,
      this.navigator.onDidChangeIndex((index) => this.post({ type: 'current', index })),
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.ready = false;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((msg) => void this.onMessage(msg), undefined, this.disposables);
    view.onDidDispose(
      () => {
        this.view = undefined;
        this.ready = false;
      },
      undefined,
      this.disposables,
    );
  }

  // ---------------------------------------------------------------- コマンド

  async focus(): Promise<void> {
    await vscode.commands.executeCommand(`${SearchViewProvider.viewType}.focus`);
    await this.whenReady();
    this.post({ type: 'focus' });
  }

  async searchText(text: string, allBranches: boolean): Promise<void> {
    this.state.query = text;
    this.state.isRegex = false;
    if (allBranches) {
      this.state.scopeMode = 'branches';
      await this.ensureBranches();
      if (this.state.selectedBranches.length === 0) {
        this.state.selectedBranches = this.branches.map((b) => b.name);
      }
    }
    this.persist();
    await this.focus();
    this.post({ type: 'setState', state: this.state });
    await this.runSearch();
  }

  /** エディタの現在行の出所 (blame + 履歴 + 会話ログ) を追う。 */
  async traceOrigin(text: string, anchor?: { file: string; line: number }): Promise<void> {
    this.state.query = text;
    this.state.isRegex = false;
    this.state.matchWholeWord = false;
    this.state.scopeMode = 'trace';
    this.traceAnchor = anchor;
    this.persist();
    await this.focus();
    this.post({ type: 'setState', state: this.state });
    await this.runSearch();
  }

  rerun(): void {
    void this.runSearch();
  }

  clearResults(): void {
    this.controller.cancel();
    this.navigator.clear();
    this.highlighter.setQuery(undefined);
    this.post({ type: 'cleared' });
  }

  async refreshBranches(): Promise<void> {
    this.branchesLoadedFor = undefined;
    this.branches = [];
    await this.ensureBranches();
    this.post({ type: 'branches', branches: this.branches });
  }

  // ---------------------------------------------------------------- メッセージ

  private async onMessage(msg: any): Promise<void> {
    switch (msg?.type) {
      case 'ready': {
        this.markReady();
        await this.sendInit();
        return;
      }
      case 'search': {
        const previousQuery = this.state.query;
        this.state = { ...this.state, ...msg.state };
        // 検索語を打ち直したら、コマンド起動時の行との結び付きは切れる。
        if (this.state.query !== previousQuery) {
          this.traceAnchor = undefined;
        }
        this.persist();
        await this.runSearch();
        return;
      }
      case 'stateChanged': {
        this.state = { ...this.state, ...msg.state };
        this.persist();
        return;
      }
      case 'cancel': {
        this.controller.cancel();
        this.post({ type: 'cancelled' });
        return;
      }
      case 'open': {
        await this.navigator.openById(msg.id, msg.preview !== false, msg.focus === true);
        return;
      }
      case 'pickBranches': {
        await this.pickBranches();
        return;
      }
      case 'pickFolder': {
        await this.pickFolder();
        return;
      }
      case 'openSettings': {
        await vscode.commands.executeCommand('workbench.action.openSettings', 'blitzgrep');
        return;
      }
      case 'showLog': {
        log.show();
        return;
      }
      default:
        return;
    }
  }

  private async sendInit(): Promise<void> {
    await this.ensureContext();
    this.post({
      type: 'init',
      state: this.state,
      repo: this.describeRepo(),
      folders: workspaceFolders().map((f) => ({ uri: f.uri.toString(), name: f.name })),
      config: { debounceMs: getConfig().debounceMs, historyMaxCommits: getConfig().historyMaxCommits },
    });
    if (this.state.scopeMode === 'branches') {
      await this.ensureBranches();
      this.post({ type: 'branches', branches: this.branches });
    }
  }

  private describeRepo(): {
    kind: string;
    label: string;
    canBranchSearch: boolean;
    canHistorySearch: boolean;
    chatSessions: number;
    hint: string;
  } {
    const ctx = this.ctx;
    const chat = this.countChatSessions();
    if (!ctx) {
      return {
        kind: 'none',
        label: 'フォルダが開かれていません',
        canBranchSearch: false,
        canHistorySearch: false,
        chatSessions: chat,
        hint: '',
      };
    }
    switch (ctx.kind) {
      case 'local-git':
        return {
          kind: ctx.kind,
          label: ctx.label,
          canBranchSearch: true,
          canHistorySearch: true,
          chatSessions: chat,
          hint: 'ローカル git',
        };
      case 'virtual-github':
        return {
          kind: ctx.kind,
          label: ctx.label,
          canBranchSearch: true,
          canHistorySearch: false,
          chatSessions: chat,
          hint: 'リモート GitHub (履歴検索は不可)',
        };
      default:
        return {
          kind: ctx.kind,
          label: ctx.label,
          canBranchSearch: false,
          canHistorySearch: false,
          chatSessions: chat,
          hint: 'git 管理外のフォルダ',
        };
    }
  }

  /** このワークスペースに対応する会話ログの本数。0 なら UI で「全プロジェクト」を促す。 */
  private countChatSessions(): number {
    try {
      const uri = this.ctx ? vscode.Uri.parse(this.ctx.rootUri) : undefined;
      const workspacePath = uri?.scheme === 'file' ? uri.fsPath : undefined;
      return selectTranscripts(
        { allProjects: false, blocks: this.chatBlocks(), workspacePath },
        listTranscripts(),
      ).length;
    } catch (err) {
      log.debug(`会話ログの数を数えられませんでした: ${errorMessage(err)}`);
      return 0;
    }
  }

  private chatBlocks(): ChatBlockFilter {
    return {
      text: this.state.chatText,
      thinking: this.state.chatThinking,
      toolUse: this.state.chatToolUse,
      toolResult: this.state.chatToolResult,
    };
  }

  // ---------------------------------------------------------------- 検索

  private async ensureContext(): Promise<RepoContext | undefined> {
    const folders = workspaceFolders();
    if (folders.length === 0) {
      this.ctx = undefined;
      return undefined;
    }
    const chosen =
      folders.find((f) => f.uri.toString() === this.state.folderUri)?.uri ?? defaultFolder() ?? folders[0].uri;
    if (this.state.folderUri !== chosen.toString()) {
      this.state.folderUri = chosen.toString();
      this.persist();
    }
    if (this.ctx?.rootUri && this.ctx.rootUri === chosen.toString()) {
      return this.ctx;
    }
    this.ctx = await resolveRepoContext(chosen);
    return this.ctx;
  }

  private buildOptions(): SearchOptions | undefined {
    const query = this.state.query;
    if (!query) {
      return undefined;
    }
    const cfg = getConfig();
    const include = splitGlobs(this.state.include);
    const exclude = [...cfg.excludeGlobs, ...splitGlobs(this.state.exclude)];
    let scope: SearchOptions['scope'];
    switch (this.state.scopeMode) {
      case 'branches':
        scope = { kind: 'refs', refs: this.state.selectedBranches };
        break;
      case 'history':
        scope = { kind: 'history', allRefs: this.state.historyAllRefs, maxCommits: cfg.historyMaxCommits };
        break;
      case 'chat':
        scope = { kind: 'chat', allProjects: this.state.chatAllProjects, blocks: this.chatBlocks() };
        break;
      case 'trace':
        scope = {
          kind: 'trace',
          allRefs: this.state.historyAllRefs,
          maxCommits: cfg.historyMaxCommits,
          allProjects: this.state.chatAllProjects,
          blocks: this.chatBlocks(),
          anchor: this.traceAnchor ?? currentEditorAnchor(),
        };
        break;
      default:
        scope = { kind: 'worktree' };
        break;
    }
    return {
      query,
      isRegex: this.state.isRegex,
      isCaseSensitive: this.state.isCaseSensitive,
      matchWholeWord: this.state.matchWholeWord,
      includeGlobs: include,
      excludeGlobs: exclude,
      scope,
      dedupeAcrossRefs: this.state.dedupe,
    };
  }

  private async runSearch(): Promise<void> {
    const resolved = await this.ensureContext();
    // 会話ログはワークスペースが無くても (全プロジェクト指定なら) 検索できる。
    const chatWithoutFolder = this.state.scopeMode === 'chat' && this.state.chatAllProjects;
    if (!resolved && !chatWithoutFolder) {
      this.post({ type: 'done', id: -1, stats: emptyStats('—', ['開いているフォルダがありません。']) });
      return;
    }
    const ctx: RepoContext = resolved ?? {
      kind: 'none',
      rootUri: 'blitzgrep:/no-folder',
      label: '(フォルダなし)',
    };
    const opts = this.buildOptions();
    if (!opts) {
      this.clearResults();
      return;
    }
    if (opts.scope.kind === 'refs' && opts.scope.refs.length === 0) {
      await this.ensureBranches();
      const all = this.branches.map((b) => b.name);
      if (all.length === 0) {
        this.post({ type: 'done', id: -1, stats: emptyStats('—', ['ブランチが見つかりませんでした。']) });
        return;
      }
      this.state.selectedBranches = all;
      this.persist();
      this.post({ type: 'setState', state: this.state });
      opts.scope = { kind: 'refs', refs: all };
    }

    this.navigator.reset(ctx);
    this.highlighter.setQuery(opts);
    const id = this.controller.start(ctx, opts);
    this.post({ type: 'started', id, scopeMode: this.state.scopeMode });
  }

  private onBatch(id: number, hits: SearchHit[]): void {
    this.navigator.append(hits);
    this.post({ type: 'batch', id, hits });
  }

  private onDone(id: number, stats: SearchStats): void {
    this.post({ type: 'done', id, stats });
  }

  // ---------------------------------------------------------------- ブランチ

  private async ensureBranches(): Promise<void> {
    const ctx = await this.ensureContext();
    if (!ctx) {
      return;
    }
    if (this.branchesLoadedFor === ctx.rootUri && this.branches.length > 0) {
      return;
    }
    try {
      if (ctx.kind === 'local-git' && ctx.root) {
        this.branches = await listBranches(ctx.root);
      } else if (ctx.kind === 'virtual-github' && ctx.github) {
        this.branches = await listGitHubBranches(ctx.github);
      } else {
        this.branches = [];
      }
      this.branchesLoadedFor = ctx.rootUri;
    } catch (err) {
      this.branches = [];
      log.error(`ブランチ一覧の取得に失敗: ${errorMessage(err)}`);
      void vscode.window.showErrorMessage(`BlitzGrep: ブランチ一覧を取得できませんでした — ${errorMessage(err)}`);
    }
  }

  private async pickBranches(): Promise<void> {
    await this.ensureBranches();
    if (this.branches.length === 0) {
      void vscode.window.showWarningMessage('BlitzGrep: 検索できるブランチがありません。');
      return;
    }
    const selected = new Set(this.state.selectedBranches);
    const items: Array<vscode.QuickPickItem & { name: string }> = this.branches.map((b) => ({
      name: b.name,
      label: b.name,
      description: [b.isCurrent ? '$(check) 現在' : '', b.isDefault ? '既定' : '', b.kind === 'remote' ? 'リモート' : '']
        .filter(Boolean)
        .join(' · '),
      detail: b.subject || undefined,
      picked: selected.has(b.name),
    }));

    const picked = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      title: '検索するブランチ',
      placeHolder: '複数選択できます (未選択なら全ブランチ)',
      matchOnDescription: true,
    });
    if (!picked) {
      return;
    }
    this.state.selectedBranches = picked.length > 0 ? picked.map((p) => p.name) : this.branches.map((b) => b.name);
    this.state.scopeMode = 'branches';
    this.persist();
    this.post({ type: 'setState', state: this.state });
    this.post({ type: 'branches', branches: this.branches });
    await this.runSearch();
  }

  private async pickFolder(): Promise<void> {
    const folders = workspaceFolders();
    if (folders.length < 2) {
      return;
    }
    const picked = await vscode.window.showQuickPick(
      folders.map((f) => ({ label: f.name, description: f.uri.fsPath || f.uri.toString(), uri: f.uri.toString() })),
      { title: '検索対象のフォルダ' },
    );
    if (!picked) {
      return;
    }
    this.state.folderUri = picked.uri;
    this.branchesLoadedFor = undefined;
    this.branches = [];
    this.ctx = undefined;
    this.persist();
    await this.ensureContext();
    this.post({ type: 'setState', state: this.state });
    this.post({
      type: 'init',
      state: this.state,
      repo: this.describeRepo(),
      folders: folders.map((f) => ({ uri: f.uri.toString(), name: f.name })),
      config: { debounceMs: getConfig().debounceMs, historyMaxCommits: getConfig().historyMaxCommits },
    });
    await this.runSearch();
  }

  // ---------------------------------------------------------------- 雑務

  private persist(): void {
    void this.memento.update(STATE_KEY, this.state);
  }

  /** webview がまだ script を起動していない間の投稿は取りこぼすので、キューに退避する。 */
  private post(msg: unknown): void {
    if (!this.view || !this.ready) {
      this.pending.push(msg);
      if (this.pending.length > 200) {
        this.pending.shift();
      }
      return;
    }
    void this.view.webview.postMessage(msg);
  }

  private markReady(): void {
    this.ready = true;
    const queued = this.pending;
    this.pending = [];
    for (const msg of queued) {
      void this.view?.webview.postMessage(msg);
    }
    const waiters = this.readyWaiters;
    this.readyWaiters = [];
    for (const resolve of waiters) {
      resolve();
    }
  }

  private whenReady(): Promise<void> {
    if (this.ready && this.view) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.readyWaiters.push(resolve);
      // ビューが表示されない構成でもコマンドが固まらないようにする。
      setTimeout(resolve, 3000);
    });
  }

  onFoldersChanged(): void {
    this.ctx = undefined;
    this.branches = [];
    this.branchesLoadedFor = undefined;
    void this.sendInit();
  }

  private html(webview: vscode.Webview): string {
    const nonce = makeNonce();
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'main.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'main.css'));
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${style}" rel="stylesheet">
<title>BlitzGrep</title>
</head>
<body>
<div id="app">
  <div class="toolbar">
    <div class="input-wrap">
      <input id="query" type="text" placeholder="検索..." autocomplete="off" spellcheck="false">
      <div class="input-actions">
        <button id="t-case" class="icon-btn" title="大文字と小文字を区別する (Alt+C)">Aa</button>
        <button id="t-word" class="icon-btn" title="単語単位で検索する (Alt+W)"><u>ab</u></button>
        <button id="t-regex" class="icon-btn" title="正規表現を使用する (Alt+R)">.*</button>
      </div>
    </div>

    <div class="row scope-row">
      <select id="scope" title="検索対象">
        <option value="worktree">いま (ワーキングツリー)</option>
        <option value="branches">ブランチ横断</option>
        <option value="history">履歴 — いつ入った</option>
        <option value="chat">会話ログ — なぜ入った</option>
        <option value="trace">出所を追う — 全部まとめて</option>
      </select>
      <button id="pick-branches" class="chip-btn" title="検索するブランチを選ぶ">ブランチ選択…</button>
      <button id="toggle-advanced" class="icon-btn" title="詳細オプション">⋯</button>
    </div>

    <!-- 選んだ対象が何をするのかを 1 行で説明する。5 つの名前だけでは区別が付かないため。 -->
    <div id="scope-hint" class="scope-hint"></div>

    <div id="branch-chips" class="chips hidden"></div>

    <div id="history-opts" class="opts hidden">
      <label class="check">
        <input id="history-all-refs" type="checkbox"> すべての ref をさかのぼる (--all)
      </label>
    </div>

    <div id="chat-opts" class="opts hidden">
      <label class="check">
        <input id="chat-all-projects" type="checkbox"> 全プロジェクトの会話を対象にする
      </label>
      <div class="check-row">
        <label class="check"><input id="chat-text" type="checkbox"> 発言</label>
        <label class="check"><input id="chat-thinking" type="checkbox"> 思考</label>
        <label class="check"><input id="chat-tooluse" type="checkbox"> ツール引数</label>
        <label class="check"><input id="chat-toolresult" type="checkbox"> ツール結果</label>
      </div>
    </div>

    <div id="advanced" class="advanced hidden">
      <label class="field">
        <span>含める</span>
        <input id="include" type="text" placeholder="*.ts, src/**/*.md" autocomplete="off" spellcheck="false">
      </label>
      <label class="field">
        <span>除外する</span>
        <input id="exclude" type="text" placeholder="**/test/**" autocomplete="off" spellcheck="false">
      </label>
      <label class="check">
        <input id="dedupe" type="checkbox"> ブランチ間の同一行をまとめる
      </label>
      <div class="links">
        <a id="open-settings" href="#">設定</a> · <a id="show-log" href="#">ログ</a>
      </div>
    </div>

    <div id="repo-line" class="repo-line"></div>
    <!-- 何段のどこを走っているかを見せる。出所追跡は 3 段あるので待ち時間の説明が要る。 -->
    <div id="pipeline" class="pipeline hidden"></div>
    <div id="status" class="status"></div>
    <div id="messages" class="messages hidden"></div>
  </div>

  <div class="list-wrap">
    <div id="list" class="list" tabindex="0">
      <div id="spacer"></div>
      <div id="rows"></div>
    </div>
    <!-- スクロールで見出しが流れても、いまどのファイル/コミット/セッションを見ているかを残す。 -->
    <div id="sticky" class="r r-file sticky hidden" title="この見出しへ戻る"></div>
  </div>
  <div id="empty" class="empty">検索語を入力してください。</div>
  <div id="hint" class="hint hidden">クリックでプレビュー · ダブルクリックで確定 · ↑↓ で移動 · ←→ で折りたたみ</div>
</div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

/** ビューから手動で「出所を追う」を実行したときの起点 = アクティブなエディタのカーソル行。 */
function currentEditorAnchor(): { file: string; line: number } | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== 'file') {
    return undefined;
  }
  return { file: editor.document.uri.fsPath, line: editor.selection.active.line + 1 };
}

function splitGlobs(s: string): string[] {
  return s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

function emptyStats(engine: string, errors: string[]): SearchStats {
  return {
    matches: 0,
    files: 0,
    refs: 0,
    commits: 0,
    sessions: 0,
    durationMs: 0,
    truncated: false,
    deduped: 0,
    warnings: [],
    errors,
    engine,
  };
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}
