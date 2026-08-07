// media/main.js を最小の DOM スタブ上で走らせるスモークテスト。
// webview は VS Code の中でしか動かないので統合テストからも中身が見えない。
// 少なくとも「描画パスが例外を出さず、意図した構造になる」ことはここで押さえておく。
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const script = fs.readFileSync(path.join(root, 'media', 'main.js'), 'utf8');
// HTML は searchView.ts が組み立てるので、そこから id を抜いて要素を用意する。
const view = fs.readFileSync(path.join(root, 'src', 'ui', 'searchView.ts'), 'utf8');
const ids = [...view.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);

// ------------------------------------------------------------------ DOM スタブ

class El {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.style = {};
    this.dataset = {};
    this.classes = new Set();
    this.own = '';
    this.classList = {
      add: (...c) => c.forEach((x) => this.classes.add(x)),
      remove: (...c) => c.forEach((x) => this.classes.delete(x)),
      contains: (c) => this.classes.has(c),
      toggle: (c, on) => (on ? this.classes.add(c) : this.classes.delete(c)),
    };
  }
  set className(v) {
    this.classes = new Set(String(v).split(/\s+/).filter(Boolean));
  }
  get className() {
    return [...this.classes].join(' ');
  }
  set textContent(v) {
    this.own = String(v);
    this.children = [];
  }
  get textContent() {
    return this.children.length > 0 ? this.children.map((c) => c.textContent).join('') : this.own;
  }
  appendChild(c) {
    if (c.isFragment) {
      this.children.push(...c.children);
    } else {
      this.children.push(c);
    }
    return c;
  }
  addEventListener() {}
  querySelector() {
    return undefined;
  }
  closest() {
    return undefined;
  }
  get clientHeight() {
    return 400;
  }
  get scrollTop() {
    return this.scroll || 0;
  }
  set scrollTop(v) {
    this.scroll = v;
  }
  /** 失敗したときに構造が読めるように。 */
  dump(indent = '') {
    const cls = this.className ? `.${[...this.classes].join('.')}` : '';
    const text = this.children.length === 0 && this.own ? ` "${this.own}"` : '';
    return [`${indent}${this.tagName}${cls}${text}`, ...this.children.map((c) => c.dump(`${indent}  `))].join('\n');
  }
}

const el = new Map(ids.map((id) => [id, new El('div')]));
const listeners = {};
const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  requestAnimationFrame: (fn) => fn(),
  acquireVsCodeApi: () => ({ postMessage: () => {} }),
  document: {
    getElementById: (id) => el.get(id),
    createElement: (t) => new El(t),
    createDocumentFragment: () => Object.assign(new El('#fragment'), { isFragment: true }),
    createTextNode: (t) => Object.assign(new El('#text'), { own: t }),
    hasFocus: () => true,
    body: new El('body'),
  },
  window: {
    addEventListener: (name, fn) => ((listeners[name] ||= []).push(fn)),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
  },
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(script, sandbox, { filename: 'media/main.js' });

const send = (msg) => (listeners.message || []).forEach((fn) => fn({ data: msg }));

// ------------------------------------------------------------------ テスト

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL ${name}`);
    console.log(`       ${err instanceof Error ? err.message : String(err)}`);
  }
}

function assert(cond, message) {
  if (!cond) {
    throw new Error(message);
  }
}

function stage(key, status, over) {
  return { key, icon: '•', label: key, status, count: 0, ...over };
}

const pipeline = el.get('pipeline');
const empty = el.get('empty');
const rows = el.get('rows');

console.log('\nwebview (media/main.js)');

test('init: 選んだ対象の説明が出る', () => {
  send({
    type: 'init',
    state: { scopeMode: 'trace', query: '' },
    repo: { canBranchSearch: true, canHistorySearch: true, label: 'repo', chatSessions: 3, hint: '' },
    folders: [],
    config: { debounceMs: 120, historyMaxCommits: 300 },
  });
  assert(el.get('scope-hint').textContent.includes('blame'), el.get('scope-hint').textContent);
});

test('検索前の空状態に入口の案内が並ぶ', () => {
  assert(empty.textContent.includes('Ctrl+Alt+O'), empty.textContent);
});

test('検索前に 4 つの出所を見せる', () => {
  // 「1 つの語を 4 つの出所に投げる」が他の検索との違いなので、待っている間に見せる。
  for (const want of ['いま', 'ブランチ', '履歴', '会話ログ']) {
    assert(empty.textContent.includes(want), `"${want}" が出ていない: ${empty.textContent}`);
  }
  const sources = empty.children.find((c) => c.classes.has('empty-sources'));
  assert(sources !== undefined, `出所の一覧が無い\n${empty.dump()}`);
  assert(sources.children.length === 4, `出所の数 = ${sources.children.length}`);
});

test('パイプライン: plan した段がそのまま並ぶ', () => {
  send({ type: 'stages', id: 1, stages: [stage('blame', 'pending'), stage('history', 'pending'), stage('chat', 'pending')] });
  assert(!pipeline.classList.contains('hidden'), 'パイプラインが隠れている');
  assert(pipeline.children.length === 3, `段数 = ${pipeline.children.length}`);
});

test('パイプライン: started より先に届いても消えない', () => {
  // 段の登録は検索開始と同時に走るので 'started' より先に届く。
  send({ type: 'started', id: 1, scopeMode: 'trace' });
  assert(pipeline.children.length === 3, `started 後の段数 = ${pipeline.children.length}`);
});

test('パイプライン: 完了 / 実行中 / スキップを描き分ける', () => {
  send({
    type: 'stages',
    id: 1,
    stages: [
      stage('blame', 'done', { count: 1, durationMs: 12 }),
      stage('history', 'running', { count: 4, note: '"foo" で再検索中' }),
      stage('chat', 'skipped', { note: 'git 管理外' }),
    ],
  });
  const cls = pipeline.children.map((c) => c.className);
  assert(cls[0].includes('s-done') && cls[1].includes('s-running') && cls[2].includes('s-skipped'), cls.join(' | '));
  for (const want of ['1 件', '4 件', '再検索中', 'git 管理外']) {
    assert(pipeline.textContent.includes(want), `"${want}" が出ていない: ${pipeline.textContent}`);
  }
});

test('パイプライン: 1 段だけなら出さない (状態行で足りる)', () => {
  send({ type: 'stages', id: 2, stages: [stage('worktree', 'running')] });
  assert(pipeline.classList.contains('hidden'), '1 段でも出ている');
});

test('パイプライン: 進捗が出せる 1 段は見せる', () => {
  send({ type: 'stages', id: 3, stages: [stage('refs', 'running', { count: 8, progress: 0.35, note: '7/20 ブランチ' })] });
  assert(!pipeline.classList.contains('hidden'), '進捗付きでも隠れている');
  assert(pipeline.textContent.includes('7/20 ブランチ'), pipeline.textContent);
});

test('パイプライン: 中断で走らなかった段が畳まれる', () => {
  send({ type: 'started', id: 4 });
  send({ type: 'stages', id: 4, stages: [stage('a', 'done', { count: 2 }), stage('b', 'running'), stage('c', 'pending')] });
  send({ type: 'cancelled' });
  const cls = pipeline.children.map((c) => c.className);
  assert(cls[1].includes('s-skipped') && cls[2].includes('s-skipped'), cls.join(' | '));
  assert(pipeline.textContent.includes('中断しました'), pipeline.textContent);
});

test('結果一覧: ファイルごとの見出しの下にヒットが並ぶ', () => {
  send({ type: 'started', id: 5 });
  send({
    type: 'batch',
    id: 5,
    hits: [
      { id: 0, ref: null, file: 'src/a.ts', line: 3, col: 1, len: 6, text: '  const needle = 1;', matches: [[8, 6]] },
      { id: 1, ref: null, file: 'src/a.ts', line: 9, col: 1, len: 6, text: '  needle();', matches: [[2, 6]] },
      { id: 2, ref: null, file: 'src/b.ts', line: 1, col: 1, len: 6, text: 'needle', matches: [[0, 6]] },
    ],
  });
  send({
    type: 'done',
    id: 5,
    stats: { matches: 3, files: 2, refs: 0, commits: 0, sessions: 0, durationMs: 8, truncated: false, deduped: 0, warnings: [], errors: [], engine: 'ripgrep' },
  });
  const kinds = rows.children.map((c) => (c.classList.contains('r-file') ? 'G' : 'h')).join('');
  assert(kinds === 'GhhGh', `${kinds}\n${rows.dump()}`);
  assert(!el.get('hint').classList.contains('hidden'), '操作ヒントが出ていない');
});

test('結果一覧: 一致部分が hl で包まれる', () => {
  const hit = rows.children[1];
  const marked = [];
  const walk = (n) => {
    if (n.classes.has('hl')) marked.push(n.textContent);
    n.children.forEach(walk);
  };
  walk(hit);
  assert(marked.join(',') === 'needle', `${marked.join(',')}\n${hit.dump()}`);
});

test('結果一覧: 見出しに出所の印が付き、出所ごとに変わる', () => {
  const chat = { kind: 'chat', project: 'p', cwd: '', gitBranch: '', sessionId: 's', sessionFile: '/s.jsonl', uuid: 'u', entryIndex: 0, withToolResults: false, role: 'user', block: 'text', date: '2026-08-01T00:00:00Z', isSidechain: false };
  const commit = { kind: 'commit', sha: 'abc123def', shortSha: 'abc123d', author: 'a', date: '2026-08-01T00:00:00Z', subject: 's', change: '+' };
  const hit = (id, over) => ({ id, ref: null, file: 'src/a.ts', line: 1, col: 1, len: 1, text: 'x', matches: [[0, 1]], ...over });

  send({ type: 'started', id: 7 });
  send({
    type: 'batch',
    id: 7,
    hits: [
      hit(0),
      hit(1, { ref: 'origin/dev', file: 'src/b.ts' }),
      hit(2, { ref: 'abc123def', origin: commit }),
      hit(3, { ref: 'def456', origin: { ...commit, sha: 'def456abc', shortSha: 'def456a', blame: true } }),
      hit(4, { file: '/s.jsonl', origin: chat }),
    ],
  });
  send({ type: 'done', id: 7, stats: { matches: 5, files: 5, refs: 0, commits: 2, sessions: 1, durationMs: 1, truncated: false, deduped: 0, warnings: [], errors: [], engine: 'trace' } });

  const marks = rows.children
    .filter((r) => r.classes.has('r-file'))
    .map((r) => {
      const src = r.children.find((c) => c.classes.has('src'));
      return src ? `${[...src.classes].filter((c) => c.startsWith('s-')).join('')}=${src.textContent}` : '?';
    });
  assert(
    marks.join(' ') === 's-worktree=📄 s-ref=🌿 s-commit=◆ s-blame=📍 s-chat=💬',
    `${marks.join(' ')}\n${rows.dump()}`,
  );
});

test('一致なし: 対象ごとの次の一手を出す', () => {
  send({
    type: 'init',
    state: { scopeMode: 'chat', query: 'zzz' },
    repo: { canBranchSearch: false, canHistorySearch: false, label: '', chatSessions: 0, hint: '' },
    folders: [],
    config: {},
  });
  send({ type: 'started', id: 6 });
  send({
    type: 'done',
    id: 6,
    stats: { matches: 0, files: 0, refs: 0, commits: 0, sessions: 0, durationMs: 3, truncated: false, deduped: 0, warnings: [], errors: [], engine: '会話ログ' },
  });
  assert(empty.textContent.includes('一致はありません'), empty.textContent);
  assert(empty.textContent.includes('全プロジェクト'), empty.textContent);
});

console.log(`\n${passed} 件成功 / ${failed} 件失敗`);
process.exit(failed > 0 ? 1 : 0);
