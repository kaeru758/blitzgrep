import * as vscode from 'vscode';
import { showBlob } from '../git/gitService';
import { errorMessage } from '../log';
import { readGitHubFile } from '../search/githubProvider';
import type { RepoContext } from '../types';

export const BLOB_SCHEME = 'blitzgrep';

interface BlobRef {
  /** 'git' = ローカル git のワークツリールート, 'github' = owner/repo */
  kind: 'git' | 'github';
  root: string;
  ref: string;
  file: string;
}

/**
 * ブランチ側のヒットを読み取り専用エディタで開くための URI を作る。
 * 言語判定が効くよう、パスの末尾は必ず実ファイル名にしておく。
 */
export function blobUri(ctx: RepoContext, ref: string, file: string): vscode.Uri {
  const payload: BlobRef =
    ctx.kind === 'virtual-github' && ctx.github
      ? { kind: 'github', root: `${ctx.github.owner}/${ctx.github.repo}`, ref, file }
      : { kind: 'git', root: ctx.root ?? '', ref, file };
  return vscode.Uri.from({
    scheme: BLOB_SCHEME,
    path: `/${ref}/${file}`,
    query: JSON.stringify(payload),
  });
}

export function describeBlobUri(uri: vscode.Uri): { ref: string; file: string } | undefined {
  try {
    const p = JSON.parse(uri.query) as BlobRef;
    return { ref: p.ref, file: p.file };
  } catch {
    return undefined;
  }
}

export class BlobContentProvider implements vscode.TextDocumentContentProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;

  async provideTextDocumentContent(uri: vscode.Uri, token: vscode.CancellationToken): Promise<string> {
    let payload: BlobRef;
    try {
      payload = JSON.parse(uri.query) as BlobRef;
    } catch {
      return '// BlitzGrep: URI が壊れています';
    }
    if (token.isCancellationRequested) {
      return '';
    }

    try {
      if (payload.kind === 'github') {
        const [owner, repo] = payload.root.split('/');
        const text = await readGitHubFile({ owner, repo }, payload.ref, payload.file);
        return text ?? `// BlitzGrep: ${payload.ref}:${payload.file} を取得できませんでした`;
      }
      const text = await showBlob(payload.root, payload.ref, payload.file);
      return text ?? `// BlitzGrep: ${payload.ref}:${payload.file} は存在しません`;
    } catch (err) {
      return `// BlitzGrep: 読み込みに失敗しました\n// ${errorMessage(err)}`;
    }
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
