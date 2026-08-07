import * as vscode from 'vscode';
import { getConfig } from '../config';
import type { HitSink, SearchHit, SearchOptions } from '../types';
import { buildJsRegex, clampLine, findMatches } from '../util/pattern';
import { pool } from '../util/proc';

/**
 * ripgrep が使えない環境 (バイナリ未検出・仮想ファイルシステム) 向けのフォールバック。
 * VS Code の FileSystem API しか使わないので、どのスキームでも動く代わりに遅い。
 */
export async function searchWithFileSystem(
  folder: vscode.WorkspaceFolder | vscode.Uri,
  opts: SearchOptions,
  sink: HitSink,
  token: vscode.CancellationToken,
  nextId: () => number,
): Promise<void> {
  const cfg = getConfig();
  const re = buildJsRegex(opts);
  if (!re) {
    sink.error('正規表現が不正です。');
    return;
  }

  const base = 'uri' in folder ? folder : { uri: folder, name: '', index: 0 };
  const include = opts.includeGlobs.length > 0 ? `{${opts.includeGlobs.join(',')}}` : '**/*';
  const excludeParts = opts.excludeGlobs.map((g) => g.replace(/^!/, '')).filter(Boolean);
  const exclude = excludeParts.length > 0 ? `{${excludeParts.join(',')}}` : undefined;

  const files = await vscode.workspace.findFiles(
    new vscode.RelativePattern(base, include),
    exclude ? new vscode.RelativePattern(base, exclude) : undefined,
    20000,
    token,
  );
  if (token.isCancellationRequested) {
    return;
  }

  const rootPath = base.uri.path.replace(/\/$/, '');
  const maxBytes = Math.max(1, cfg.maxFileSizeKb) * 1024;
  let sinkWantsMore = true;
  const decoder = new TextDecoder('utf-8', { fatal: false });

  await pool(files, 16, async (uri) => {
    if (token.isCancellationRequested || !sinkWantsMore) {
      return;
    }
    let bytes: Uint8Array;
    try {
      bytes = await vscode.workspace.fs.readFile(uri);
    } catch {
      return;
    }
    if (bytes.byteLength > maxBytes || isBinary(bytes)) {
      return;
    }

    const relative = uri.path.startsWith(rootPath + '/') ? uri.path.slice(rootPath.length + 1) : uri.path;
    const content = decoder.decode(bytes);
    const lines = content.split('\n');
    const hits: SearchHit[] = [];
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i].endsWith('\r') ? lines[i].slice(0, -1) : lines[i];
      const matches = findMatches(re, raw);
      if (matches.length === 0) {
        continue;
      }
      const clamped = clampLine(raw, matches);
      hits.push({
        id: nextId(),
        ref: null,
        file: relative,
        line: i + 1,
        col: matches[0][0] + 1,
        len: matches[0][1],
        text: clamped.text,
        matches: clamped.matches,
      });
    }
    if (hits.length > 0) {
      sinkWantsMore = sink.push(hits);
    }
  });
}

function isBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.byteLength, 8192);
  for (let i = 0; i < n; i++) {
    if (bytes[i] === 0) {
      return true;
    }
  }
  return false;
}
