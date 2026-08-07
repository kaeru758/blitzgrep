// テストを esbuild で束ね、'vscode' をスタブに差し替えてから Node で実行できるようにする。
const esbuild = require('esbuild');
const path = require('node:path');

esbuild
  .build({
    entryPoints: [path.join(__dirname, 'suite.ts')],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    outfile: path.join(__dirname, '..', 'out', 'test', 'suite.js'),
    sourcemap: 'inline',
    alias: { vscode: path.join(__dirname, 'vscode-stub.js') },
    logLevel: 'warning',
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
