import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import * as vscode from 'vscode';

import { listBranches } from '../src/git/gitService';
import { buildGitGrepArgs, parseGitGrepLine, searchRefs, toPathspecs } from '../src/search/gitGrepProvider';
import { buildRipgrepArgs, searchWithRipgrep } from '../src/search/ripgrepProvider';
import { locateRipgrep } from '../src/search/rgLocator';
import { StageTracker, stageSink } from '../src/search/stages';
import type { HitSink, SearchHit, SearchOptions, SearchStage } from '../src/types';
import { buildJsRegex, byteOffsetToCharIndex, clampLine, findMatches } from '../src/util/pattern';
import { extractTar, stripLeadingComponent } from '../src/util/tar';
import { run as runExtraSuite } from './suite2';

let passed = 0;
let failed = 0;
const only = process.env.BLITZ_TEST_ONLY;

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  if (only && !name.includes(only)) {
    return;
  }
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL ${name}`);
    console.log(`       ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  }
}

// ------------------------------------------------------------------ 準備

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'blitzgrep-'));
const repo = path.join(tmpRoot, 'repo');
const NUL = '\0';

/** 100 バイトの name フィールドに収まらない -> tar は pax 拡張ヘッダを使う。 */
const LONG_NAME = `src/${'d'.repeat(120)}.ts`;
/** name には収まらないが ustar の prefix + name に分割できる長さ。 */
const DEEP_PATH = `${'a'.repeat(60)}/${'b'.repeat(60)}/${'c'.repeat(60)}/deep.ts`;

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function write(rel: string, content: string): void {
  const full = path.join(repo, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
}

function setupRepo(): void {
  fs.mkdirSync(repo, { recursive: true });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'core.autocrlf', 'false');

  write('src/alpha.ts', 'export const needle = 1;\nconst other = 2;\nconst needle2 = needle + 1;\n');
  write('src/nested/beta.ts', 'import { needle } from "../alpha";\n');
  write('docs/guide.md', '# ガイド\n\nこの用語「合言葉」は needle と対応する。\n合言葉をもう一度。\n');
  write('noise/big.txt', 'x'.repeat(5000) + ' needle ' + 'y'.repeat(5000) + '\n');
  write('noise/many.txt', Array.from({ length: 2000 }, (_, i) => `line ${i} needle here`).join('\n') + '\n');
  write(LONG_NAME, 'const needle = "long file name";\n');
  write(DEEP_PATH, 'const needle = "deep";\n');
  write('.gitignore', 'ignored/\n');
  write('ignored/hidden.ts', 'const needle = "should be ignored";\n');
  git('add', '-A');
  git('commit', '-qm', 'initial');

  git('switch', '-qc', 'feature/one');
  write('src/gamma.ts', 'const needle = "only on feature branch";\n');
  git('add', '-A');
  git('commit', '-qm', 'feature');

  git('switch', '-q', 'main');
}

function makeOptions(over: Partial<SearchOptions> = {}): SearchOptions {
  return {
    query: 'needle',
    isRegex: false,
    isCaseSensitive: false,
    matchWholeWord: false,
    includeGlobs: [],
    excludeGlobs: [],
    scope: { kind: 'worktree' },
    dedupeAcrossRefs: true,
    ...over,
  };
}

function collector(): { hits: SearchHit[]; warnings: string[]; errors: string[]; sink: HitSink } {
  const hits: SearchHit[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  return {
    hits,
    warnings,
    errors,
    sink: {
      push(batch) {
        hits.push(...batch);
        return true;
      },
      warn(m) {
        warnings.push(m);
      },
      error(m) {
        errors.push(m);
      },
    },
  };
}

function noCancel(): vscode.CancellationToken {
  return new vscode.CancellationTokenSource().token;
}

function counter(): () => number {
  let n = 0;
  return () => n++;
}

function sourceLine(file: string, line: number): string {
  return fs.readFileSync(path.join(repo, file), 'utf8').split(/\r?\n/)[line - 1];
}

/** ヒットの col / len が、実ファイルの当該行で本当に検索語を指しているか。 */
function assertPointsAt(hit: SearchHit, expected: string): void {
  const source = sourceLine(hit.file, hit.line);
  assert.equal(
    source.slice(hit.col - 1, hit.col - 1 + hit.len),
    expected,
    `${hit.file}:${hit.line}:${hit.col} が "${expected}" を指していない (実際: "${source.slice(hit.col - 1, hit.col - 1 + hit.len)}")`,
  );
}

// ------------------------------------------------------------------ テスト

async function main(): Promise<void> {
  setupRepo();
  console.log(`テスト用リポジトリ: ${repo}\n`);

  console.log('util/pattern');
  await test('buildJsRegex: 固定文字列をエスケープする', () => {
    const re = buildJsRegex({ query: 'a.b', isRegex: false, isCaseSensitive: true, matchWholeWord: false })!;
    assert.equal(findMatches(re, 'a.b axb').length, 1);
  });

  await test('buildJsRegex: 大文字小文字を無視できる', () => {
    const re = buildJsRegex({ query: 'Needle', isRegex: false, isCaseSensitive: false, matchWholeWord: false })!;
    assert.equal(findMatches(re, 'needle NEEDLE').length, 2);
  });

  await test('buildJsRegex: 単語単位', () => {
    const re = buildJsRegex({ query: 'needle', isRegex: false, isCaseSensitive: true, matchWholeWord: true })!;
    assert.equal(findMatches(re, 'needle needle2').length, 1);
  });

  await test('buildJsRegex: 不正な正規表現は undefined', () => {
    assert.equal(buildJsRegex({ query: '(', isRegex: true, isCaseSensitive: true, matchWholeWord: false }), undefined);
  });

  await test('findMatches: 空一致で無限ループしない', () => {
    const re = buildJsRegex({ query: 'x*', isRegex: true, isCaseSensitive: true, matchWholeWord: false })!;
    assert.deepEqual(findMatches(re, 'axxb'), [[1, 2]]);
  });

  await test('byteOffsetToCharIndex: マルチバイトを正しく変換する', () => {
    const line = '合言葉 needle';
    assert.equal(byteOffsetToCharIndex(line, Buffer.from('合言葉 ', 'utf8').length), 4);
    assert.equal(line.slice(4), 'needle');
  });

  await test('byteOffsetToCharIndex: サロゲートペア', () => {
    assert.equal(byteOffsetToCharIndex('😀ab', 4), 2);
  });

  await test('clampLine: 長い行を一致位置を含む窓に切り出す', () => {
    const text = 'x'.repeat(5000) + 'needle' + 'y'.repeat(5000);
    const { text: out, matches } = clampLine(text, [[5000, 6]]);
    assert.ok(out.length <= 400);
    assert.equal(out.slice(matches[0][0], matches[0][0] + matches[0][1]), 'needle');
  });

  console.log('\nsearch/gitGrepProvider (パース)');
  await test('parseGitGrepLine: ref 付き -z レコード', () => {
    const parsed = parseGitGrepLine(`main:src/alpha.ts${NUL}1${NUL}14${NUL}export const needle = 1;`, 'main');
    assert.deepEqual(parsed, { file: 'src/alpha.ts', line: 1, col: 14, text: 'export const needle = 1;' });
  });

  await test('parseGitGrepLine: パスやテキストに ":" があっても壊れない', () => {
    const parsed = parseGitGrepLine(`origin/dev:a:b/c.ts${NUL}12${NUL}3${NUL}x: needle :y`, 'origin/dev')!;
    assert.equal(parsed.file, 'a:b/c.ts');
    assert.equal(parsed.line, 12);
    assert.equal(parsed.col, 3);
    assert.equal(parsed.text, 'x: needle :y');
  });

  await test('parseGitGrepLine: 末尾 CR を落とす', () => {
    assert.equal(parseGitGrepLine(`main:a.ts${NUL}1${NUL}1${NUL}code\r`, 'main')!.text, 'code');
  });

  await test('parseGitGrepLine: ref が違えば undefined', () => {
    assert.equal(parseGitGrepLine(`main:a.ts${NUL}1${NUL}1${NUL}x`, 'feature'), undefined);
  });

  await test('parseGitGrepLine: 実際の git grep -z 出力と一致する', () => {
    // フィクスチャが実物とズレないよう、生の git 出力を直接パースして突き合わせる。
    const raw = execFileSync('git', ['--no-pager', 'grep', '--no-color', '--full-name', '-I', '-n', '--column', '-z', '-F', '-e', 'needle', 'main', '--', ':(glob)**/alpha.ts'], {
      cwd: repo,
      encoding: 'utf8',
    });
    const records = raw.split('\n').filter(Boolean);
    assert.ok(records.length >= 2, `git の出力が想定外: ${JSON.stringify(raw)}`);
    const parsed = parseGitGrepLine(records[0], 'main')!;
    assert.equal(parsed.file, 'src/alpha.ts');
    assert.equal(parsed.line, 1);
    assert.equal(parsed.text, 'export const needle = 1;');
  });

  await test('toPathspecs: include/exclude を pathspec に変換する', () => {
    assert.deepEqual(toPathspecs(['*.ts'], ['!**/node_modules/**']), [
      ':(glob)**/*.ts',
      ':(exclude,glob)**/node_modules/**',
    ]);
    assert.deepEqual(toPathspecs([], []), [':(glob)**']);
  });

  await test('buildGitGrepArgs: 固定文字列 + 大文字小文字無視', () => {
    const args = buildGitGrepArgs(makeOptions(), 'main', false);
    assert.ok(args.includes('--fixed-strings'));
    assert.ok(args.includes('--ignore-case'));
    assert.ok(args.includes('-z'));
    assert.equal(args[args.indexOf('-e') + 1], 'needle');
    assert.equal(args[args.indexOf('-e') + 2], 'main');
  });

  await test('buildGitGrepArgs: 正規表現なら PCRE / ERE を選ぶ', () => {
    assert.ok(buildGitGrepArgs(makeOptions({ isRegex: true }), 'main', true).includes('--perl-regexp'));
    assert.ok(buildGitGrepArgs(makeOptions({ isRegex: true }), 'main', false).includes('--extended-regexp'));
  });

  await test('buildRipgrepArgs: オプションがフラグに反映される', () => {
    const args = buildRipgrepArgs(makeOptions({ isCaseSensitive: true, matchWholeWord: true, isRegex: true }));
    assert.ok(args.includes('--json') && args.includes('--crlf'));
    assert.ok(args.includes('--word-regexp'));
    assert.ok(!args.includes('--ignore-case'));
    assert.ok(!args.includes('--fixed-strings'));
    assert.deepEqual(args.slice(-4), ['--regexp', 'needle', '--', '.']);
  });

  console.log('\nsearch/gitGrepProvider (実 git)');
  await test('listBranches: ローカルブランチを列挙する', async () => {
    const branches = await listBranches(repo);
    assert.deepEqual(branches.map((b) => b.name).sort(), ['feature/one', 'main']);
    assert.equal(branches.find((b) => b.name === 'main')!.isCurrent, true);
  });

  await test('searchRefs: ブランチ横断で feature 限定のヒットを見つける', async () => {
    const c = collector();
    await searchRefs(repo, ['main', 'feature/one'], makeOptions(), c.sink, noCancel(), counter());
    const onFeature = c.hits.filter((h) => h.file === 'src/gamma.ts');
    assert.equal(onFeature.length, 1, `gamma.ts は feature/one にだけあるはず`);
    assert.equal(onFeature[0].ref, 'feature/one');
    assert.equal(c.errors.length, 0);
    assert.equal(c.warnings.length, 0, c.warnings.join(' / '));
  });

  await test('searchRefs: すべてのヒットに ref が入る', async () => {
    const c = collector();
    await searchRefs(repo, ['main'], makeOptions({ includeGlobs: ['*.ts'] }), c.sink, noCancel(), counter());
    assert.ok(c.hits.length > 0);
    assert.ok(c.hits.every((h) => h.ref === 'main'));
  });

  await test('searchRefs: 一致位置が正しい (ジャンプ先の検証)', async () => {
    const c = collector();
    await searchRefs(repo, ['main'], makeOptions({ includeGlobs: ['alpha.ts'] }), c.sink, noCancel(), counter());
    const hit = c.hits.find((h) => h.file === 'src/alpha.ts' && h.line === 1)!;
    assert.ok(hit, '見つからない');
    assertPointsAt(hit, 'needle');
  });

  await test('searchRefs: 日本語ドキュメントの桁が文字単位で正しい', async () => {
    const c = collector();
    await searchRefs(repo, ['main'], makeOptions({ query: '合言葉' }), c.sink, noCancel(), counter());
    assert.ok(c.hits.length >= 2, `ヒット数: ${c.hits.length}`);
    for (const hit of c.hits) {
      assertPointsAt(hit, '合言葉');
    }
  });

  await test('searchRefs: include グロブが効く', async () => {
    const c = collector();
    await searchRefs(repo, ['main'], makeOptions({ includeGlobs: ['*.md'] }), c.sink, noCancel(), counter());
    assert.ok(c.hits.length > 0);
    assert.ok(
      c.hits.every((h) => h.file.endsWith('.md')),
      c.hits.map((h) => h.file).join(),
    );
  });

  await test('searchRefs: exclude グロブが効く', async () => {
    const c = collector();
    await searchRefs(repo, ['main'], makeOptions({ excludeGlobs: ['!**/noise/**'] }), c.sink, noCancel(), counter());
    assert.ok(c.hits.length > 0);
    assert.ok(!c.hits.some((h) => h.file.startsWith('noise/')));
  });

  await test('searchRefs: 正規表現検索', async () => {
    const c = collector();
    await searchRefs(repo, ['main'], makeOptions({ query: 'needle\\d', isRegex: true }), c.sink, noCancel(), counter());
    assert.ok(
      c.hits.some((h) => h.text.includes('needle2')),
      JSON.stringify(c.hits.slice(0, 3)),
    );
  });

  await test('searchRefs: 存在しない ref は警告になり、他の ref は成功する', async () => {
    const c = collector();
    await searchRefs(repo, ['main', 'no-such-branch'], makeOptions(), c.sink, noCancel(), counter());
    assert.ok(c.hits.length > 0, 'main の結果まで失われている');
    assert.ok(
      c.warnings.some((w) => w.startsWith('no-such-branch:')),
      `警告が出ていない: ${JSON.stringify(c.warnings)}`,
    );
  });

  console.log('\nsearch/ripgrepProvider (実 rg)');
  const rg = await locateRipgrep();
  if (!rg) {
    const why = 'ripgrep が見つかりません (BLITZ_TEST_APPROOT を設定してください)';
    if (process.env.CI) {
      // CI で黙って飛ばすと「3 OS で緑」が嘘になる。落として気付けるようにする。
      failed++;
      console.log(`  FAIL ${why}`);
    } else {
      console.log(`  skip: ${why}`);
    }
  } else {
    console.log(`  (rg = ${rg})`);

    await test('searchWithRipgrep: ワーキングツリーを検索する', async () => {
      const c = collector();
      const ok = await searchWithRipgrep(repo, makeOptions(), c.sink, noCancel(), counter());
      assert.equal(ok, true);
      const files = new Set(c.hits.map((h) => h.file));
      assert.ok(files.has('src/alpha.ts'), [...files].join());
      assert.ok(files.has('src/nested/beta.ts'), [...files].join());
      assert.ok(c.hits.every((h) => h.ref === null));
    });

    await test('searchWithRipgrep: .gitignore を尊重する', async () => {
      const c = collector();
      await searchWithRipgrep(repo, makeOptions(), c.sink, noCancel(), counter());
      assert.ok(!c.hits.some((h) => h.file.startsWith('ignored/')), 'ignored/ が含まれている');
    });

    await test('searchWithRipgrep: パスは / 区切りの相対パス', async () => {
      const c = collector();
      await searchWithRipgrep(repo, makeOptions(), c.sink, noCancel(), counter());
      assert.ok(
        c.hits.every((h) => !h.file.includes('\\') && !h.file.startsWith('./')),
        JSON.stringify([...new Set(c.hits.map((h) => h.file))]),
      );
    });

    await test('searchWithRipgrep: 一致位置が元の行に対して正しい (日本語)', async () => {
      const c = collector();
      await searchWithRipgrep(repo, makeOptions({ query: '合言葉' }), c.sink, noCancel(), counter());
      assert.ok(c.hits.length >= 2, `ヒット数 ${c.hits.length}`);
      for (const hit of c.hits) {
        assertPointsAt(hit, '合言葉');
      }
    });

    await test('searchWithRipgrep: 長大な行を切り詰めても一致が見える', async () => {
      const c = collector();
      await searchWithRipgrep(repo, makeOptions({ includeGlobs: ['big.txt'] }), c.sink, noCancel(), counter());
      assert.equal(c.hits.length, 1);
      const hit = c.hits[0];
      assert.ok(hit.text.length <= 400, `切り詰められていない: ${hit.text.length}`);
      assert.equal(hit.text.slice(hit.matches[0][0], hit.matches[0][0] + hit.matches[0][1]), 'needle');
      assertPointsAt(hit, 'needle');
    });

    await test('searchWithRipgrep: 単語単位なら needle2 ではなく needle を指す', async () => {
      const c = collector();
      await searchWithRipgrep(
        repo,
        makeOptions({ matchWholeWord: true, isCaseSensitive: true, includeGlobs: ['alpha.ts'] }),
        c.sink,
        noCancel(),
        counter(),
      );
      const line3 = c.hits.find((h) => h.line === 3)!;
      assert.ok(line3, '3 行目がヒットしていない');
      assert.equal(line3.matches.length, 1, '"needle2" も一致してしまっている');
      assertPointsAt(line3, 'needle');
      assert.equal(line3.col - 1, sourceLine('src/alpha.ts', 3).indexOf('needle + 1'));
    });

    await test('searchWithRipgrep: sink が false を返したら打ち切る', async () => {
      const hits: SearchHit[] = [];
      let pushes = 0;
      const sink: HitSink = {
        push(batch) {
          pushes++;
          hits.push(...batch);
          return pushes < 2;
        },
        warn() {},
        error() {},
      };
      await searchWithRipgrep(repo, makeOptions({ includeGlobs: ['many.txt'] }), sink, noCancel(), counter());
      assert.ok(hits.length < 2000, `全件読み込んでしまっている: ${hits.length}`);
      assert.ok(pushes <= 3, `false 応答後も push され続けている: ${pushes}`);
    });

    await test('searchWithRipgrep: キャンセルで即座に止まる', async () => {
      const cts = new vscode.CancellationTokenSource();
      const c = collector();
      cts.cancel();
      await searchWithRipgrep(repo, makeOptions(), c.sink, cts.token, counter());
      assert.equal(c.hits.length, 0);
    });

    await test('searchWithRipgrep: 不正な正規表現はエラーとして報告される', async () => {
      const c = collector();
      await searchWithRipgrep(repo, makeOptions({ query: '(unclosed', isRegex: true }), c.sink, noCancel(), counter());
      assert.equal(c.hits.length, 0);
      assert.ok(c.errors.length > 0, 'エラーが報告されていない');
    });
  }

  console.log('\nutil/tar (git archive で生成した実アーカイブ)');
  const archive = (): Buffer =>
    execFileSync('git', ['archive', '--format=tar.gz', '--prefix=owner-repo-abc123/', 'main'], {
      cwd: repo,
      maxBuffer: 128 * 1024 * 1024,
    });

  await test('extractTar: tar.gz を展開して中身を取り出せる', () => {
    const files = new Map<string, string>();
    extractTar(zlib.gunzipSync(archive()), (entry) => {
      files.set(stripLeadingComponent(entry.path), entry.data.toString('utf8'));
      return true;
    });
    assert.ok(files.has('src/alpha.ts'), [...files.keys()].join());
    assert.ok(files.get('src/alpha.ts')!.includes('needle'));
    assert.ok(files.get('docs/guide.md')!.includes('合言葉'), '日本語が壊れている');
    assert.ok(!files.has('src/gamma.ts'), 'main に無いファイルが入っている');
  });

  await test('extractTar: pax 拡張ヘッダの長いファイル名を復元する', () => {
    const files: string[] = [];
    extractTar(zlib.gunzipSync(archive()), (entry) => {
      files.push(stripLeadingComponent(entry.path));
      return true;
    });
    assert.ok(files.includes(LONG_NAME), `長いファイル名が復元できていない:\n${files.join('\n')}`);
  });

  await test('extractTar: ustar prefix つきの深いパスを復元する', () => {
    const files: string[] = [];
    extractTar(zlib.gunzipSync(archive()), (entry) => {
      files.push(stripLeadingComponent(entry.path));
      return true;
    });
    assert.ok(files.includes(DEEP_PATH), `深いパスが復元できていない:\n${files.join('\n')}`);
  });

  await test('extractTar: ファイル内容が壊れない', () => {
    let deep = '';
    extractTar(zlib.gunzipSync(archive()), (entry) => {
      if (stripLeadingComponent(entry.path) === DEEP_PATH) {
        deep = entry.data.toString('utf8');
        return false;
      }
      return true;
    });
    assert.equal(deep, 'const needle = "deep";\n');
  });

  await test('extractTar: onEntry が false を返したら打ち切る', () => {
    let count = 0;
    extractTar(zlib.gunzipSync(archive()), () => {
      count++;
      return count < 2;
    });
    assert.equal(count, 2);
  });

  // ------------------------------------------------------------------ パイプライン表示

  console.log('\nsearch/stages');

  await test('StageTracker: plan した段は pending で並ぶ', () => {
    const seen: SearchStage[][] = [];
    const tracker = new StageTracker((s) => seen.push(s));
    tracker.plan([
      { key: 'blame', icon: '📍', label: 'blame' },
      { key: 'chat', icon: '💬', label: '会話ログ' },
    ]);
    assert.equal(seen.length, 1);
    assert.deepEqual(
      seen[0].map((s) => [s.key, s.status, s.count]),
      [
        ['blame', 'pending', 0],
        ['chat', 'pending', 0],
      ],
    );
    tracker.dispose();
  });

  await test('StageTracker: begin / finish で状態と所要時間が入る', () => {
    const seen: SearchStage[][] = [];
    const tracker = new StageTracker((s) => seen.push(s));
    tracker.plan([{ key: 'chat', icon: '💬', label: '会話ログ' }]);
    tracker.begin('chat');
    tracker.finish('chat', 'done');
    const last = seen[seen.length - 1][0];
    assert.equal(last.status, 'done');
    assert.equal(last.progress, 1);
    assert.ok(typeof last.durationMs === 'number' && last.durationMs >= 0);
    tracker.dispose();
  });

  await test('StageTracker: 未知のキーは黙って無視する', () => {
    const seen: SearchStage[][] = [];
    const tracker = new StageTracker((s) => seen.push(s));
    tracker.plan([{ key: 'chat', icon: '💬', label: '会話ログ' }]);
    const before = seen.length;
    tracker.begin('nope');
    tracker.finish('nope', 'done');
    tracker.addCount('nope', 3);
    assert.equal(seen.length, before);
    tracker.dispose();
  });

  await test('StageTracker: settleRemaining が走らなかった段を畳む', () => {
    const seen: SearchStage[][] = [];
    const tracker = new StageTracker((s) => seen.push(s));
    tracker.plan([
      { key: 'a', icon: '1', label: 'a' },
      { key: 'b', icon: '2', label: 'b' },
    ]);
    tracker.begin('a');
    tracker.finish('a', 'done');
    tracker.settleRemaining('skipped', '中断');
    const last = seen[seen.length - 1];
    assert.deepEqual(
      last.map((s) => s.status),
      ['done', 'skipped'],
    );
    assert.equal(last[1].note, '中断');
    tracker.dispose();
  });

  await test('StageTracker: 件数の更新は間引かれても dispose で必ず届く', () => {
    const seen: SearchStage[][] = [];
    const tracker = new StageTracker((s) => seen.push(s));
    tracker.plan([{ key: 'a', icon: '1', label: 'a' }]);
    tracker.begin('a');
    // begin の直後なので間引きに掛かり、この 2 回は保留される。
    tracker.addCount('a', 3);
    tracker.addCount('a', 4);
    tracker.dispose();
    assert.equal(seen[seen.length - 1][0].count, 7);
  });

  await test('stageSink: 件数を数えつつ本体へ素通しする', () => {
    const seen: SearchStage[][] = [];
    const tracker = new StageTracker((s) => seen.push(s));
    tracker.plan([{ key: 'a', icon: '1', label: 'a' }]);
    const c = collector();
    const wrapped = stageSink(c.sink, tracker, 'a');
    wrapped.push([{ id: 0, ref: null, file: 'x.ts', line: 1, col: 1, len: 1, text: 'x', matches: [] }]);
    wrapped.warn('w');
    assert.equal(wrapped.count, 1);
    assert.equal(c.hits.length, 1);
    assert.deepEqual(c.warnings, ['w']);
    tracker.dispose();
    assert.equal(seen[seen.length - 1][0].count, 1);
  });

  await test('searchRefs: ref を終えるたびに進捗を返す', async () => {
    const c = collector();
    const seen: Array<[number, number]> = [];
    await searchRefs(repo, ['main', 'feature'], makeOptions(), c.sink, noCancel(), counter(), (done, total) =>
      seen.push([done, total]),
    );
    assert.equal(seen.length, 2);
    assert.deepEqual(seen[seen.length - 1], [2, 2]);
  });

  await runExtraSuite(
    { test, repo, makeOptions, collector, noCancel, counter },
    tmpRoot,
  );

  console.log(`\n${passed} 件成功 / ${failed} 件失敗`);
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // Windows でハンドルが残っていても致命的ではない。
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
