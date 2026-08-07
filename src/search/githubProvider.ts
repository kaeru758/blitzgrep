import * as zlib from 'node:zlib';
import * as vscode from 'vscode';
import { getConfig } from '../config';
import { errorMessage, log } from '../log';
import type { BranchInfo, HitSink, SearchHit, SearchOptions } from '../types';
import { buildJsRegex, clampLine, findMatches } from '../util/pattern';
import { extractTar, stripLeadingComponent } from '../util/tar';

const API = 'https://api.github.com';
const MAX_ARCHIVE_BYTES = 120 * 1024 * 1024;

export interface GitHubRepoRef {
  owner: string;
  repo: string;
  ref?: string;
}

/** vscode-vfs://github/<owner>/<repo> 形式の URI を解釈する。 */
export function parseGitHubUri(uri: vscode.Uri): GitHubRepoRef | undefined {
  const isVfs = uri.scheme === 'vscode-vfs' && /^github/.test(uri.authority);
  const isGithubScheme = uri.scheme === 'github';
  if (!isVfs && !isGithubScheme) {
    return undefined;
  }
  const parts = uri.path.split('/').filter(Boolean);
  if (parts.length < 2) {
    return undefined;
  }
  return { owner: parts[0], repo: parts[1] };
}

async function token(interactive: boolean): Promise<string | undefined> {
  try {
    const session = await vscode.authentication.getSession('github', ['repo'], {
      createIfNone: interactive,
      silent: interactive ? undefined : true,
    });
    return session?.accessToken;
  } catch (err) {
    log.warn(`GitHub 認証に失敗: ${errorMessage(err)}`);
    return undefined;
  }
}

async function api(path: string, interactive: boolean, accept = 'application/vnd.github+json'): Promise<Response> {
  const t = await token(interactive);
  const headers: Record<string, string> = {
    Accept: accept,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'BlitzGrep',
  };
  if (t) {
    headers.Authorization = `Bearer ${t}`;
  }
  return fetch(`${API}${path}`, { headers });
}

async function apiJson<T>(path: string, interactive: boolean): Promise<T> {
  const res = await api(path, interactive);
  if (!res.ok) {
    throw new Error(await describeHttpError(res));
  }
  return (await res.json()) as T;
}

async function describeHttpError(res: Response): Promise<string> {
  let detail = '';
  try {
    const body = (await res.json()) as { message?: string };
    detail = body.message ? `: ${body.message}` : '';
  } catch {
    // 本文が JSON でない場合は無視
  }
  if (res.status === 401 || res.status === 403) {
    const remaining = res.headers.get('x-ratelimit-remaining');
    if (remaining === '0') {
      return `GitHub API のレート制限に達しました${detail}`;
    }
    return `GitHub API の認可が必要です (HTTP ${res.status})${detail}`;
  }
  return `GitHub API エラー HTTP ${res.status}${detail}`;
}

/** リモートリポジトリのブランチ一覧。 */
export async function listGitHubBranches(repo: GitHubRepoRef): Promise<BranchInfo[]> {
  const info = await apiJson<{ default_branch: string }>(`/repos/${repo.owner}/${repo.repo}`, true);
  const out: BranchInfo[] = [];
  for (let page = 1; page <= 5; page++) {
    const branches = await apiJson<Array<{ name: string; commit: { sha: string } }>>(
      `/repos/${repo.owner}/${repo.repo}/branches?per_page=100&page=${page}`,
      true,
    );
    for (const b of branches) {
      out.push({
        name: b.name,
        kind: 'remote',
        isCurrent: false,
        isDefault: b.name === info.default_branch,
        committerDate: '',
        subject: '',
      });
    }
    if (branches.length < 100) {
      break;
    }
  }
  out.sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name));
  return out;
}

interface ArchiveFile {
  path: string;
  text: string;
}

/** ref ごとの展開済みアーカイブ。SHA 単位でキャッシュするので同じコミットの再検索は無料。 */
const archiveCache = new Map<string, ArchiveFile[]>();
const MAX_CACHED_ARCHIVES = 4;

function cachePut(key: string, files: ArchiveFile[]): void {
  if (archiveCache.size >= MAX_CACHED_ARCHIVES) {
    const oldest = archiveCache.keys().next().value;
    if (oldest !== undefined) {
      archiveCache.delete(oldest);
    }
  }
  archiveCache.set(key, files);
}

export function clearGitHubCache(): void {
  archiveCache.clear();
}

async function resolveSha(repo: GitHubRepoRef, ref: string): Promise<string> {
  const data = await apiJson<{ sha: string }>(
    `/repos/${repo.owner}/${repo.repo}/commits/${encodeURIComponent(ref)}`,
    true,
  );
  return data.sha;
}

async function loadArchive(
  repo: GitHubRepoRef,
  ref: string,
  token_: vscode.CancellationToken,
  onProgress: (msg: string) => void,
): Promise<ArchiveFile[]> {
  const sha = await resolveSha(repo, ref);
  const key = `${repo.owner}/${repo.repo}@${sha}`;
  const cached = archiveCache.get(key);
  if (cached) {
    return cached;
  }
  if (token_.isCancellationRequested) {
    return [];
  }

  onProgress(`${ref} のアーカイブを取得中…`);
  const res = await api(`/repos/${repo.owner}/${repo.repo}/tarball/${encodeURIComponent(sha)}`, true, '*/*');
  if (!res.ok) {
    throw new Error(await describeHttpError(res));
  }
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > MAX_ARCHIVE_BYTES) {
    throw new Error(`アーカイブが大きすぎます (${Math.round(declared / 1024 / 1024)} MB)`);
  }
  const gz = Buffer.from(await res.arrayBuffer());
  if (gz.byteLength > MAX_ARCHIVE_BYTES) {
    throw new Error(`アーカイブが大きすぎます (${Math.round(gz.byteLength / 1024 / 1024)} MB)`);
  }
  if (token_.isCancellationRequested) {
    return [];
  }

  const tar = zlib.gunzipSync(gz, { maxOutputLength: 512 * 1024 * 1024 });
  const cfg = getConfig();
  const maxBytes = Math.max(1, cfg.maxFileSizeKb) * 1024;
  const limit = cfg.githubMaxFilesPerBranch;
  const decoder = new TextDecoder('utf-8', { fatal: false });
  const files: ArchiveFile[] = [];

  extractTar(tar, (entry) => {
    if (entry.data.byteLength > maxBytes || isBinary(entry.data)) {
      return true;
    }
    files.push({ path: stripLeadingComponent(entry.path), text: decoder.decode(entry.data) });
    return files.length < limit;
  });

  cachePut(key, files);
  log.info(`GitHub アーカイブ ${key}: ${files.length} 件のテキストファイル`);
  return files;
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

function globToRegExp(glob: string): RegExp {
  const g = glob.replace(/^!/, '').replace(/^\.\//, '');
  const pattern = g.includes('/') ? g : `**/${g}`;
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        i++;
        if (pattern[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

/** リモート (vscode-vfs) リポジトリを、ref 単位でアーカイブを取得して検索する。 */
export async function searchGitHubRefs(
  repo: GitHubRepoRef,
  refs: string[],
  opts: SearchOptions,
  sink: HitSink,
  cancel: vscode.CancellationToken,
  nextId: () => number,
): Promise<void> {
  const re = buildJsRegex(opts);
  if (!re) {
    sink.error('正規表現が不正です。');
    return;
  }
  const includes = opts.includeGlobs.filter((g) => g.trim()).map(globToRegExp);
  const excludes = opts.excludeGlobs.filter((g) => g.trim()).map(globToRegExp);
  let sinkWantsMore = true;

  for (const ref of refs) {
    if (cancel.isCancellationRequested || !sinkWantsMore) {
      return;
    }
    let files: ArchiveFile[];
    try {
      files = await loadArchive(repo, ref, cancel, (m) => sink.warn(m));
    } catch (err) {
      sink.warn(`${ref}: ${errorMessage(err)}`);
      continue;
    }

    for (const file of files) {
      if (cancel.isCancellationRequested || !sinkWantsMore) {
        return;
      }
      if (includes.length > 0 && !includes.some((r) => r.test(file.path))) {
        continue;
      }
      if (excludes.some((r) => r.test(file.path))) {
        continue;
      }
      const lines = file.text.split('\n');
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
          ref,
          file: file.path,
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
    }
  }
}

/** リモートの ref から 1 ファイルの中身を取り出す (結果を開くときに使う)。 */
export async function readGitHubFile(repo: GitHubRepoRef, ref: string, file: string): Promise<string | undefined> {
  try {
    const sha = await resolveSha(repo, ref);
    const cached = archiveCache.get(`${repo.owner}/${repo.repo}@${sha}`);
    const hit = cached?.find((f) => f.path === file);
    if (hit) {
      return hit.text;
    }
  } catch {
    // キャッシュが無ければ API から取る。
  }
  const res = await api(
    `/repos/${repo.owner}/${repo.repo}/contents/${file.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`,
    true,
    'application/vnd.github.raw',
  );
  if (!res.ok) {
    throw new Error(await describeHttpError(res));
  }
  return await res.text();
}
