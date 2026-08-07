// 拡張機能ホストの中で走るスモークテスト。
// vsce のマニフェスト検証では捕まらない「本当に起動して動くか」を確認する。
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

const EXTENSION_ID = 'local.blitzgrep';

const results: string[] = [];
let failed = 0;

async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    results.push(`  ok   ${name}`);
  } catch (err) {
    failed++;
    results.push(`  FAIL ${name}\n       ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function run(): Promise<void> {
  const ext = vscode.extensions.getExtension(EXTENSION_ID);

  await check('拡張機能が見つかる', () => {
    assert.ok(ext, `${EXTENSION_ID} が読み込まれていない`);
  });

  await check('アクティベートが例外なく完了する', async () => {
    await ext!.activate();
    assert.equal(ext!.isActive, true);
  });

  await check('コマンドがすべて登録されている', async () => {
    const registered = new Set(await vscode.commands.getCommands(true));
    const declared: string[] = (ext!.packageJSON.contributes.commands as Array<{ command: string }>).map(
      (c) => c.command,
    );
    const missing = declared.filter((c) => !registered.has(c));
    assert.deepEqual(missing, [], `未登録のコマンド: ${missing.join(', ')}`);
  });

  await check('ワークスペースが git リポジトリとして開かれている', () => {
    const folders = vscode.workspace.workspaceFolders ?? [];
    assert.equal(folders.length, 1, 'ワークスペースフォルダが 1 つではない');
    assert.ok(fs.existsSync(path.join(folders[0].uri.fsPath, '.git')), '.git が無い');
  });

  await check('ビューを表示してもエラーにならない', async () => {
    await vscode.commands.executeCommand('blitzgrep.focusSearch');
    await sleep(1500);
  });

  await check('選択範囲の検索が最後まで走る', async () => {
    const folder = vscode.workspace.workspaceFolders![0].uri;
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder, 'src', 'alpha.ts'));
    const editor = await vscode.window.showTextDocument(doc);
    const line = doc.lineAt(0).text;
    const start = line.indexOf('needle');
    assert.ok(start >= 0, 'テスト用ファイルの中身が想定と違う');
    editor.selection = new vscode.Selection(0, start, 0, start + 'needle'.length);
    await vscode.commands.executeCommand('blitzgrep.searchSelection');
    await sleep(2500);
  });

  await check('検索後に次の一致へジャンプできる', async () => {
    await vscode.commands.executeCommand('blitzgrep.nextMatch');
    await sleep(800);
    const active = vscode.window.activeTextEditor;
    assert.ok(active, 'ジャンプ後にアクティブなエディタが無い');
    const selected = active.document.getText(active.selection);
    assert.equal(selected, 'needle', `選択されているのは "${selected}"`);
  });

  await check('ブランチのファイルを blitzgrep: スキームで開ける', async () => {
    const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
    const uri = vscode.Uri.from({
      scheme: 'blitzgrep',
      path: '/feature/one/src/gamma.ts',
      query: JSON.stringify({ kind: 'git', root, ref: 'feature/one', file: 'src/gamma.ts' }),
    });
    const doc = await vscode.workspace.openTextDocument(uri);
    const text = doc.getText();
    assert.ok(text.includes('only on feature branch'), `中身が違う: ${JSON.stringify(text.slice(0, 120))}`);
    assert.equal(doc.languageId, 'typescript', `言語が推定できていない: ${doc.languageId}`);
  });

  await check('結果のコピーが動く', async () => {
    await vscode.commands.executeCommand('blitzgrep.copyResults');
    await sleep(300);
    const text = await vscode.env.clipboard.readText();
    assert.ok(text.includes('needle'), `クリップボードの中身: ${JSON.stringify(text.slice(0, 200))}`);
  });

  await check('ハイライトの切り替えが例外を出さない', async () => {
    await vscode.commands.executeCommand('blitzgrep.toggleHighlight');
    await vscode.commands.executeCommand('blitzgrep.toggleHighlight');
  });

  await check('結果のクリアが例外を出さない', async () => {
    await vscode.commands.executeCommand('blitzgrep.clear');
    await sleep(300);
  });

  await check('履歴のヒットを SHA 指定の blitzgrep: で開ける', async () => {
    const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
    const sha = process.env.BLITZ_TEST_HISTORY_SHA;
    assert.ok(sha, 'テストランナーが SHA を渡していない');
    const uri = vscode.Uri.from({
      scheme: 'blitzgrep',
      path: `/${sha}/src/removed.ts`,
      query: JSON.stringify({ kind: 'git', root, ref: sha, file: 'src/removed.ts' }),
    });
    const doc = await vscode.workspace.openTextDocument(uri);
    assert.ok(
      doc.getText().includes('spellword'),
      `削除前の版が読めていない: ${JSON.stringify(doc.getText().slice(0, 120))}`,
    );
  });

  await check('会話ログを blitzgrep-chat: で読める Markdown として開ける', async () => {
    const sessionFile = process.env.BLITZ_TEST_SESSION_FILE;
    assert.ok(sessionFile, 'テストランナーが transcript のパスを渡していない');
    const uri = vscode.Uri.from({
      scheme: 'blitzgrep-chat',
      path: '/session-1.md',
      query: JSON.stringify({ sessionFile, entryIndex: 1, includeToolResult: false }),
    });
    const doc = await vscode.workspace.openTextDocument(uri);
    const text = doc.getText();
    assert.equal(doc.languageId, 'markdown', `言語が推定できていない: ${doc.languageId}`);
    assert.ok(text.includes('合言葉'), '会話本文が入っていない');
    assert.ok(text.includes('⬅︎'), '目印が付いていない');
    assert.ok(text.includes('🤖 Claude'), '話者の見出しが無い');
  });

  await check('会話ログのビューアを開いても壊れない', async () => {
    const sessionFile = process.env.BLITZ_TEST_SESSION_FILE!;
    const uri = vscode.Uri.from({
      scheme: 'blitzgrep-chat',
      path: '/session-1.md',
      query: JSON.stringify({ sessionFile, entryIndex: 0, includeToolResult: true }),
    });
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, { preview: true });
    assert.ok(editor.document.lineCount > 3);
  });

  await check('traceOrigin: blame + 履歴 + 会話ログを 1 回で引く', async () => {
    const folder = vscode.workspace.workspaceFolders![0].uri;
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder, 'src', 'traced.ts'));
    const editor = await vscode.window.showTextDocument(doc);
    // TTL の行にカーソルを置く。この文字列は履歴にも会話ログにも存在する。
    const line = doc.getText().split('\n').findIndex((l) => l.includes('PASSPHRASE_TTL_HOURS'));
    assert.ok(line >= 0, 'フィクスチャの中身が想定と違う');
    editor.selection = new vscode.Selection(line, 0, line, 0);

    await vscode.commands.executeCommand('blitzgrep.traceOrigin');
    await sleep(6000);

    await vscode.commands.executeCommand('blitzgrep.copyResults');
    await sleep(400);
    const copied = await vscode.env.clipboard.readText();

    // 3 系統がすべて出ていること: blame/履歴のコミット行と、会話ログの transcript 行。
    assert.ok(copied.includes('PASSPHRASE_TTL_HOURS'), `検索語が結果に無い:\n${copied.slice(0, 400)}`);
    assert.ok(copied.includes('src/traced.ts'), `履歴側のヒットが無い:\n${copied.slice(0, 400)}`);
    assert.ok(copied.includes('.jsonl'), `会話ログ側のヒットが無い:\n${copied.slice(0, 600)}`);
  });

  await check('traceOrigin: 会話ログのヒットから会話へ飛べる', async () => {
    // trace の結果を順に開いていき、会話ログのドキュメントに到達できることを確かめる。
    let sawChat = false;
    for (let i = 0; i < 12 && !sawChat; i++) {
      await vscode.commands.executeCommand('blitzgrep.nextMatch');
      await sleep(500);
      if (vscode.window.activeTextEditor?.document.uri.scheme === 'blitzgrep-chat') {
        sawChat = true;
      }
    }
    assert.ok(sawChat, '会話ログのヒットを開けなかった');
    const text = vscode.window.activeTextEditor!.document.getText();
    assert.ok(text.includes('合言葉') || text.includes('PASSPHRASE_TTL_HOURS'), '会話の中身が読めていない');
  });

  await check('キャッシュ破棄コマンドが動く', async () => {
    await vscode.commands.executeCommand('blitzgrep.clearCaches');
    await sleep(200);
  });

  console.log('\n=== BlitzGrep 統合テスト ===');
  for (const line of results) {
    console.log(line);
  }
  console.log(`${results.length - failed} 件成功 / ${failed} 件失敗\n`);

  if (failed > 0) {
    throw new Error(`統合テストが ${failed} 件失敗しました`);
  }
}
