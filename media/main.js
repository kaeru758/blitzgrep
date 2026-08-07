// @ts-check
(function () {
  const vscode = acquireVsCodeApi();

  const ROW_H = 22;
  const OVERSCAN = 8;

  const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
  const el = {
    query: /** @type {HTMLInputElement} */ ($('query')),
    case: $('t-case'),
    word: $('t-word'),
    regex: $('t-regex'),
    scope: /** @type {HTMLSelectElement} */ ($('scope')),
    pickBranches: /** @type {HTMLButtonElement} */ ($('pick-branches')),
    toggleAdvanced: $('toggle-advanced'),
    advanced: $('advanced'),
    include: /** @type {HTMLInputElement} */ ($('include')),
    exclude: /** @type {HTMLInputElement} */ ($('exclude')),
    dedupe: /** @type {HTMLInputElement} */ ($('dedupe')),
    branchChips: $('branch-chips'),
    historyOpts: $('history-opts'),
    historyAllRefs: /** @type {HTMLInputElement} */ ($('history-all-refs')),
    chatOpts: $('chat-opts'),
    chatAllProjects: /** @type {HTMLInputElement} */ ($('chat-all-projects')),
    chatText: /** @type {HTMLInputElement} */ ($('chat-text')),
    chatThinking: /** @type {HTMLInputElement} */ ($('chat-thinking')),
    chatToolUse: /** @type {HTMLInputElement} */ ($('chat-tooluse')),
    chatToolResult: /** @type {HTMLInputElement} */ ($('chat-toolresult')),
    scopeHint: $('scope-hint'),
    repoLine: $('repo-line'),
    pipeline: $('pipeline'),
    status: $('status'),
    messages: $('messages'),
    list: $('list'),
    spacer: $('spacer'),
    rows: $('rows'),
    sticky: $('sticky'),
    empty: $('empty'),
    hint: $('hint'),
  };

  /** @type {any} */
  let state = {
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
  let repo = { kind: 'none', label: '', canBranchSearch: false, canHistorySearch: false, chatSessions: 0, hint: '' };
  let folders = [];
  let debounceMs = 120;
  let historyMaxCommits = 300;

  /** 対象を選んだときに「それが何をするのか」を出す。名前だけでは 5 つを区別できない。 */
  const SCOPE_HINT = {
    worktree: 'いま作業中のファイルをそのまま全文検索します。',
    branches: '選んだブランチの最新状態を横断して検索します（Enter で実行）。',
    history: 'その文字列が現れた / 消えたコミットを探します（Enter で実行）。',
    chat: 'Claude Code の会話ログから「なぜそうしたか」を探します。',
    trace: 'blame → 履歴 → 会話ログ を 1 回で辿ります（Enter で実行）。',
  };

  let sessionId = -1;
  let busy = false;
  /** @type {Array<any>} */
  let flatHits = [];
  /** @type {Array<{ref: string|null, file: string, hits: any[], collapsed: boolean}>} */
  let groups = [];
  /** @type {Map<string, any>} */
  const groupIndex = new Map();
  /** @type {Array<any>} */
  let rows = [];
  let rowsDirty = false;
  /** @type {Map<number, number>} */
  let rowOfHit = new Map();
  let selected = -1;
  let renderScheduled = false;
  /** 画面上端に貼り付けている見出し。同じものを描き直さないよう覚えておく。 */
  let stickyGroup = null;
  let stickyCount = -1;
  let stickyIndex = -1;
  /** 検索パイプラインの各段。どこまで進んだかを見せるためだけに持つ。 */
  let stages = [];
  let stagesId = -1;

  // ---------------------------------------------------------------- 状態

  function syncControlsFromState() {
    el.query.value = state.query;
    el.case.classList.toggle('on', state.isCaseSensitive);
    el.word.classList.toggle('on', state.matchWholeWord);
    el.regex.classList.toggle('on', state.isRegex);
    el.scope.value = state.scopeMode;
    el.include.value = state.include;
    el.exclude.value = state.exclude;
    el.dedupe.checked = state.dedupe;
    el.historyAllRefs.checked = state.historyAllRefs;
    el.chatAllProjects.checked = state.chatAllProjects;
    el.chatText.checked = state.chatText;
    el.chatThinking.checked = state.chatThinking;
    el.chatToolUse.checked = state.chatToolUse;
    el.chatToolResult.checked = state.chatToolResult;
    el.advanced.classList.toggle('hidden', !state.showAdvanced);
    el.toggleAdvanced.classList.toggle('on', state.showAdvanced);
    updateScopeUi();
  }

  function setOptionEnabled(value, enabled) {
    const opt = /** @type {HTMLOptionElement} */ (el.scope.querySelector(`option[value="${value}"]`));
    if (opt) {
      opt.disabled = !enabled;
    }
  }

  function updateScopeUi() {
    const mode = state.scopeMode;
    const branchMode = mode === 'branches';
    el.pickBranches.classList.toggle('hidden', !branchMode);
    el.pickBranches.disabled = !repo.canBranchSearch;
    el.branchChips.classList.toggle('hidden', !branchMode || state.selectedBranches.length === 0);
    if (branchMode) {
      const n = state.selectedBranches.length;
      el.pickBranches.textContent = n === 0 ? 'ブランチ選択…' : `ブランチ ${n} 件`;
      renderChips();
    }
    // 出所追跡は履歴と会話ログの両方を走らせるので、どちらのオプションも出す。
    el.historyOpts.classList.toggle('hidden', mode !== 'history' && mode !== 'trace');
    el.chatOpts.classList.toggle('hidden', mode !== 'chat' && mode !== 'trace');

    setOptionEnabled('branches', repo.canBranchSearch);
    setOptionEnabled('history', repo.canHistorySearch);
    el.scopeHint.textContent = SCOPE_HINT[mode] || '';
    renderRepoLine();
  }

  function renderChips() {
    el.branchChips.textContent = '';
    const shown = state.selectedBranches.slice(0, 12);
    for (const name of shown) {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = name;
      el.branchChips.appendChild(chip);
    }
    if (state.selectedBranches.length > shown.length) {
      const more = document.createElement('span');
      more.className = 'chip';
      more.textContent = `+${state.selectedBranches.length - shown.length}`;
      el.branchChips.appendChild(more);
    }
  }

  function renderRepoLine() {
    const parts = [];
    if (folders.length > 1) {
      const f = folders.find((x) => x.uri === state.folderUri);
      parts.push(`📁 ${f ? f.name : '?'}`);
    }
    if (repo.label) {
      parts.push(repo.label);
    }
    if (state.scopeMode === 'chat') {
      parts.push(
        state.chatAllProjects
          ? '全プロジェクトの会話ログ'
          : repo.chatSessions > 0
            ? `会話ログ ${repo.chatSessions} 本`
            : 'このプロジェクトの会話ログなし',
      );
    } else if (repo.hint) {
      parts.push(repo.hint);
    }
    el.repoLine.textContent = parts.join(' · ');
    el.repoLine.title = el.repoLine.textContent;
  }

  function pushState() {
    vscode.postMessage({ type: 'stateChanged', state });
  }

  // ---------------------------------------------------------------- 検索の起動

  let debounceTimer = 0;

  function requestSearch(immediate) {
    clearTimeout(debounceTimer);
    if (!el.query.value) {
      clearResults();
      vscode.postMessage({ type: 'search', state });
      return;
    }
    // ブランチ横断・履歴・出所追跡は重いので、明示的な実行 (Enter) のときだけ走らせる。
    const HEAVY = {
      branches: 'Enter でブランチ横断検索',
      history: 'Enter で履歴を検索',
      trace: 'Enter で出所を追う',
    };
    if (!immediate && HEAVY[state.scopeMode]) {
      setStatus(HEAVY[state.scopeMode], false);
      return;
    }
    const delay = immediate ? 0 : debounceMs;
    debounceTimer = window.setTimeout(() => {
      vscode.postMessage({ type: 'search', state });
    }, delay);
  }

  function clearResults() {
    flatHits = [];
    groups = [];
    groupIndex.clear();
    rows = [];
    rowOfHit = new Map();
    selected = -1;
    rowsDirty = false;
    el.spacer.style.height = '0px';
    el.rows.textContent = '';
    hideSticky();
    el.messages.classList.add('hidden');
    setStatus('', false);
    renderEmptyState();
    el.empty.classList.remove('hidden');
    el.hint.classList.add('hidden');
  }

  /**
   * 検索前に出す、この拡張機能の骨格。
   * 「1 つの語を 4 つの出所に投げる」ことが他の検索と違う点なので、
   * 何もしていない時間にそれを見せる。アイコンは結果一覧の出所印と揃えてある。
   */
  const SOURCES = [
    ['📄', 'いま', '作業中のファイル'],
    ['🌿', 'ブランチ', '取得済みの ref を横断'],
    ['◆', '履歴', 'その文字列が現れた / 消えたコミット'],
    ['💬', '会話ログ', 'なぜそうしたか。コードにもコミットにも残らない'],
  ];

  function renderSources(parent) {
    const list = document.createElement('div');
    list.className = 'empty-sources';
    for (const [mark, name, desc] of SOURCES) {
      const row = document.createElement('div');
      row.className = 'src-row';
      span(row, 'src-mark', mark);
      span(row, 'src-name', name);
      span(row, 'src-desc', desc);
      list.appendChild(row);
    }
    parent.appendChild(list);
  }

  /** 空の状態こそ「次に何ができるか」を出す場所。黙って空欄にしない。 */
  function renderEmptyState() {
    el.empty.textContent = '';
    span(el.empty, 'empty-title', el.query.value ? '一致はありません。' : '1 つの検索語を、4 つの出所に投げます。');

    if (!el.query.value) {
      renderSources(el.empty);
      appendTips(el.empty, [
        'エディタで Ctrl+Alt+O — カーソル行の出所を 4 つまとめて追う',
        'エディタで Ctrl+Alt+Shift+F — 選択範囲をそのまま検索',
      ]);
      return;
    }

    const tips = noMatchTips();
    if (state.isCaseSensitive) {
      tips.push('「Aa」（大文字小文字を区別）を切ると増えることがあります。');
    }
    if (state.include || state.exclude) {
      tips.push('「⋯」の 含める / 除外する で絞り込みすぎていないか確認してください。');
    }
    appendTips(el.empty, tips);
  }

  function appendTips(parent, tips) {
    if (tips.length === 0) {
      return;
    }
    const ul = document.createElement('ul');
    ul.className = 'empty-tips';
    for (const t of tips) {
      const li = document.createElement('li');
      li.textContent = t;
      ul.appendChild(li);
    }
    parent.appendChild(ul);
  }

  function noMatchTips() {
    switch (state.scopeMode) {
      case 'branches':
        return ['「ブランチ選択…」で対象のブランチを増やしてみてください。'];
      case 'history':
        return [
          `さかのぼるのは直近 ${historyMaxCommits} コミットまでです（設定で変えられます）。`,
          '「すべての ref をさかのぼる」を有効にすると範囲が広がります。',
        ];
      case 'chat':
        return [
          '「全プロジェクトの会話を対象にする」を試してください。',
          '「ツール結果」も対象に含めると見つかることがあります。',
          '会話ログは既定 30 日で消えます（Claude Code の cleanupPeriodDays）。',
        ];
      case 'trace':
        return [
          '語を短くすると当たりやすくなります（自動の再検索でも見つかりませんでした）。',
          '上のパイプラインで、どの段が空振りしたか確認できます。',
        ];
      default:
        return ['「⋯」の 含める / 除外する で絞り込みすぎていないか確認してください。'];
    }
  }

  function setStatus(text, isBusy) {
    busy = isBusy;
    el.status.textContent = text;
    el.status.classList.toggle('busy', isBusy);
  }

  // ---------------------------------------------------------------- パイプライン

  const STAGE_MARK = { pending: '○', running: '◐', done: '●', skipped: '○', error: '×' };
  const STAGE_TEXT = {
    pending: '待機中',
    running: '実行中',
    done: '完了',
    skipped: '実行しませんでした',
    error: 'エラー',
  };

  /**
   * 各段を縦に並べ、上から下へ流れていることをレールで示す。
   * 走る前から全段を出しておくのが肝で、「あと何が残っているか」が待ち時間の説明になる。
   */
  function renderPipeline() {
    // 1 段だけの検索は状態行で足りる。進捗が出せるとき (ブランチ横断) だけは見せる。
    const worth = stages.length >= 2 || stages.some((s) => s.progress !== undefined);
    if (!worth) {
      el.pipeline.classList.add('hidden');
      el.pipeline.textContent = '';
      return;
    }
    const frag = document.createDocumentFragment();
    for (const s of stages) {
      frag.appendChild(renderStage(s));
    }
    el.pipeline.textContent = '';
    el.pipeline.appendChild(frag);
    el.pipeline.classList.remove('hidden');
  }

  function renderStage(s) {
    const row = document.createElement('div');
    row.className = 'stage s-' + s.status;

    const rail = document.createElement('span');
    rail.className = 'rail';
    span(rail, 'dot', STAGE_MARK[s.status] || '○');
    row.appendChild(rail);

    const body = document.createElement('span');
    body.className = 'body';
    const head = document.createElement('span');
    head.className = 'head';
    span(head, 'ico', s.icon);
    span(head, 'lbl', s.label);
    span(head, 'val', stageValue(s));
    body.appendChild(head);

    if (s.note) {
      span(body, 'note', s.note);
    }
    if (s.status === 'running' && s.progress !== undefined) {
      const bar = document.createElement('span');
      bar.className = 'bar';
      const fill = document.createElement('i');
      fill.style.width = Math.round(s.progress * 100) + '%';
      bar.appendChild(fill);
      body.appendChild(bar);
    }
    row.appendChild(body);

    const took = s.durationMs !== undefined ? ` · ${s.durationMs}ms` : '';
    row.title = `${s.label} — ${STAGE_TEXT[s.status] || s.status}${took}`;
    return row;
  }

  function stageValue(s) {
    if (s.status === 'pending') {
      return '';
    }
    if (s.status === 'skipped' || s.status === 'error') {
      return '—';
    }
    return `${s.count} 件`;
  }

  /** 中断したときは、走らなかった段をそのまま残さず畳む。 */
  function settleStages() {
    let changed = false;
    for (const s of stages) {
      if (s.status === 'pending' || s.status === 'running') {
        s.status = 'skipped';
        s.note = s.note || '中断しました';
        changed = true;
      }
    }
    if (changed) {
      renderPipeline();
    }
  }

  function clearPipeline() {
    stages = [];
    stagesId = -1;
    renderPipeline();
  }

  // ---------------------------------------------------------------- 結果の蓄積

  /**
   * ヒットをまとめる単位を決める。
   * - コミット: コミット単位 (「そのとき一緒に何が入ったか」が 1 グループに並ぶ)
   * - 会話ログ: セッション単位
   * - それ以外: ref + ファイル単位
   */
  function groupKeyOf(h) {
    const o = h.origin;
    if (o && o.kind === 'commit') {
      return 'c\u0000' + o.sha;
    }
    if (o && o.kind === 'chat') {
      return 'h\u0000' + o.sessionFile;
    }
    return 'f\u0000' + (h.ref === null ? '' : h.ref) + '\u0000' + h.file;
  }

  function makeGroup(h) {
    const o = h.origin;
    if (o && o.kind === 'commit') {
      return { kind: 'commit', origin: o, ref: h.ref, file: h.file, hits: [], collapsed: false };
    }
    if (o && o.kind === 'chat') {
      return { kind: 'chat', origin: o, ref: null, file: h.file, hits: [], collapsed: false };
    }
    return { kind: 'file', origin: null, ref: h.ref, file: h.file, hits: [], collapsed: false };
  }

  function addHits(hits) {
    for (const h of hits) {
      flatHits.push(h);
      const key = groupKeyOf(h);
      let g = groupIndex.get(key);
      if (!g) {
        g = makeGroup(h);
        groupIndex.set(key, g);
        groups.push(g);
      }
      g.hits.push(h);
    }
    rowsDirty = true;
    scheduleRender();
  }

  function rebuildRows() {
    rows = [];
    rowOfHit = new Map();
    for (const g of groups) {
      // ヒット行にも見出しの位置を持たせておく (固定ヘッダと ← キーで使う)。
      const headerIndex = rows.length;
      rows.push({ kind: 'group', group: g, headerIndex });
      if (g.collapsed) {
        continue;
      }
      for (const h of g.hits) {
        rowOfHit.set(h.id, rows.length);
        rows.push({ kind: 'hit', hit: h, group: g, headerIndex });
      }
    }
    rowsDirty = false;
    if (selected >= rows.length) {
      selected = rows.length - 1;
    }
    el.spacer.style.height = rows.length * ROW_H + 'px';
    el.empty.classList.toggle('hidden', rows.length > 0);
    el.hint.classList.toggle('hidden', rows.length === 0);
  }

  // ---------------------------------------------------------------- 仮想リスト

  function scheduleRender() {
    if (renderScheduled) {
      return;
    }
    renderScheduled = true;
    requestAnimationFrame(() => {
      renderScheduled = false;
      render();
    });
  }

  function render() {
    if (rowsDirty) {
      rebuildRows();
    }
    const scrollTop = el.list.scrollTop;
    const height = el.list.clientHeight || 400;
    const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
    const last = Math.min(rows.length, Math.ceil((scrollTop + height) / ROW_H) + OVERSCAN);

    const frag = document.createDocumentFragment();
    for (let i = first; i < last; i++) {
      frag.appendChild(renderRow(rows[i], i));
    }
    el.rows.textContent = '';
    el.rows.appendChild(frag);
    el.rows.style.transform = `translateY(${first * ROW_H}px)`;
    updateSticky();
  }

  /** 上端に流れ去った見出しを貼り付けておく。どのファイル/コミット/セッションの中かを見失わないため。 */
  function updateSticky() {
    const firstVisible = Math.floor(el.list.scrollTop / ROW_H);
    const row = rows[firstVisible];
    if (!row || row.headerIndex >= firstVisible) {
      hideSticky();
      return;
    }
    stickyIndex = row.headerIndex;
    if (stickyGroup === row.group && stickyCount === row.group.hits.length) {
      return;
    }
    stickyGroup = row.group;
    stickyCount = row.group.hits.length;
    el.sticky.textContent = '';
    renderGroupRow(el.sticky, row.group);
    el.sticky.classList.remove('hidden');
  }

  function hideSticky() {
    stickyIndex = -1;
    if (stickyGroup === null) {
      return;
    }
    stickyGroup = null;
    stickyCount = -1;
    el.sticky.textContent = '';
    el.sticky.classList.add('hidden');
  }

  function span(parent, cls, text) {
    const s = document.createElement('span');
    s.className = cls;
    s.textContent = text;
    parent.appendChild(s);
    return s;
  }

  function shortDate(iso) {
    if (!iso) {
      return '';
    }
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) {
      return '';
    }
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  const BLOCK_LABEL = { text: '発言', thinking: '思考', tool_use: 'ツール', tool_result: '結果' };

  /**
   * 出所の印。1 つの検索語が 4 つの出所から返ってくるのがこの拡張機能の肝なので、
   * どの見出しにも同じ位置・同じ幅で出して、混ざった一覧が一目で読めるようにする。
   */
  const SOURCE_MARK = {
    worktree: ['📄', 'ワーキングツリー'],
    ref: ['🌿', 'ブランチ'],
    commit: ['◆', '履歴 (コミット)'],
    blame: ['📍', 'blame — この行を最後に触ったコミット'],
    chat: ['💬', '会話ログ'],
  };

  function sourceOf(g) {
    if (g.kind === 'commit') {
      return g.origin.blame ? 'blame' : 'commit';
    }
    if (g.kind === 'chat') {
      return 'chat';
    }
    return g.ref ? 'ref' : 'worktree';
  }

  function renderGroupRow(div, g) {
    span(div, 'twist', g.collapsed ? '▶' : '▼');
    const source = sourceOf(g);
    const [mark, sourceLabel] = SOURCE_MARK[source];
    span(div, 'src s-' + source, mark).title = sourceLabel;

    if (g.kind === 'commit') {
      const o = g.origin;
      // blame は「その行を最後に触ったコミット」で、履歴検索の結果とは意味が違うので区別する。
      span(div, 'name', o.shortSha);
      span(div, 'dir', o.blame ? `最後に触ったコミット — ${o.subject}` : o.subject || '(件名なし)');
      span(div, 'ref', `${shortDate(o.date)} ${o.author}`);
      div.title = `${sourceLabel}\n${o.sha}\n${o.subject}\n${o.author} · ${o.date}`;
    } else if (g.kind === 'chat') {
      const o = g.origin;
      span(div, 'name', shortDate(o.date) || 'セッション');
      span(div, 'dir', o.isSidechain ? 'サブエージェント' : o.project);
      if (o.gitBranch) {
        span(div, 'ref', o.gitBranch);
      }
      div.title = `${sourceLabel}\n${o.sessionFile}\nプロジェクト: ${o.project}\n作業ディレクトリ: ${o.cwd}`;
    } else {
      const slash = g.file.lastIndexOf('/');
      span(div, 'name', slash >= 0 ? g.file.slice(slash + 1) : g.file);
      if (slash >= 0) {
        span(div, 'dir', g.file.slice(0, slash));
      }
      if (g.ref) {
        span(div, 'ref', g.ref);
      }
      div.title = `${sourceLabel}\n${g.ref ? g.ref + ' : ' : ''}${g.file}`;
    }
    span(div, 'count', String(g.hits.length));
  }

  function renderRow(row, index) {
    const div = document.createElement('div');
    div.className = 'r ' + (row.kind === 'group' ? 'r-file' : 'r-hit');
    div.dataset.index = String(index);
    if (index === selected) {
      div.classList.add('sel');
    }

    if (row.kind === 'group') {
      renderGroupRow(div, row.group);
    } else {
      const h = row.hit;
      const o = h.origin;

      if (o && o.kind === 'commit') {
        if (!o.blame) {
          // 追加された行か、消された行かが一目で分かるようにする。
          const mark = span(div, 'ln ' + (o.change === '+' ? 'add' : 'del'), o.change);
          mark.title = o.change === '+' ? 'このコミットで追加' : 'このコミットで削除';
        }
        span(div, 'ln', `${h.file.split('/').pop()}:${h.line}`).title = h.file;
      } else if (o && o.kind === 'chat') {
        const who = o.role === 'user' ? '👤' : '🤖';
        const kind = o.block === 'tool_use' && o.tool ? o.tool : BLOCK_LABEL[o.block] || o.block;
        span(div, 'ln', `${who}${kind}`).title = `${o.role} / ${o.block}${o.tool ? ' / ' + o.tool : ''}`;
      } else {
        span(div, 'ln', String(h.line));
      }

      const tx = document.createElement('span');
      tx.className = 'tx';
      appendHighlighted(tx, h.text, h.matches);
      div.appendChild(tx);
      div.title = h.text.trim();
    }
    return div;
  }

  /** 行テキストを、一致部分だけ <span class="hl"> で包みつつ追加する (innerHTML は使わない)。 */
  function appendHighlighted(parent, text, matches) {
    const trimmed = text.replace(/^[ \t]+/, '');
    const shift = text.length - trimmed.length;
    let cursor = 0;
    for (const m of matches) {
      const start = m[0] - shift;
      const end = start + m[1];
      if (end <= 0 || start >= trimmed.length) {
        continue;
      }
      const s = Math.max(start, 0);
      if (s > cursor) {
        parent.appendChild(document.createTextNode(trimmed.slice(cursor, s)));
      }
      const hl = document.createElement('span');
      hl.className = 'hl';
      hl.textContent = trimmed.slice(s, Math.min(end, trimmed.length));
      parent.appendChild(hl);
      cursor = Math.min(end, trimmed.length);
    }
    if (cursor < trimmed.length) {
      parent.appendChild(document.createTextNode(trimmed.slice(cursor)));
    }
  }

  // ---------------------------------------------------------------- 選択と操作

  function select(index, reveal) {
    if (rowsDirty) {
      rebuildRows();
    }
    if (index < 0 || index >= rows.length) {
      return;
    }
    selected = index;
    if (reveal) {
      const top = index * ROW_H;
      // 貼り付いた見出しの下に潜り込まないよう、その分だけ上端を下げて考える。
      const pad = stickyIndex >= 0 && index !== stickyIndex ? ROW_H : 0;
      const viewTop = el.list.scrollTop + pad;
      const viewBottom = el.list.scrollTop + el.list.clientHeight;
      if (top < viewTop) {
        el.list.scrollTop = Math.max(0, top - pad);
      } else if (top + ROW_H > viewBottom) {
        el.list.scrollTop = top + ROW_H - el.list.clientHeight;
      }
    }
    scheduleRender();
  }

  function activate(index, focusEditor) {
    if (rowsDirty) {
      rebuildRows();
    }
    const row = rows[index];
    if (!row) {
      return;
    }
    select(index, true);
    if (row.kind === 'group') {
      row.group.collapsed = !row.group.collapsed;
      rowsDirty = true;
      scheduleRender();
    } else {
      vscode.postMessage({ type: 'open', id: row.hit.id, preview: !focusEditor, focus: focusEditor });
    }
  }

  function moveSelection(delta) {
    if (rowsDirty) {
      rebuildRows();
    }
    if (rows.length === 0) {
      return;
    }
    let next = selected < 0 ? (delta > 0 ? 0 : rows.length - 1) : selected + delta;
    next = Math.max(0, Math.min(rows.length - 1, next));
    select(next, true);
    const row = rows[next];
    if (row && row.kind === 'hit') {
      vscode.postMessage({ type: 'open', id: row.hit.id, preview: true, focus: false });
    }
  }

  /** ← : 開いている見出しは畳む。ヒットの上なら親の見出しへ戻る。 */
  function collapseOrGoToHeader() {
    if (rowsDirty) {
      rebuildRows();
    }
    const row = rows[selected];
    if (!row) {
      return;
    }
    if (row.kind === 'group' && !row.group.collapsed) {
      row.group.collapsed = true;
      rowsDirty = true;
      scheduleRender();
    } else {
      select(row.headerIndex, true);
    }
  }

  /** → : 畳んだ見出しは開く。開いているなら最初のヒットへ。 */
  function expandOrGoToFirstHit() {
    if (rowsDirty) {
      rebuildRows();
    }
    const row = rows[selected];
    if (!row || row.kind !== 'group') {
      return;
    }
    if (row.group.collapsed) {
      row.group.collapsed = false;
      rowsDirty = true;
      scheduleRender();
    } else {
      select(selected + 1, true);
    }
  }

  // ---------------------------------------------------------------- イベント

  el.query.addEventListener('input', () => {
    state.query = el.query.value;
    pushState();
    requestSearch(false);
  });

  el.query.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      requestSearch(true);
    } else if (e.key === 'Escape') {
      if (busy) {
        vscode.postMessage({ type: 'cancel' });
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveSelection(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveSelection(-1);
    } else if (e.altKey && (e.key === 'c' || e.key === 'C')) {
      e.preventDefault();
      toggleOption('isCaseSensitive', el.case);
    } else if (e.altKey && (e.key === 'w' || e.key === 'W')) {
      e.preventDefault();
      toggleOption('matchWholeWord', el.word);
    } else if (e.altKey && (e.key === 'r' || e.key === 'R')) {
      e.preventDefault();
      toggleOption('isRegex', el.regex);
    }
  });

  function toggleOption(key, button) {
    state[key] = !state[key];
    button.classList.toggle('on', state[key]);
    pushState();
    requestSearch(state.scopeMode === 'branches');
  }

  el.case.addEventListener('click', () => toggleOption('isCaseSensitive', el.case));
  el.word.addEventListener('click', () => toggleOption('matchWholeWord', el.word));
  el.regex.addEventListener('click', () => toggleOption('isRegex', el.regex));

  el.scope.addEventListener('change', () => {
    state.scopeMode = /** @type {any} */ (el.scope.value);
    pushState();
    updateScopeUi();
    if (state.scopeMode === 'branches' && state.selectedBranches.length === 0) {
      vscode.postMessage({ type: 'pickBranches' });
    } else {
      requestSearch(true);
    }
  });

  el.pickBranches.addEventListener('click', () => vscode.postMessage({ type: 'pickBranches' }));

  el.toggleAdvanced.addEventListener('click', () => {
    state.showAdvanced = !state.showAdvanced;
    el.advanced.classList.toggle('hidden', !state.showAdvanced);
    el.toggleAdvanced.classList.toggle('on', state.showAdvanced);
    pushState();
  });

  for (const [input, key] of /** @type {Array<[HTMLInputElement, string]>} */ ([
    [el.include, 'include'],
    [el.exclude, 'exclude'],
  ])) {
    input.addEventListener('input', () => {
      state[key] = input.value;
      pushState();
      requestSearch(false);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        requestSearch(true);
      }
    });
  }

  el.dedupe.addEventListener('change', () => {
    state.dedupe = el.dedupe.checked;
    pushState();
    requestSearch(true);
  });

  for (const [input, key] of /** @type {Array<[HTMLInputElement, string]>} */ ([
    [el.historyAllRefs, 'historyAllRefs'],
    [el.chatAllProjects, 'chatAllProjects'],
    [el.chatText, 'chatText'],
    [el.chatThinking, 'chatThinking'],
    [el.chatToolUse, 'chatToolUse'],
    [el.chatToolResult, 'chatToolResult'],
  ])) {
    input.addEventListener('change', () => {
      state[key] = input.checked;
      pushState();
      renderRepoLine();
      requestSearch(true);
    });
  }

  $('open-settings').addEventListener('click', (e) => {
    e.preventDefault();
    vscode.postMessage({ type: 'openSettings' });
  });
  $('show-log').addEventListener('click', (e) => {
    e.preventDefault();
    vscode.postMessage({ type: 'showLog' });
  });

  el.repoLine.addEventListener('click', () => {
    if (folders.length > 1) {
      vscode.postMessage({ type: 'pickFolder' });
    }
  });

  el.list.addEventListener('scroll', scheduleRender, { passive: true });

  el.list.addEventListener('mousedown', (e) => {
    const target = /** @type {HTMLElement} */ (e.target);
    const rowEl = target.closest('.r');
    if (!rowEl) {
      return;
    }
    const index = Number(/** @type {HTMLElement} */ (rowEl).dataset.index);
    activate(index, e.detail >= 2);
  });

  el.list.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveSelection(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveSelection(-1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      activate(selected, true);
    } else if (e.key === ' ') {
      e.preventDefault();
      activate(selected, false);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      collapseOrGoToHeader();
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      expandOrGoToFirstHit();
    } else if (e.key === 'Home') {
      e.preventDefault();
      select(0, true);
    } else if (e.key === 'End') {
      e.preventDefault();
      select(rows.length - 1, true);
    }
  });

  // 貼り付いた見出しをクリックしたら、その見出しの位置まで戻す。
  el.sticky.addEventListener('mousedown', (e) => {
    e.preventDefault();
    if (stickyIndex >= 0) {
      select(stickyIndex, true);
    }
  });

  // フォーカスがエディタへ移っても、どの行を開いたのかが分かるようにする。
  function setFocused(on) {
    document.body.classList.toggle('focused', on);
  }
  window.addEventListener('focus', () => setFocused(true));
  window.addEventListener('blur', () => setFocused(false));
  setFocused(document.hasFocus());

  window.addEventListener('resize', scheduleRender);

  // ---------------------------------------------------------------- 拡張機能からのメッセージ

  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'init': {
        state = { ...state, ...msg.state };
        repo = msg.repo;
        folders = msg.folders || [];
        debounceMs = (msg.config && msg.config.debounceMs) || 120;
        historyMaxCommits = (msg.config && msg.config.historyMaxCommits) || 300;
        if (
          (!repo.canBranchSearch && state.scopeMode === 'branches') ||
          (!repo.canHistorySearch && state.scopeMode === 'history')
        ) {
          state.scopeMode = 'worktree';
        }
        syncControlsFromState();
        if (rows.length === 0) {
          renderEmptyState();
          el.empty.classList.remove('hidden');
        }
        break;
      }
      case 'setState': {
        state = { ...state, ...msg.state };
        syncControlsFromState();
        break;
      }
      case 'branches': {
        updateScopeUi();
        break;
      }
      case 'stages': {
        // 段の登録は 'started' より先に届く (検索の開始と同時に組み立てるため)。
        if (msg.id < stagesId) {
          break;
        }
        stagesId = msg.id;
        stages = msg.stages || [];
        renderPipeline();
        break;
      }
      case 'started': {
        sessionId = msg.id;
        clearResults();
        if (stagesId !== msg.id) {
          clearPipeline();
        }
        el.empty.classList.add('hidden');
        setStatus('検索中…', true);
        break;
      }
      case 'batch': {
        if (msg.id !== sessionId) {
          break;
        }
        addHits(msg.hits);
        setStatus(`${flatHits.length} 件…`, true);
        break;
      }
      case 'done': {
        if (msg.id !== sessionId && msg.id !== -1) {
          break;
        }
        renderDone(msg.stats);
        break;
      }
      case 'cancelled': {
        settleStages();
        setStatus(`中断しました (${flatHits.length} 件)`, false);
        break;
      }
      case 'cleared': {
        clearResults();
        clearPipeline();
        break;
      }
      case 'current': {
        const hit = flatHits[msg.index];
        if (!hit) {
          break;
        }
        if (rowsDirty) {
          rebuildRows();
        }
        const rowIndex = rowOfHit.get(hit.id);
        if (rowIndex !== undefined) {
          select(rowIndex, true);
        }
        break;
      }
      case 'focus': {
        el.query.focus();
        el.query.select();
        break;
      }
      default:
        break;
    }
  });

  function renderDone(stats) {
    if (rowsDirty) {
      rebuildRows();
    }
    const bits = [];
    bits.push(`${stats.matches} 件`);
    if (stats.commits > 0) {
      bits.push(`${stats.commits} コミット`);
    } else if (stats.sessions > 0) {
      bits.push(`${stats.sessions} セッション`);
    }
    if (stats.commits === 0 && stats.sessions === 0) {
      bits.push(`${stats.files} ファイル`);
    }
    if (stats.refs > 0) {
      bits.push(`${stats.refs} ブランチ`);
    }
    if (stats.deduped > 0) {
      bits.push(`重複 ${stats.deduped} 件を集約`);
    }
    bits.push(`${stats.durationMs}ms`);
    if (stats.engine) {
      bits.push(stats.engine);
    }
    if (stats.truncated) {
      bits.push('上限で打ち切り');
    }
    setStatus(bits.join(' · '), false);
    el.status.title = bits.join(' · ');

    const messages = [...(stats.errors || []), ...(stats.warnings || [])];
    el.messages.textContent = '';
    if (messages.length > 0) {
      el.messages.classList.toggle('error', (stats.errors || []).length > 0);
      for (const m of messages.slice(0, 8)) {
        const d = document.createElement('div');
        d.textContent = m;
        el.messages.appendChild(d);
      }
      el.messages.classList.remove('hidden');
    } else {
      el.messages.classList.add('hidden');
    }
    el.empty.classList.toggle('hidden', rows.length > 0);
    el.hint.classList.toggle('hidden', rows.length === 0);
    if (rows.length === 0) {
      renderEmptyState();
    }
  }

  syncControlsFromState();
  vscode.postMessage({ type: 'ready' });
})();
