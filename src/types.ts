/**
 * ヒットの出所。ワーキングツリー / ブランチのヒットには付かない (undefined)。
 * 「いつ・なぜ入ったか」を答えるソースだけがこれを持つ。
 */
export type HitOrigin =
  | {
      kind: 'commit';
      sha: string;
      shortSha: string;
      author: string;
      /** ISO8601 */
      date: string;
      subject: string;
      /** '+' = このコミットで追加された行、'-' = 削除された行 */
      change: '+' | '-';
      /** git blame で得た「その行を最後に触ったコミット」。履歴検索の結果とは出所が違う。 */
      blame?: boolean;
    }
  | {
      kind: 'chat';
      /** ~/.claude/projects 配下のディレクトリ名 (プロジェクト識別子)。 */
      project: string;
      /** 会話が行われていた作業ディレクトリ。 */
      cwd: string;
      /** 会話時のブランチ (記録があれば)。 */
      gitBranch: string;
      sessionId: string;
      /** transcript ファイルの絶対パス。 */
      sessionFile: string;
      /** レコードの uuid。 */
      uuid: string;
      /** セッション内での発言の通し番号。会話ビューアで該当箇所へ飛ぶのに使う。 */
      entryIndex: number;
      /**
       * この通し番号を振ったときに tool_result を並びに含めていたか。
       * ビューアを別の条件で組み立てると番号がズレて、まったく違う場所へ飛んでしまう。
       */
      withToolResults: boolean;
      role: 'user' | 'assistant';
      /** text / thinking / tool_use / tool_result */
      block: string;
      /** tool_use のときのツール名。 */
      tool?: string;
      /** ISO8601 */
      date: string;
      /** サブエージェント (Task) 側の会話か。 */
      isSidechain: boolean;
      /**
       * いま開いているワークスペースとは別のフォルダで交わされた会話か。
       * 「全プロジェクト」で検索していると無関係な会話が混ざるので、一覧で区別できるようにする。
       */
      otherProject: boolean;
    };

/** 1ヒット = 1行。`matches` は `text` 内の [開始文字オフセット, 長さ]。 */
export interface SearchHit {
  /** 検索セッション内で通し番号。webview 側の仮想リストのキーになる。 */
  id: number;
  /** null = ワーキングツリー。それ以外は "main" / "origin/dev" などの ref 名。 */
  ref: string | null;
  /** リポジトリ (または検索ルート) からの相対パス。区切りは常に "/"。 */
  file: string;
  /** 1 始まりの行番号。 */
  line: number;
  /** 1 始まりの桁 (文字単位)。切り詰め前の元の行に対する位置。 */
  col: number;
  /** 先頭の一致の長さ (文字数)。ジャンプ時の選択範囲に使う。 */
  len: number;
  /** 行のテキスト (長すぎる場合は切り詰め済み)。 */
  text: string;
  /** text 内での一致位置。 */
  matches: Array<[number, number]>;
  /** contextLines > 0 のときの前後行。ジャンプ対象ではない。 */
  before?: string[];
  after?: string[];
  /** 履歴・会話ログのヒットだけが持つ出所情報。 */
  origin?: HitOrigin;
}

/** 会話ログのどのブロックを検索対象にするか。 */
export interface ChatBlockFilter {
  /** 人間の発言と Claude の応答本文。「なぜ」はだいたいここ。 */
  text: boolean;
  /** Claude の思考。判断の理由が残っていることが多いがノイズも多い。 */
  thinking: boolean;
  /** ツール呼び出しの引数。Edit/Write の中身 = 実際に書かれた仕様はここ。 */
  toolUse: boolean;
  /** ツールの実行結果。巨大でノイズが多いので既定はオフ。 */
  toolResult: boolean;
}

export type SearchScope =
  | { kind: 'worktree' }
  | { kind: 'refs'; refs: string[] }
  /** git log -S / -G による履歴検索。 */
  | { kind: 'history'; allRefs: boolean; maxCommits: number }
  /** Claude Code の会話ログ検索。 */
  | { kind: 'chat'; allProjects: boolean; blocks: ChatBlockFilter }
  /**
   * 出所追跡: blame + 履歴 + 会話ログ を 1 回で走らせる。
   * 「いつ入ったか」と「なぜ入ったか」を並べて見るためのモード。
   */
  | {
      kind: 'trace';
      allRefs: boolean;
      maxCommits: number;
      allProjects: boolean;
      blocks: ChatBlockFilter;
      /** エディタから起動したときの起点。あれば blame も引く。 */
      anchor?: { file: string; line: number };
    };

export type SearchSourceKind = SearchScope['kind'];

export interface SearchOptions {
  query: string;
  isRegex: boolean;
  isCaseSensitive: boolean;
  matchWholeWord: boolean;
  /** ripgrep の --glob 形式。除外は "!" 始まり。 */
  includeGlobs: string[];
  excludeGlobs: string[];
  scope: SearchScope;
  /** 複数 ref を横断するとき、同じ (ファイル, 行, 内容) を 1 件にまとめる。 */
  dedupeAcrossRefs: boolean;
}

export interface SearchStats {
  matches: number;
  files: number;
  refs: number;
  /** 履歴検索でヒットしたコミット数。 */
  commits: number;
  /** 会話ログ検索でヒットしたセッション数。 */
  sessions: number;
  durationMs: number;
  truncated: boolean;
  /** ref 横断の重複排除で隠したヒット数。 */
  deduped: number;
  /** 検索できなかった ref など、致命的でない問題。 */
  warnings: string[];
  errors: string[];
  engine: string;
}

export type StageStatus = 'pending' | 'running' | 'done' | 'skipped' | 'error';

/**
 * 検索パイプラインの 1 段。
 * 「出所を追う」は blame → 履歴 → 会話ログ と順に流れるので、
 * どこまで進んだか・どの段が何件出したかを見せないと待ち時間が不安になる。
 */
export interface SearchStage {
  key: string;
  /** 結果一覧の出所マークと揃える (📍 ◆ 💬 …)。 */
  icon: string;
  label: string;
  status: StageStatus;
  /** この段が出したヒット数。 */
  count: number;
  /** 「"foo" で再検索」「7/20 ブランチ」など、状態の補足。 */
  note?: string;
  /** 0..1。全体量が分かるときだけ。 */
  progress?: number;
  durationMs?: number;
}

/** プロバイダから逐次ヒットを受け取るシンク。 */
export interface HitSink {
  /** false を返したら (上限到達などで) 呼び出し側は打ち切ってよい。 */
  push(hits: SearchHit[]): boolean;
  warn(message: string): void;
  error(message: string): void;
}

export interface BranchInfo {
  /** "main" / "origin/dev" などの短縮名。git grep にそのまま渡せる。 */
  name: string;
  kind: 'local' | 'remote';
  isCurrent: boolean;
  isDefault: boolean;
  /** ISO8601。新しい順に並べるのに使う。 */
  committerDate: string;
  subject: string;
}

export type RepoKind = 'local-git' | 'virtual-github' | 'plain-folder' | 'none';

export interface RepoContext {
  kind: RepoKind;
  /** ローカル git のワークツリールート (kind === 'local-git')。 */
  root?: string;
  /** 検索ルートの URI 文字列。 */
  rootUri: string;
  /** vscode-vfs://github/<owner>/<repo> のとき。 */
  github?: { owner: string; repo: string; ref?: string };
  label: string;
}
