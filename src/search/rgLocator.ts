import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { getConfig } from '../config';
import { log } from '../log';
import { run } from '../util/proc';

let cached: string | null | undefined;

function exeName(): string {
  return process.platform === 'win32' ? 'rg.exe' : 'rg';
}

/**
 * VS Code 同梱 ripgrep の既知の配置。バージョンによってパッケージ名もレイアウトも変わるため、
 * 既知パスを試したあと、@vscode 配下を浅くスキャンして未知のレイアウトにも追従する。
 */
function knownCandidates(appRoot: string): string[] {
  const rg = exeName();
  const platformDir = `${process.platform}-${process.arch}`;
  const parents = [
    path.join(appRoot, 'node_modules.asar.unpacked'),
    path.join(appRoot, 'node_modules'),
    // リモート / サーバ拡張ホスト
    path.join(path.dirname(appRoot), 'node_modules'),
  ];
  const relatives = [
    path.join('@vscode', 'ripgrep-universal', 'bin', platformDir, rg),
    path.join('@vscode', 'ripgrep', 'bin', rg),
    path.join('vscode-ripgrep', 'bin', rg),
  ];
  const out: string[] = [];
  for (const parent of parents) {
    for (const rel of relatives) {
      out.push(path.join(parent, rel));
    }
  }
  return out;
}

/** @vscode 配下を深さ制限つきで走査して rg を探す (将来のレイアウト変更に備えた保険)。 */
function scanForRipgrep(appRoot: string): string | undefined {
  const rg = exeName();
  const roots = [
    path.join(appRoot, 'node_modules.asar.unpacked', '@vscode'),
    path.join(appRoot, 'node_modules', '@vscode'),
  ];
  for (const root of roots) {
    const found = walk(root, rg, 4);
    if (found) {
      return found;
    }
  }
  return undefined;
}

function walk(dir: string, target: string, depth: number): string | undefined {
  if (depth < 0) {
    return undefined;
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  const dirs: string[] = [];
  for (const entry of entries) {
    if (entry.isFile() && entry.name === target) {
      return path.join(dir, entry.name);
    }
    if (entry.isDirectory()) {
      dirs.push(path.join(dir, entry.name));
    }
  }
  for (const sub of dirs) {
    const found = walk(sub, target, depth - 1);
    if (found) {
      return found;
    }
  }
  return undefined;
}

/** ripgrep の実行ファイルパスを解決する。見つからなければ null。 */
export async function locateRipgrep(): Promise<string | null> {
  if (cached !== undefined) {
    return cached;
  }

  const configured = getConfig().ripgrepPath.trim();
  if (configured) {
    if (await isRunnable(configured)) {
      log.info(`ripgrep: 設定のパスを使用 ${configured}`);
      cached = configured;
      return cached;
    }
    log.warn(`ripgrep: blitzgrep.ripgrepPath が実行できません: ${configured}`);
  }

  const appRoot = vscode.env.appRoot;
  for (const candidate of knownCandidates(appRoot)) {
    if (existsFile(candidate)) {
      log.info(`ripgrep: VS Code 同梱版を使用 ${candidate}`);
      cached = candidate;
      return cached;
    }
  }

  const scanned = scanForRipgrep(appRoot);
  if (scanned) {
    log.info(`ripgrep: 走査で発見 ${scanned}`);
    cached = scanned;
    return cached;
  }

  if (await isRunnable('rg')) {
    log.info('ripgrep: PATH 上の rg を使用');
    cached = 'rg';
    return cached;
  }

  log.warn('ripgrep が見つかりませんでした。低速なフォールバック検索を使用します。');
  cached = null;
  return cached;
}

export function resetRipgrepCache(): void {
  cached = undefined;
}

function existsFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

async function isRunnable(cmd: string): Promise<boolean> {
  try {
    const r = await run(cmd, ['--version'], { maxBuffer: 64 * 1024 });
    return r.code === 0;
  } catch {
    return false;
  }
}
