// 履歴検索 (pickaxe) と会話ログ検索のテスト。suite.ts から呼ばれる。
import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

import { chatTargetLine, renderSession } from '../src/chat/chatDocument';
import {
  type ChatEntry,
  clearTranscriptCache,
  encodeProjectDir,
  extractEntries,
  listTranscripts,
  loadSession,
  transcriptsForWorkspace,
} from '../src/chat/transcriptStore';
import { blameLine, parseBlamePorcelain } from '../src/git/gitService';
import { searchChat, selectTranscripts } from '../src/search/chatProvider';
import { buildPickaxeArgs, parseHunkHeader, searchHistory } from '../src/search/pickaxeProvider';
import type { HitSink, SearchHit, SearchOptions } from '../src/types';
import { extractSymbol } from '../src/util/symbol';

export interface Harness {
  test(name: string, fn: () => void | Promise<void>): Promise<void>;
  repo: string;
  makeOptions(over?: Partial<SearchOptions>): SearchOptions;
  collector(): { hits: SearchHit[]; warnings: string[]; errors: string[]; sink: HitSink };
  noCancel(): vscode.CancellationToken;
  counter(): () => number;
}

// ------------------------------------------------------------------ 会話ログのフィクスチャ

interface FakeRecord {
  type: string;
  uuid: string;
  parentUuid?: string;
  sessionId: string;
  timestamp: string;
  cwd: string;
  gitBranch: string;
  isSidechain?: boolean;
  message: { role: string; content: unknown };
}

function record(over: Partial<FakeRecord> & { message: FakeRecord['message']; type: string }): FakeRecord {
  return {
    uuid: `uuid-${Math.abs(hash(JSON.stringify(over.message)))}`,
    sessionId: 'session-1',
    timestamp: '2026-08-01T10:00:00.000Z',
    cwd: 'C:\\work\\demo',
    gitBranch: 'main',
    ...over,
  } as FakeRecord;
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return h;
}

/** 実物と同じ形の transcript を作る (~/.claude/projects/<encoded>/<session>.jsonl)。 */
export function makeFakeTranscripts(root: string, workspacePath: string): { projectDir: string; sessionFile: string } {
  const projectDir = path.join(root, 'projects', encodeProjectDir(workspacePath));
  fs.mkdirSync(projectDir, { recursive: true });

  const records: FakeRecord[] = [
    record({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: '認証は合言葉方式で作ってください。' }] },
    }),
    record({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '合言葉方式だと有効期限の扱いが曖昧なので 24 時間にしておく。', signature: 'x' },
          { type: 'text', text: '合言葉は 24 時間で失効する仕様にしました。' },
          {
            type: 'tool_use',
            name: 'Write',
            input: { file_path: 'src/auth.ts', content: 'export const PASSPHRASE_TTL_HOURS = 24;\n' },
          },
        ],
      },
    }),
    record({
      type: 'assistant',
      uuid: 'uuid-toolresult',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', content: 'File written: src/auth.ts (合言葉)' }],
      },
    }),
    // 検索対象外であるべきレコード。
    record({ type: 'ai-title', message: { role: 'assistant', content: [{ type: 'text', text: '合言葉タイトル' }] } }),
  ];

  const sessionFile = path.join(projectDir, 'session-1.jsonl');
  fs.writeFileSync(sessionFile, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');

  // サブエージェントの会話は UUID のサブディレクトリに置かれる。
  const subDir = path.join(projectDir, '0014f510-367d-4801-8c3f-006ae3a941ea');
  fs.mkdirSync(subDir, { recursive: true });
  fs.writeFileSync(
    path.join(subDir, 'sub.jsonl'),
    JSON.stringify(
      record({
        type: 'assistant',
        sessionId: 'session-sub',
        isSidechain: true,
        message: { role: 'assistant', content: [{ type: 'text', text: 'サブエージェントも合言葉に触れた。' }] },
      }),
    ) + '\n',
    'utf8',
  );

  // 別プロジェクトの会話。
  const otherDir = path.join(root, 'projects', 'c--other-project');
  fs.mkdirSync(otherDir, { recursive: true });
  fs.writeFileSync(
    path.join(otherDir, 'other.jsonl'),
    JSON.stringify(
      record({
        type: 'user',
        sessionId: 'session-other',
        cwd: 'C:\\work\\other',
        message: { role: 'user', content: [{ type: 'text', text: '別プロジェクトでも合言葉と書いた。' }] },
      }),
    ) + '\n',
    'utf8',
  );

  return { projectDir, sessionFile };
}

// ------------------------------------------------------------------ テスト本体

export async function run(h: Harness, tmpRoot: string): Promise<void> {
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: h.repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

  console.log('\nsearch/pickaxeProvider (引数とパース)');
  await h.test('buildPickaxeArgs: 固定文字列なら -S、正規表現なら -G', () => {
    const fixed = buildPickaxeArgs(h.makeOptions(), { allRefs: true, maxCommits: 50 });
    assert.ok(fixed.includes('-Sneedle'), fixed.join(' '));
    assert.ok(fixed.includes('--all'));
    assert.ok(fixed.includes('--max-count=50'));
    assert.ok(fixed.includes('--regexp-ignore-case'));

    const re = buildPickaxeArgs(h.makeOptions({ isRegex: true, isCaseSensitive: true }), {
      allRefs: false,
      maxCommits: 10,
    });
    assert.ok(re.includes('-Gneedle'), re.join(' '));
    assert.ok(!re.includes('--all'));
    assert.ok(!re.includes('--regexp-ignore-case'));
  });

  await h.test('parseHunkHeader: 新旧の開始行を読む', () => {
    assert.deepEqual(parseHunkHeader('@@ -12,3 +14,5 @@ func()'), { oldStart: 12, newStart: 14 });
    assert.deepEqual(parseHunkHeader('@@ -0,0 +1 @@'), { oldStart: 0, newStart: 1 });
    assert.equal(parseHunkHeader('+ not a hunk'), undefined);
  });

  console.log('\nsearch/pickaxeProvider (実 git)');

  // 履歴を作る: 追加 -> 削除。
  fs.writeFileSync(path.join(h.repo, 'src', 'history.ts'), 'const spellword = "追加された合言葉";\n', 'utf8');
  git('add', '-A');
  git('commit', '-qm', 'spellword を追加');
  const addedSha = git('rev-parse', 'HEAD').trim();
  fs.writeFileSync(path.join(h.repo, 'src', 'history.ts'), 'const other = 1;\n', 'utf8');
  git('add', '-A');
  git('commit', '-qm', 'spellword を削除');
  const removedSha = git('rev-parse', 'HEAD').trim();

  await h.test('searchHistory: 追加されたコミットと削除されたコミットを両方見つける', async () => {
    const c = h.collector();
    await searchHistory(
      h.repo,
      h.makeOptions({ query: 'spellword' }),
      { allRefs: true, maxCommits: 100 },
      c.sink,
      h.noCancel(),
      h.counter(),
    );
    const shas = new Set(c.hits.map((x) => (x.origin as any).sha));
    assert.ok(shas.has(addedSha), `追加コミットが無い: ${JSON.stringify([...shas])}`);
    assert.ok(shas.has(removedSha), `削除コミットが無い: ${JSON.stringify([...shas])}`);
    assert.equal(c.errors.length, 0, c.errors.join(' / '));
  });

  await h.test('searchHistory: 追加行は +、削除行は - として記録される', async () => {
    const c = h.collector();
    await searchHistory(
      h.repo,
      h.makeOptions({ query: 'spellword' }),
      { allRefs: true, maxCommits: 100 },
      c.sink,
      h.noCancel(),
      h.counter(),
    );
    const added = c.hits.find((x) => (x.origin as any).sha === addedSha)!;
    const removed = c.hits.find((x) => (x.origin as any).sha === removedSha)!;
    assert.equal((added.origin as any).change, '+');
    assert.equal((removed.origin as any).change, '-');
    // 削除行は親の版を開くので ref に ^ が付く。
    assert.equal(added.ref, addedSha);
    assert.equal(removed.ref, `${removedSha}^`);
  });

  await h.test('searchHistory: コミットのメタ情報が取れる', async () => {
    const c = h.collector();
    await searchHistory(
      h.repo,
      h.makeOptions({ query: 'spellword' }),
      { allRefs: true, maxCommits: 100 },
      c.sink,
      h.noCancel(),
      h.counter(),
    );
    const o = c.hits.find((x) => (x.origin as any).sha === addedSha)!.origin as any;
    assert.equal(o.subject, 'spellword を追加');
    assert.equal(o.author, 'Test');
    assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(o.date), `日付が ISO8601 でない: ${o.date}`);
    assert.equal(o.shortSha, addedSha.slice(0, o.shortSha.length));
  });

  await h.test('searchHistory: ファイルと行番号が正しい', async () => {
    const c = h.collector();
    await searchHistory(
      h.repo,
      h.makeOptions({ query: 'spellword' }),
      { allRefs: true, maxCommits: 100 },
      c.sink,
      h.noCancel(),
      h.counter(),
    );
    const added = c.hits.find((x) => (x.origin as any).sha === addedSha)!;
    assert.equal(added.file, 'src/history.ts');
    assert.equal(added.line, 1);
    const blob = execFileSync('git', ['show', `${addedSha}:src/history.ts`], { cwd: h.repo, encoding: 'utf8' });
    const line = blob.split('\n')[added.line - 1];
    assert.equal(line.slice(added.col - 1, added.col - 1 + added.len), 'spellword');
  });

  await h.test('searchHistory: 検索語を含まない行は結果に混ざらない', async () => {
    const c = h.collector();
    await searchHistory(
      h.repo,
      h.makeOptions({ query: 'spellword' }),
      { allRefs: true, maxCommits: 100 },
      c.sink,
      h.noCancel(),
      h.counter(),
    );
    assert.ok(c.hits.length > 0);
    assert.ok(
      c.hits.every((x) => x.text.includes('spellword')),
      JSON.stringify(c.hits.map((x) => x.text)),
    );
  });

  await h.test('searchHistory: git 管理外の語はヒットしない', async () => {
    const c = h.collector();
    await searchHistory(
      h.repo,
      h.makeOptions({ query: 'zzz_never_committed_zzz' }),
      { allRefs: true, maxCommits: 100 },
      c.sink,
      h.noCancel(),
      h.counter(),
    );
    assert.equal(c.hits.length, 0);
    assert.equal(c.errors.length, 0);
  });

  // ---------------------------------------------------------------- 会話ログ

  console.log('\nchat/transcriptStore');

  const claudeHome = path.join(tmpRoot, 'claude-home');
  const workspacePath = 'C:\\work\\demo';
  const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = claudeHome;
  const { sessionFile } = makeFakeTranscripts(claudeHome, workspacePath);
  clearTranscriptCache();

  await h.test('encodeProjectDir: パス区切りを - に置き換える', () => {
    assert.equal(encodeProjectDir('C:\\work\\demo'), 'C--work-demo');
    assert.equal(encodeProjectDir('/home/me/proj'), '-home-me-proj');
  });

  await h.test('listTranscripts: サブディレクトリのサブエージェント会話も拾う', () => {
    const all = listTranscripts();
    const names = all.map((t) => path.basename(t.file)).sort();
    assert.deepEqual(names, ['other.jsonl', 'session-1.jsonl', 'sub.jsonl'], JSON.stringify(names));
  });

  await h.test('transcriptsForWorkspace: 現在のプロジェクトだけに絞る', () => {
    const mine = transcriptsForWorkspace(workspacePath, listTranscripts());
    assert.equal(mine.length, 2, JSON.stringify(mine.map((t) => t.file)));
    assert.ok(mine.every((t) => !t.file.includes('other-project')));
  });

  await h.test('extractEntries: ブロック種別ごとに取り出す', () => {
    const raw = fs.readFileSync(sessionFile, 'utf8').split('\n').filter(Boolean);
    const assistant = JSON.parse(raw[1]);
    const withoutResult = extractEntries(assistant, 2, false);
    assert.deepEqual(
      withoutResult.map((e) => e.block),
      ['thinking', 'text', 'tool_use'],
    );
    assert.equal(withoutResult[2].tool, 'Write');
    assert.ok(withoutResult[2].text.includes('PASSPHRASE_TTL_HOURS'));
  });

  await h.test('extractEntries: tool_result は既定で除外される', () => {
    const raw = fs.readFileSync(sessionFile, 'utf8').split('\n').filter(Boolean);
    const toolResult = JSON.parse(raw[2]);
    assert.equal(extractEntries(toolResult, 3, false).length, 0);
    assert.equal(extractEntries(toolResult, 3, true).length, 1);
  });

  await h.test('extractEntries: user/assistant 以外の type は無視する', () => {
    const raw = fs.readFileSync(sessionFile, 'utf8').split('\n').filter(Boolean);
    assert.equal(extractEntries(JSON.parse(raw[3]), 4, true).length, 0);
  });

  await h.test('loadSession: 通し番号が振られる', async () => {
    const entries = await loadSession(sessionFile, false);
    assert.deepEqual(
      entries.map((e) => e.index),
      entries.map((_, i) => i),
    );
  });

  console.log('\nsearch/chatProvider');

  const chatScope = (over: Partial<{ allProjects: boolean; toolResult: boolean }> = {}) => ({
    allProjects: over.allProjects ?? false,
    workspacePath,
    blocks: { text: true, thinking: true, toolUse: true, toolResult: over.toolResult ?? false },
  });

  await h.test('selectTranscripts: 全プロジェクト指定で他プロジェクトも含む', () => {
    const all = listTranscripts();
    assert.equal(selectTranscripts(chatScope(), all).length, 2);
    assert.equal(selectTranscripts(chatScope({ allProjects: true }), all).length, 3);
  });

  await h.test('searchChat: 発言・思考・ツール引数を横断して見つける', async () => {
    const c = h.collector();
    await searchChat(chatScope(), h.makeOptions({ query: '合言葉' }), c.sink, h.noCancel(), h.counter());
    const blocks = new Set(c.hits.map((x) => (x.origin as any).block));
    assert.ok(blocks.has('text'), JSON.stringify([...blocks]));
    assert.ok(blocks.has('thinking'), JSON.stringify([...blocks]));
    assert.ok(!blocks.has('tool_result'), 'tool_result が既定で含まれている');
  });

  await h.test('searchChat: 一致位置が本文に対して正しい', async () => {
    const c = h.collector();
    await searchChat(chatScope(), h.makeOptions({ query: '合言葉' }), c.sink, h.noCancel(), h.counter());
    assert.ok(c.hits.length > 0);
    for (const hit of c.hits) {
      assert.equal(hit.text.slice(hit.matches[0][0], hit.matches[0][0] + hit.matches[0][1]), '合言葉');
    }
  });

  await h.test('searchChat: 出所メタ (プロジェクト・ブランチ・役割) が入る', async () => {
    const c = h.collector();
    await searchChat(chatScope(), h.makeOptions({ query: '合言葉' }), c.sink, h.noCancel(), h.counter());
    const o = c.hits[0].origin as any;
    assert.equal(o.kind, 'chat');
    assert.equal(o.gitBranch, 'main');
    assert.equal(o.cwd, workspacePath);
    assert.ok(['user', 'assistant'].includes(o.role));
    assert.ok(typeof o.entryIndex === 'number' && o.entryIndex >= 0);
  });

  await h.test('searchChat: ツール引数 (Write の中身) を検索できる', async () => {
    const c = h.collector();
    await searchChat(chatScope(), h.makeOptions({ query: 'PASSPHRASE_TTL_HOURS' }), c.sink, h.noCancel(), h.counter());
    assert.equal(c.hits.length, 1, JSON.stringify(c.hits));
    assert.equal((c.hits[0].origin as any).block, 'tool_use');
    assert.equal((c.hits[0].origin as any).tool, 'Write');
  });

  await h.test('searchChat: tool_result は有効にしたときだけ出る', async () => {
    const off = h.collector();
    await searchChat(chatScope(), h.makeOptions({ query: 'File written' }), off.sink, h.noCancel(), h.counter());
    assert.equal(off.hits.length, 0);

    const on = h.collector();
    await searchChat(
      chatScope({ toolResult: true }),
      h.makeOptions({ query: 'File written' }),
      on.sink,
      h.noCancel(),
      h.counter(),
    );
    assert.equal(on.hits.length, 1);
  });

  await h.test('searchChat: サブエージェントの会話も対象になる', async () => {
    const c = h.collector();
    await searchChat(chatScope(), h.makeOptions({ query: 'サブエージェント' }), c.sink, h.noCancel(), h.counter());
    assert.equal(c.hits.length, 1, JSON.stringify(c.hits));
    assert.equal((c.hits[0].origin as any).isSidechain, true);
  });

  await h.test('searchChat: 既定では他プロジェクトの会話は出ない', async () => {
    const c = h.collector();
    await searchChat(chatScope(), h.makeOptions({ query: '別プロジェクト' }), c.sink, h.noCancel(), h.counter());
    assert.equal(c.hits.length, 0);

    const all = h.collector();
    await searchChat(
      chatScope({ allProjects: true }),
      h.makeOptions({ query: '別プロジェクト' }),
      all.sink,
      h.noCancel(),
      h.counter(),
    );
    assert.equal(all.hits.length, 1);
  });

  await h.test('searchChat: 2 回目はキャッシュが効いても同じ結果になる', async () => {
    const first = h.collector();
    await searchChat(chatScope(), h.makeOptions({ query: '合言葉' }), first.sink, h.noCancel(), h.counter());
    const second = h.collector();
    await searchChat(chatScope(), h.makeOptions({ query: '合言葉' }), second.sink, h.noCancel(), h.counter());
    assert.equal(second.hits.length, first.hits.length);
    assert.deepEqual(
      second.hits.map((x) => x.text),
      first.hits.map((x) => x.text),
    );
  });

  console.log('\nchat/chatDocument');

  await h.test('renderSession: 発言 1 件につき見出しが 1 行出る', async () => {
    const entries = await loadSession(sessionFile, false);
    const md = renderSession(entries, 0);
    const headings = md.split('\n').filter((l) => l.startsWith('## '));
    assert.equal(headings.length, entries.length);
    assert.ok(headings[0].includes('⬅︎'), '目印が付いていない');
  });

  await h.test('chatTargetLine: 目的の発言の目的の行を指す', async () => {
    const entries = await loadSession(sessionFile, false);
    const target = entries.findIndex((e: ChatEntry) => e.block === 'tool_use');
    assert.ok(target >= 0);
    const md = renderSession(entries, target);
    const lines = md.split('\n');
    const entryLines = entries[target].text.split('\n');
    const wanted = entryLines.findIndex((l) => l.includes('PASSPHRASE_TTL_HOURS'));
    assert.ok(wanted >= 0);
    const line = chatTargetLine(md, target, entries[target].block, wanted + 1);
    assert.ok(
      lines[line].includes('PASSPHRASE_TTL_HOURS'),
      `${line} 行目は "${lines[line]}"（前後: ${JSON.stringify(lines.slice(line - 2, line + 3))}）`,
    );
  });

  await h.test('renderSession: コードフェンスが本文と衝突しない', () => {
    const entries: ChatEntry[] = [
      {
        uuid: 'u',
        parentUuid: '',
        sessionId: 's',
        timestamp: '2026-08-01T00:00:00.000Z',
        role: 'assistant',
        block: 'tool_use',
        tool: 'Write',
        cwd: '',
        gitBranch: '',
        isSidechain: false,
        text: '```\nnested fence\n```',
        recordLine: 1,
        index: 0,
      },
    ];
    const md = renderSession(entries, 0);
    assert.ok(md.includes('````json'), `フェンスが伸びていない:\n${md}`);
  });

  /** 行の写像だけを見るための、最小の発言。 */
  const entry = (index: number, block: string, text: string): ChatEntry => ({
    uuid: `u${index}`,
    parentUuid: '',
    sessionId: 's',
    timestamp: '2026-08-01T00:00:00.000Z',
    role: index % 2 === 0 ? 'user' : 'assistant',
    block,
    cwd: '',
    gitBranch: '',
    isSidechain: false,
    text,
    recordLine: index + 1,
    index,
  });

  await h.test('chatTargetLine: 本文中の "## " を見出しと数えない', () => {
    // 会話には Markdown の見出しが普通に出てくる。それを発言の区切りと取り違えると
    // 目的の発言より手前を指してしまう。
    const entries = [
      entry(0, 'text', '# まとめ\n## 背景\nあれこれ。\n## 結論\nそうした。'),
      entry(1, 'text', 'ここが目的の発言です。'),
    ];
    const md = renderSession(entries, 1);
    const line = chatTargetLine(md, 1, 'text', 1);
    assert.equal(md.split('\n')[line], 'ここが目的の発言です。', `line=${line}\n${md}`);
  });

  await h.test('chatTargetLine: 特定できなければ -1 (文書の先頭を指さない)', () => {
    const md = renderSession([entry(0, 'text', 'ひとつだけ')], 0);
    assert.equal(chatTargetLine(md, 7, 'text', 1), -1);
  });

  await h.test('chatTargetLine: tool_result の有無で番号がずれても先頭に落ちない', async () => {
    // 「ツール結果」を含めて検索すると通し番号に tool_result が混ざる。
    // ビューアを別の条件で組み立てると番号が余り、以前は 0 行目 (# 会話ログ) を指していた。
    const withOut = await loadSession(sessionFile, false);
    const withIn = await loadSession(sessionFile, true);
    assert.ok(withIn.length > withOut.length, `${withIn.length} <= ${withOut.length}`);
    const md = renderSession(withOut, 0);
    assert.equal(chatTargetLine(md, withIn.length - 1, 'tool_result', 1), -1);
  });

  await h.test('searchChat: 出所に「どの並びで番号を振ったか」が入る', async () => {
    const off = h.collector();
    await searchChat(chatScope(), h.makeOptions({ query: '合言葉' }), off.sink, h.noCancel(), h.counter());
    assert.ok(off.hits.length > 0);
    assert.ok(
      off.hits.every((x) => (x.origin as any).withToolResults === false),
      'tool_result 抜きの検索なのに true が入っている',
    );

    const on = h.collector();
    await searchChat(
      chatScope({ toolResult: true }),
      h.makeOptions({ query: '合言葉' }),
      on.sink,
      h.noCancel(),
      h.counter(),
    );
    assert.ok(
      on.hits.every((x) => (x.origin as any).withToolResults === true),
      'tool_result 込みの検索なのに false が入っている',
    );
  });

  await h.test('会話ログ: 検索したヒットを同じ並びで開けば目的の行に着く', async () => {
    for (const toolResult of [false, true]) {
      const c = h.collector();
      await searchChat(
        chatScope({ toolResult }),
        h.makeOptions({ query: '失効する' }),
        c.sink,
        h.noCancel(),
        h.counter(),
      );
      assert.equal(c.hits.length, 1, `toolResult=${toolResult} でヒット数が違う`);
      const hit = c.hits[0];
      const origin = hit.origin as any;
      // navigator と同じ手順で開く。
      const entries = await loadSession(origin.sessionFile, origin.withToolResults);
      const md = renderSession(entries, origin.entryIndex);
      const line = chatTargetLine(md, origin.entryIndex, origin.block, hit.line);
      assert.ok(line > 0, `toolResult=${toolResult}: 先頭を指している (line=${line})`);
      assert.ok(
        md.split('\n')[line].includes('失効する'),
        `toolResult=${toolResult}: ${line} 行目 = "${md.split('\n')[line]}"`,
      );
    }
  });

  console.log('\nutil/symbol');

  await h.test('extractSymbol: 予約語ではなく固有の識別子を選ぶ', () => {
    assert.equal(extractSymbol('const passphraseTtlHours = 24;'), 'passphraseTtlHours');
    assert.equal(extractSymbol('export function computeChecksum(input) {'), 'computeChecksum');
  });

  await h.test('extractSymbol: 日本語は助詞ごと飲み込まず内容語を取り出す', () => {
    // 形態素解析はしないので「合言葉」「有効期限」のどちらが返っても正しい。
    // 駄目なのは助詞を含む丸ごと 1 語 (検索語として使えない)。
    const got = extractSymbol('// この値は合言葉の有効期限');
    assert.ok(['合言葉', '有効期限'].includes(got ?? ''), `内容語になっていない: ${got}`);
  });

  await h.test('extractSymbol: カタカナ語も拾う', () => {
    assert.equal(extractSymbol('// パスフレーズを使う'), 'パスフレーズ');
  });

  await h.test('extractSymbol: snake_case も拾う', () => {
    assert.equal(extractSymbol('MAX_RETRY_COUNT = 3'), 'MAX_RETRY_COUNT');
  });

  await h.test('extractSymbol: 拾える語が無ければ undefined', () => {
    assert.equal(extractSymbol('  );'), undefined);
    assert.equal(extractSymbol('if (a) { b(); }'), undefined);
  });

  console.log('\ngit/gitService (blame)');

  await h.test('parseBlamePorcelain: sha / 著者 / 日付 / 件名 / ファイル名を読む', () => {
    const info = parseBlamePorcelain(
      [
        '1234567890abcdef1234567890abcdef12345678 3 3 1',
        'author Test Person',
        'author-mail <test@example.com>',
        'author-time 1780000000',
        'author-tz +0900',
        'summary spellword を追加',
        'filename src/history.ts',
        '\tconst spellword = "x";',
      ].join('\n'),
    )!;
    assert.equal(info.sha, '1234567890abcdef1234567890abcdef12345678');
    assert.equal(info.shortSha, '12345678');
    assert.equal(info.author, 'Test Person');
    assert.equal(info.subject, 'spellword を追加');
    assert.equal(info.file, 'src/history.ts');
    assert.equal(info.uncommitted, false);
    assert.equal(info.date, new Date(1780000000 * 1000).toISOString());
  });

  await h.test('parseBlamePorcelain: 未コミット行を見分ける', () => {
    const info = parseBlamePorcelain(
      ['0000000000000000000000000000000000000000 1 1 1', 'author Not Committed Yet', 'filename a.ts', '\tx'].join('\n'),
    )!;
    assert.equal(info.uncommitted, true);
  });

  await h.test('parseBlamePorcelain: 形式が違えば undefined', () => {
    assert.equal(parseBlamePorcelain('not blame output'), undefined);
  });

  await h.test('blameLine: 実リポジトリで行の出所を引く', async () => {
    const info = (await blameLine(h.repo, path.join(h.repo, 'src', 'alpha.ts'), 1))!;
    assert.ok(info, 'blame が取れない');
    assert.equal(info.file, 'src/alpha.ts');
    assert.equal(info.subject, 'initial');
    assert.equal(info.uncommitted, false);
    assert.ok(/^[0-9a-f]{40}$/.test(info.sha));
  });

  await h.test('blameLine: 未コミットの変更を未コミットとして返す', async () => {
    const scratch = path.join(h.repo, 'src', 'untracked-for-blame.ts');
    fs.writeFileSync(scratch, 'const fresh = 1;\n', 'utf8');
    execFileSync('git', ['add', 'src/untracked-for-blame.ts'], { cwd: h.repo, stdio: 'ignore' });
    try {
      const info = await blameLine(h.repo, scratch, 1);
      assert.ok(info, 'blame が取れない');
      assert.equal(info!.uncommitted, true);
    } finally {
      execFileSync('git', ['rm', '-f', '--quiet', 'src/untracked-for-blame.ts'], { cwd: h.repo, stdio: 'ignore' });
    }
  });

  if (previousConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR;
  } else {
    process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
  }
  clearTranscriptCache();
}
