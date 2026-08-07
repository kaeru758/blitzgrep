import * as path from 'node:path';
import * as vscode from 'vscode';
import { findGitRoot } from './git/gitService';
import { parseGitHubUri } from './search/githubProvider';
import type { RepoContext } from './types';

const cache = new Map<string, RepoContext>();

export function clearRepoContextCache(): void {
  cache.clear();
}

/** ワークスペースフォルダから検索対象のリポジトリ種別を判定する。 */
export async function resolveRepoContext(folder: vscode.Uri): Promise<RepoContext> {
  const key = folder.toString();
  const hit = cache.get(key);
  if (hit) {
    return hit;
  }

  const github = parseGitHubUri(folder);
  if (github) {
    const ctx: RepoContext = {
      kind: 'virtual-github',
      rootUri: key,
      github,
      label: `${github.owner}/${github.repo}`,
    };
    cache.set(key, ctx);
    return ctx;
  }

  if (folder.scheme === 'file') {
    // rootUri は「開いているフォルダ」= ワーキングツリー検索の基点。
    // root は git のルートで、ブランチ検索 (git grep --full-name) の基点。
    // サブディレクトリを開いている場合、この 2 つは一致しない。
    const root = await findGitRoot(folder.fsPath);
    const ctx: RepoContext = root
      ? { kind: 'local-git', root, rootUri: key, label: labelFor(folder.fsPath, root) }
      : { kind: 'plain-folder', rootUri: key, label: path.basename(folder.fsPath) };
    cache.set(key, ctx);
    return ctx;
  }

  const ctx: RepoContext = {
    kind: 'plain-folder',
    rootUri: key,
    label: folder.path.split('/').filter(Boolean).pop() ?? folder.toString(),
  };
  cache.set(key, ctx);
  return ctx;
}

export function workspaceFolders(): readonly vscode.WorkspaceFolder[] {
  return vscode.workspace.workspaceFolders ?? [];
}

/** アクティブなエディタが属するフォルダを優先して、既定の検索ルートを選ぶ。 */
export function defaultFolder(): vscode.Uri | undefined {
  const folders = workspaceFolders();
  if (folders.length === 0) {
    return undefined;
  }
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active) {
    const owner = vscode.workspace.getWorkspaceFolder(active);
    if (owner) {
      return owner.uri;
    }
  }
  return folders[0].uri;
}

function labelFor(folder: string, gitRoot: string): string {
  const name = path.basename(gitRoot);
  const rel = path.relative(gitRoot, folder);
  return rel ? `${name}/${rel.replace(/\\/g, '/')}` : name;
}

/**
 * ワーキングツリーのヒット (ref === null) を開くための URI。
 * 相対パスは常に rootUri (= 開いているフォルダ) 基準。
 */
export function fileUri(ctx: RepoContext, relative: string): vscode.Uri {
  const base = vscode.Uri.parse(ctx.rootUri);
  if (base.scheme === 'file') {
    return vscode.Uri.file(path.join(base.fsPath, relative));
  }
  return base.with({ path: `${base.path.replace(/\/$/, '')}/${relative}` });
}
