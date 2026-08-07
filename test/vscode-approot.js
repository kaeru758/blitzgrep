// テスト用に落とした VS Code の appRoot を標準出力に出す。
//
// 単体テストは同梱 ripgrep を appRoot から探す。CI には VS Code がインストールされていないので、
// 統合テストが .vscode-test/ に落とした一式を指させて、ripgrep のテストが skip されないようにする。
// レイアウトは OS ごとに違う (macOS は .app の中) ため、実行ファイルから上へ辿って特定する。
const fs = require('node:fs');
const path = require('node:path');

const RELATIVES = [
  ['resources', 'app'], // Linux / 一部の Windows 版
  ['..', 'Resources', 'app'], // macOS (Contents/MacOS/Electron から見て)
  ['Resources', 'app'],
];

function isAppRoot(dir) {
  try {
    return fs.statSync(path.join(dir, 'node_modules.asar.unpacked')).isDirectory();
  } catch {
    return false;
  }
}

/** dir 直下と、その 1 つ下の各ディレクトリから resources/app を探す。 */
function probe(dir) {
  const roots = [dir];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        // Windows 版はコミットハッシュのディレクトリを 1 段挟む (更新のたびに名前が変わる)。
        roots.push(path.join(dir, e.name));
      }
    }
  } catch {
    // 読めなければ dir 自身だけ見る
  }
  for (const root of roots) {
    for (const rel of RELATIVES) {
      const candidate = path.resolve(root, ...rel);
      if (isAppRoot(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

function findAppRoot(exe) {
  let dir = path.dirname(exe);
  for (let up = 0; up < 5; up++) {
    const found = probe(dir);
    if (found) {
      return found;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return undefined;
}

async function main() {
  const exe = process.env.BLITZ_VSCODE_EXE || (await require('@vscode/test-electron').downloadAndUnzipVSCode('stable'));
  const appRoot = findAppRoot(exe);
  if (!appRoot) {
    console.error(`appRoot を特定できませんでした (exe=${exe})`);
    process.exit(1);
  }
  process.stdout.write(appRoot);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
