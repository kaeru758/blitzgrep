import * as vscode from 'vscode';
import { getConfig } from '../config';
import { type BlameInfo, blameLine } from '../git/gitService';
import { errorMessage, log } from '../log';
import type { HitSink, RepoContext, SearchHit, SearchOptions, SearchStage, SearchStats } from '../types';
import { extractSymbol } from '../util/symbol';
import { searchChat } from './chatProvider';
import { searchWithFileSystem } from './fsProvider';
import { searchRefs } from './gitGrepProvider';
import { searchGitHubRefs } from './githubProvider';
import { searchHistory } from './pickaxeProvider';
import { searchWithRipgrep } from './ripgrepProvider';
import { StageTracker, stageSink } from './stages';

export interface SearchHandlers {
  onBatch(sessionId: number, hits: SearchHit[]): void;
  onStages(sessionId: number, stages: SearchStage[]): void;
  onDone(sessionId: number, stats: SearchStats): void;
}

const FLUSH_INTERVAL_MS = 60;

export class SearchController implements vscode.Disposable {
  private sessionCounter = 0;
  private cts?: vscode.CancellationTokenSource;
  private activeId = 0;

  constructor(private readonly handlers: SearchHandlers) {}

  get currentSessionId(): number {
    return this.activeId;
  }

  cancel(): void {
    this.cts?.cancel();
    this.cts?.dispose();
    this.cts = undefined;
  }

  dispose(): void {
    this.cancel();
  }

  /** 実行中の検索を打ち切って新しい検索を始める。セッション ID を返す。 */
  start(ctx: RepoContext, opts: SearchOptions): number {
    this.cancel();
    const id = ++this.sessionCounter;
    this.activeId = id;
    const cts = new vscode.CancellationTokenSource();
    this.cts = cts;
    void this.run(id, ctx, opts, cts.token).finally(() => {
      if (this.cts === cts) {
        cts.dispose();
        this.cts = undefined;
      }
    });
    return id;
  }

  private async run(
    id: number,
    ctx: RepoContext,
    opts: SearchOptions,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const cfg = getConfig();
    const started = Date.now();
    const stats: SearchStats = {
      matches: 0,
      files: 0,
      refs: opts.scope.kind === 'refs' ? opts.scope.refs.length : 0,
      commits: 0,
      sessions: 0,
      durationMs: 0,
      truncated: false,
      deduped: 0,
      warnings: [],
      errors: [],
      engine: '',
    };

    const seenFiles = new Set<string>();
    const seenLines = new Set<string>();
    const seenCommits = new Set<string>();
    const seenSessions = new Set<string>();
    const dedupe = opts.scope.kind === 'refs' && opts.dedupeAcrossRefs;
    let idCounter = 0;
    const nextId = () => idCounter++;

    let pending: SearchHit[] = [];
    let lastFlush = 0;

    const flush = (force: boolean) => {
      if (pending.length === 0) {
        return;
      }
      const now = Date.now();
      if (!force && now - lastFlush < FLUSH_INTERVAL_MS) {
        return;
      }
      lastFlush = now;
      const batch = pending;
      pending = [];
      if (id === this.activeId) {
        this.handlers.onBatch(id, batch);
      }
    };

    const sink: HitSink = {
      push: (hits) => {
        if (token.isCancellationRequested || id !== this.activeId) {
          return false;
        }
        for (const hit of hits) {
          if (stats.matches >= cfg.maxResults) {
            stats.truncated = true;
            flush(true);
            return false;
          }
          if (dedupe) {
            const key = `${hit.file}\u0000${hit.line}\u0000${hit.text}`;
            if (seenLines.has(key)) {
              stats.deduped++;
              continue;
            }
            seenLines.add(key);
          }
          const fileKey = `${hit.ref ?? ''}\u0000${hit.file}`;
          if (!seenFiles.has(fileKey)) {
            seenFiles.add(fileKey);
            stats.files++;
          }
          if (hit.origin?.kind === 'commit' && !seenCommits.has(hit.origin.sha)) {
            seenCommits.add(hit.origin.sha);
            stats.commits++;
          }
          if (hit.origin?.kind === 'chat' && !seenSessions.has(hit.origin.sessionFile)) {
            seenSessions.add(hit.origin.sessionFile);
            stats.sessions++;
          }
          stats.matches++;
          pending.push(hit);
        }
        flush(false);
        return true;
      },
      warn: (message) => {
        if (stats.warnings.length < 20 && !stats.warnings.includes(message)) {
          stats.warnings.push(message);
        }
      },
      error: (message) => {
        if (stats.errors.length < 10 && !stats.errors.includes(message)) {
          stats.errors.push(message);
        }
      },
    };

    const tracker = new StageTracker((stages) => {
      if (id === this.activeId) {
        this.handlers.onStages(id, stages);
      }
    });

    try {
      stats.engine = await this.dispatch(ctx, opts, sink, token, nextId, tracker);
      tracker.settleRemaining(token.isCancellationRequested ? 'skipped' : 'done');
    } catch (err) {
      log.error(`検索に失敗: ${errorMessage(err)}`);
      sink.error(errorMessage(err));
      tracker.settleRemaining('error');
    } finally {
      tracker.dispose();
    }

    flush(true);
    stats.durationMs = Date.now() - started;
    if (!token.isCancellationRequested && id === this.activeId) {
      this.handlers.onDone(id, stats);
    }
  }

  /**
   * 出所追跡。1 つの検索語について
   *   1. その行を最後に触ったコミット (git blame)
   *   2. その文字列が現れた / 消えたコミット (pickaxe)
   *   3. それについて話していた会話 (Claude Code の transcript)
   * を順に流し込む。「いつ」の次に「なぜ」が並ぶ順序に意味がある。
   */
  private async trace(
    ctx: RepoContext,
    opts: SearchOptions,
    scope: Extract<SearchOptions['scope'], { kind: 'trace' }>,
    sink: HitSink,
    token: vscode.CancellationToken,
    nextId: () => number,
    canSpawn: boolean,
    tracker: StageTracker,
  ): Promise<string> {
    const engines: string[] = [];
    const hasGit = ctx.kind === 'local-git' && !!ctx.root && canSpawn;

    // 走らない段も含めて先に 3 つ並べる。「何が走るのか」が待つ前に見えている方が親切。
    tracker.plan([
      { key: 'blame', icon: '📍', label: '最後に触ったコミット' },
      { key: 'history', icon: '◆', label: 'いつ入った (git log -S)' },
      { key: 'chat', icon: '💬', label: 'なぜ入った (会話ログ)' },
    ]);

    if (!hasGit) {
      const why = canSpawn ? 'ローカルの git リポジトリではありません' : '信頼されていないワークスペースです';
      tracker.finish('blame', 'skipped', why);
      tracker.finish('history', 'skipped', why);
      sink.warn(`${why}。履歴は追えません。`);
    } else if (!scope.anchor) {
      tracker.finish('blame', 'skipped', 'エディタの行が起点にないため');
    } else {
      tracker.begin('blame');
      const outcome = await this.emitBlame(ctx.root!, scope.anchor, stageSink(sink, tracker, 'blame'), nextId);
      tracker.finish('blame', outcome.ok ? 'done' : 'skipped', outcome.note);
      engines.push('blame');
    }

    if (hasGit && !token.isCancellationRequested) {
      tracker.begin('history');
      const history = stageSink(sink, tracker, 'history');
      await searchHistory(
        ctx.root!,
        opts,
        { allRefs: scope.allRefs, maxCommits: scope.maxCommits },
        history,
        token,
        nextId,
      );
      // 行全体だと空振りすることがある (整形の変化など)。特徴語で 1 度だけ粘る。
      let retried: string | undefined;
      if (history.count === 0) {
        const symbol = extractSymbol(opts.query);
        if (symbol && symbol !== opts.query) {
          retried = symbol;
          sink.warn(`履歴に完全一致がないため "${symbol}" で再検索しました。`);
          tracker.note('history', `"${symbol}" で再検索中`);
          await searchHistory(
            ctx.root!,
            { ...opts, query: symbol, isRegex: false },
            { allRefs: scope.allRefs, maxCommits: scope.maxCommits },
            history,
            token,
            nextId,
          );
        }
      }
      tracker.finish('history', 'done', outcomeNote(history.count, retried));
      engines.push('git log -S');
    }

    if (!token.isCancellationRequested) {
      tracker.begin('chat');
      const chatScope = {
        allProjects: scope.allProjects,
        blocks: scope.blocks,
        workspacePath: workspacePathOf(ctx),
      };
      const chat = stageSink(sink, tracker, 'chat');
      await searchChat(chatScope, opts, chat, token, nextId);
      // 会話の地の文にコード 1 行がそのまま出ることは稀なので、特徴語で追いかける。
      let retried: string | undefined;
      if (chat.count === 0) {
        const symbol = extractSymbol(opts.query);
        if (symbol && symbol !== opts.query) {
          retried = symbol;
          sink.warn(`会話ログに完全一致がないため "${symbol}" で再検索しました。`);
          tracker.note('chat', `"${symbol}" で再検索中`);
          await searchChat(chatScope, { ...opts, query: symbol, isRegex: false }, chat, token, nextId);
        }
      }
      tracker.finish('chat', 'done', outcomeNote(chat.count, retried));
      engines.push('会話ログ');
    }

    return engines.join(' + ') || '—';
  }

  /** blame の結果を 1 件のヒットとして流す。UI に出す理由つきの結果を返す。 */
  private async emitBlame(
    root: string,
    anchor: { file: string; line: number },
    sink: HitSink,
    nextId: () => number,
  ): Promise<{ ok: boolean; note?: string }> {
    let info: BlameInfo | undefined;
    try {
      info = await blameLine(root, anchor.file, anchor.line);
    } catch (err) {
      sink.warn(`blame に失敗しました: ${errorMessage(err)}`);
      return { ok: false, note: 'blame に失敗' };
    }
    if (!info) {
      return { ok: false, note: '追跡できませんでした' };
    }
    if (info.uncommitted) {
      sink.warn('この行はまだコミットされていません (blame 対象外)。');
      return { ok: false, note: 'まだコミットされていません' };
    }
    sink.push([
      {
        id: nextId(),
        ref: info.sha,
        file: info.file,
        line: anchor.line,
        col: 1,
        len: 0,
        text: info.subject || '(件名なし)',
        matches: [],
        origin: {
          kind: 'commit',
          sha: info.sha,
          shortSha: info.shortSha,
          author: info.author,
          date: info.date,
          subject: info.subject,
          change: '+',
          blame: true,
        },
      },
    ]);
    return { ok: true };
  }

  private async dispatch(
    ctx: RepoContext,
    opts: SearchOptions,
    sink: HitSink,
    token: vscode.CancellationToken,
    nextId: () => number,
    tracker: StageTracker,
  ): Promise<string> {
    const canSpawn = vscode.workspace.isTrusted;

    if (opts.scope.kind === 'trace') {
      return this.trace(ctx, opts, opts.scope, sink, token, nextId, canSpawn, tracker);
    }

    // 会話ログは git にもワークツリーにも依存しない。外部プロセスも起動しない。
    if (opts.scope.kind === 'chat') {
      tracker.plan([{ key: 'chat', icon: '💬', label: '会話ログ' }]);
      tracker.begin('chat');
      await searchChat(
        {
          allProjects: opts.scope.allProjects,
          blocks: opts.scope.blocks,
          workspacePath: workspacePathOf(ctx),
        },
        opts,
        stageSink(sink, tracker, 'chat'),
        token,
        nextId,
      );
      return '会話ログ';
    }

    if (opts.scope.kind === 'history') {
      tracker.plan([{ key: 'history', icon: '◆', label: '履歴 (git log -S)' }]);
      if (ctx.kind !== 'local-git' || !ctx.root) {
        sink.error('履歴検索はローカルの git リポジトリでのみ使えます。');
        tracker.finish('history', 'error', 'ローカルの git リポジトリではありません');
        return '—';
      }
      if (!canSpawn) {
        sink.error('信頼されていないワークスペースでは履歴検索を実行できません。');
        tracker.finish('history', 'error', '信頼されていないワークスペースです');
        return '—';
      }
      tracker.begin('history');
      await searchHistory(
        ctx.root,
        opts,
        { allRefs: opts.scope.allRefs, maxCommits: opts.scope.maxCommits },
        stageSink(sink, tracker, 'history'),
        token,
        nextId,
      );
      return opts.isRegex ? 'git log -G' : 'git log -S';
    }

    if (opts.scope.kind === 'refs') {
      const refs = opts.scope.refs;
      tracker.plan([{ key: 'refs', icon: '🌿', label: `ブランチ横断 (${refs.length})` }]);
      if (refs.length === 0) {
        sink.error('検索対象のブランチが選択されていません。');
        tracker.finish('refs', 'error', 'ブランチが選ばれていません');
        return '—';
      }
      if (ctx.kind === 'virtual-github' && ctx.github) {
        tracker.begin('refs');
        await searchGitHubRefs(ctx.github, refs, opts, stageSink(sink, tracker, 'refs'), token, nextId);
        return 'GitHub API';
      }
      if (ctx.kind === 'local-git' && ctx.root) {
        if (!canSpawn) {
          sink.error('信頼されていないワークスペースではブランチ検索を実行できません。');
          tracker.finish('refs', 'error', '信頼されていないワークスペースです');
          return '—';
        }
        tracker.begin('refs');
        tracker.progress('refs', 0, `0/${refs.length} ブランチ`);
        await searchRefs(
          ctx.root,
          refs,
          opts,
          stageSink(sink, tracker, 'refs'),
          token,
          nextId,
          (done, total) => tracker.progress('refs', done / total, `${done}/${total} ブランチ`),
        );
        return 'git grep';
      }
      sink.error('このフォルダは git リポジトリではないため、ブランチ検索はできません。');
      tracker.finish('refs', 'error', 'git リポジトリではありません');
      return '—';
    }

    // ワーキングツリー検索
    tracker.plan([{ key: 'worktree', icon: '🔎', label: 'ワーキングツリー' }]);
    tracker.begin('worktree');
    const worktree = stageSink(sink, tracker, 'worktree');
    if (ctx.kind === 'virtual-github' && ctx.github) {
      // 仮想リポジトリに「ワーキングツリー」は無いので、既定ブランチを検索する。
      const ref = ctx.github.ref ?? 'HEAD';
      await searchGitHubRefs(ctx.github, [ref], opts, worktree, token, nextId);
      return 'GitHub API';
    }

    const rootUri = vscode.Uri.parse(ctx.rootUri);
    if (canSpawn && rootUri.scheme === 'file') {
      // 開いているフォルダを基点にする (git ルートではない)。fileUri と揃えるため。
      const ok = await searchWithRipgrep(rootUri.fsPath, opts, worktree, token, nextId);
      if (ok) {
        return 'ripgrep';
      }
      sink.warn('ripgrep が見つからないため、低速なフォールバックで検索しています。');
      tracker.note('worktree', 'ripgrep が見つからずフォールバック中');
    }
    await searchWithFileSystem(rootUri, opts, worktree, token, nextId);
    return 'ファイルシステム';
  }
}

/** 段の結果を一言で言い表す。再検索したならそれも含める。 */
function outcomeNote(count: number, retriedWith: string | undefined): string | undefined {
  if (count > 0) {
    return retriedWith ? `"${retriedWith}" で再検索` : undefined;
  }
  return retriedWith ? `"${retriedWith}" でも一致なし` : '一致なし';
}

/** 会話ログのプロジェクト絞り込みに使う、ローカルの絶対パス。 */
function workspacePathOf(ctx: RepoContext): string | undefined {
  const uri = vscode.Uri.parse(ctx.rootUri);
  return uri.scheme === 'file' ? uri.fsPath : undefined;
}
