// インストール済みの VS Code を、隔離したユーザーデータで起動して統合テストを走らせる。
// 既存の設定・拡張機能には一切触れない。
const { execFileSync, spawnSync } = require('node:child_process');
const esbuild = require('esbuild');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..', '..');

/**
 * テスト専用の VS Code を .vscode-test/ に用意する。
 * インストール済みの VS Code は使わない (更新中のミューテックスで起動できないことがあり、
 * ユーザーの設定・拡張機能とも混ざらないようにするため)。
 */
async function getVsCodeExe() {
  if (process.env.BLITZ_VSCODE_EXE) {
    return process.env.BLITZ_VSCODE_EXE;
  }
  const { downloadAndUnzipVSCode } = require('@vscode/test-electron');
  return await downloadAndUnzipVSCode('stable');
}

function makeFixtureWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blitzgrep-it-'));
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });

  fs.writeFileSync(
    path.join(repo, 'src', 'alpha.ts'),
    'export const needle = 1;\nconst needle2 = needle + 1;\n',
    'utf8',
  );
  fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n\nneedle in a doc.\n', 'utf8');
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('add', '-A');
  git('commit', '-qm', 'initial');
  git('switch', '-qc', 'feature/one');
  fs.writeFileSync(path.join(repo, 'src', 'gamma.ts'), 'const needle = "only on feature branch";\n', 'utf8');
  git('add', '-A');
  git('commit', '-qm', 'feature');
  git('switch', '-q', 'main');

  // 出所追跡用: コード・履歴・会話ログの 3 箇所に同じ語が現れる状況を作る。
  fs.writeFileSync(
    path.join(repo, 'src', 'traced.ts'),
    'export const PASSPHRASE_TTL_HOURS = 24;\n',
    'utf8',
  );
  git('add', '-A');
  git('commit', '-qm', '合言葉の有効期限を追加');

  // 履歴検索用: 追加してから削除する。
  fs.writeFileSync(path.join(repo, 'src', 'removed.ts'), 'const spellword = "gone";\n', 'utf8');
  git('add', '-A');
  git('commit', '-qm', 'spellword を追加');
  const historySha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  fs.rmSync(path.join(repo, 'src', 'removed.ts'));
  git('add', '-A');
  git('commit', '-qm', 'spellword を削除');

  // 会話ログ用の transcript を、実物と同じレイアウトで作る。
  // 符号化は src/chat/transcriptStore.ts の encodeProjectDir と揃えること。
  // 一時ディレクトリには macOS の "_" や Windows の "RUNNER~1" が混ざるので、
  // 区切り文字だけを置換していると OS によって照合できなくなる。
  const claudeHome = path.join(dir, 'claude-home');
  const projectDir = path.join(claudeHome, 'projects', repo.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(projectDir, { recursive: true });
  const base = { sessionId: 'session-1', timestamp: '2026-08-01T10:00:00.000Z', cwd: repo, gitBranch: 'main' };
  const records = [
    { ...base, type: 'user', uuid: 'u1', message: { role: 'user', content: [{ type: 'text', text: '合言葉で認証して' }] } },
    {
      ...base,
      type: 'assistant',
      uuid: 'a1',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '合言葉の有効期限は 24 時間にする。', signature: 'x' },
          { type: 'text', text: '合言葉は 24 時間で失効します。' },
          {
            type: 'tool_use',
            name: 'Write',
            input: { file_path: 'src/traced.ts', content: 'export const PASSPHRASE_TTL_HOURS = 24;\n' },
          },
        ],
      },
    },
  ];
  const sessionFile = path.join(projectDir, 'session-1.jsonl');
  fs.writeFileSync(sessionFile, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');

  return { dir, repo, historySha, sessionFile, claudeHome };
}

async function main() {
  const exe = await getVsCodeExe();

  await esbuild.build({
    entryPoints: [path.join(__dirname, 'index.ts')],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    outfile: path.join(repoRoot, 'out', 'integration', 'index.js'),
    external: ['vscode'],
    sourcemap: 'inline',
    logLevel: 'warning',
  });

  const { dir, repo, historySha, sessionFile, claudeHome } = makeFixtureWorkspace();
  const userDataDir = path.join(dir, 'user-data');
  const extensionsDir = path.join(dir, 'extensions');

  const args = [
    `--extensionDevelopmentPath=${repoRoot}`,
    `--extensionTestsPath=${path.join(repoRoot, 'out', 'integration', 'index.js')}`,
    `--user-data-dir=${userDataDir}`,
    `--extensions-dir=${extensionsDir}`,
    '--disable-workspace-trust',
    '--disable-gpu',
    '--disable-updates',
    '--skip-welcome',
    '--skip-release-notes',
    '--no-sandbox',
    repo,
  ];

  console.log(`VS Code: ${exe}`);
  console.log(`フィクスチャ: ${repo}\n`);

  // VS Code の中からこのスクリプトを走らせると ELECTRON_RUN_AS_NODE などが継承され、
  // Code.exe が Electron ではなく Node として起動してしまう。関係する変数を落としておく。
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('ELECTRON_') || key.startsWith('VSCODE_') || key === 'CHROME_DESKTOP') {
      continue;
    }
    env[key] = value;
  }
  env.ELECTRON_ENABLE_LOGGING = '1';
  // 拡張機能がユーザー本人の会話ログではなくフィクスチャを見るようにする。
  env.CLAUDE_CONFIG_DIR = claudeHome;
  env.BLITZ_TEST_HISTORY_SHA = historySha;
  env.BLITZ_TEST_SESSION_FILE = sessionFile;

  const result = spawnSync(exe, args, {
    stdio: 'inherit',
    encoding: 'utf8',
    env,
    timeout: 240000,
  });

  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // 後片付けの失敗は無視。
  }

  if (result.error) {
    console.error(result.error);
    process.exit(1);
  }
  process.exit(result.status === null ? 1 : result.status);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
