import * as vscode from 'vscode';
import { errorMessage, log } from '../log';
import type { BranchInfo } from '../types';
import { run } from '../util/proc';

export function gitPath(): string {
  const configured = vscode.workspace.getConfiguration('git').get<string | string[]>('path');
  if (typeof configured === 'string' && configured.trim()) {
    return configured;
  }
  if (Array.isArray(configured) && configured.length > 0 && configured[0]) {
    return configured[0];
  }
  return 'git';
}

/** cwd を含む git ワークツリーのルート。git 管理外なら undefined。 */
export async function findGitRoot(cwd: string): Promise<string | undefined> {
  try {
    const r = await run(gitPath(), ['rev-parse', '--show-toplevel'], { cwd, maxBuffer: 1 << 16 });
    if (r.code !== 0) {
      return undefined;
    }
    const root = r.stdout.trim();
    return root ? normalizeRoot(root) : undefined;
  } catch (err) {
    log.debug(`findGitRoot 失敗: ${errorMessage(err)}`);
    return undefined;
  }
}

function normalizeRoot(p: string): string {
  // git は Windows でも "C:/foo/bar" を返す。ドライブレターは大文字に揃える。
  const s = p.replace(/\//g, process.platform === 'win32' ? '\\' : '/');
  return /^[a-z]:/.test(s) ? s[0].toUpperCase() + s.slice(1) : s;
}

const FIELD = '\u001f';
const RECORD = '\u001e';

/** ローカル + リモート追跡ブランチを、新しい順に列挙する。 */
export async function listBranches(root: string, token?: vscode.CancellationToken): Promise<BranchInfo[]> {
  const format = [
    '%(refname)',
    '%(refname:short)',
    '%(committerdate:iso8601-strict)',
    '%(HEAD)',
    '%(contents:subject)',
  ].join(FIELD);

  const r = await run(
    gitPath(),
    [
      'for-each-ref',
      `--format=${format}${RECORD}`,
      '--sort=-committerdate',
      'refs/heads',
      'refs/remotes',
    ],
    { cwd: root, token },
  );
  if (r.code !== 0) {
    throw new Error(r.stderr.trim() || 'git for-each-ref に失敗しました');
  }

  const defaultBranch = await findDefaultBranch(root, token);
  const out: BranchInfo[] = [];
  for (const record of r.stdout.split(RECORD)) {
    const line = record.replace(/^\r?\n/, '');
    if (!line.trim()) {
      continue;
    }
    const [refname, short, date, head, subject = ''] = line.split(FIELD);
    if (!refname || !short) {
      continue;
    }
    // origin/HEAD は origin/main への symbolic ref なので重複するだけ。
    if (/^refs\/remotes\/[^/]+\/HEAD$/.test(refname)) {
      continue;
    }
    out.push({
      name: short,
      kind: refname.startsWith('refs/remotes/') ? 'remote' : 'local',
      isCurrent: head === '*',
      isDefault: short === defaultBranch,
      committerDate: date ?? '',
      subject: subject.trim(),
    });
  }
  return out;
}

async function findDefaultBranch(root: string, token?: vscode.CancellationToken): Promise<string | undefined> {
  try {
    const r = await run(gitPath(), ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], {
      cwd: root,
      token,
      maxBuffer: 1 << 16,
    });
    if (r.code === 0) {
      const full = r.stdout.trim(); // "origin/main"
      return full.replace(/^origin\//, '');
    }
  } catch {
    // origin が無いリポジトリなど。
  }
  for (const candidate of ['main', 'master']) {
    try {
      const r = await run(gitPath(), ['rev-parse', '--verify', '--quiet', candidate], {
        cwd: root,
        token,
        maxBuffer: 1 << 16,
      });
      if (r.code === 0) {
        return candidate;
      }
    } catch {
      // 次の候補へ
    }
  }
  return undefined;
}

export async function currentBranch(root: string): Promise<string | undefined> {
  try {
    const r = await run(gitPath(), ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, maxBuffer: 1 << 16 });
    const name = r.stdout.trim();
    return r.code === 0 && name && name !== 'HEAD' ? name : undefined;
  } catch {
    return undefined;
  }
}

/** `git show <ref>:<path>` の中身。存在しなければ undefined。 */
export async function showBlob(root: string, ref: string, file: string): Promise<string | undefined> {
  const r = await run(gitPath(), ['--no-pager', 'show', `${ref}:${file}`], {
    cwd: root,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (r.code !== 0) {
    return undefined;
  }
  return r.stdout;
}

export interface BlameInfo {
  sha: string;
  shortSha: string;
  author: string;
  /** ISO8601 */
  date: string;
  subject: string;
  /** リポジトリルートからの相対パス (途中で改名されていれば当時の名前)。 */
  file: string;
  /** まだコミットされていない行。 */
  uncommitted: boolean;
}

/** その行を最後に触ったコミットを引く。 */
export async function blameLine(root: string, file: string, line: number): Promise<BlameInfo | undefined> {
  const r = await run(
    gitPath(),
    ['--no-pager', 'blame', '--porcelain', '-L', `${line},${line}`, '--', file],
    { cwd: root, maxBuffer: 1 << 20 },
  );
  if (r.code !== 0) {
    return undefined;
  }
  return parseBlamePorcelain(r.stdout);
}

/**
 * `git blame --porcelain` の出力を読む。
 * 1 行目が `<sha> <origLine> <finalLine> [<numLines>]`、以降が `key value` 形式のヘッダ。
 */
export function parseBlamePorcelain(stdout: string): BlameInfo | undefined {
  const lines = stdout.split(/\r?\n/);
  const header = /^([0-9a-f]{40}) \d+ \d+/.exec(lines[0] ?? '');
  if (!header) {
    return undefined;
  }
  const sha = header[1];
  const field = (key: string): string => {
    const prefix = `${key} `;
    const hit = lines.find((l) => l.startsWith(prefix));
    return hit ? hit.slice(prefix.length).trim() : '';
  };
  const epoch = Number(field('author-time'));
  return {
    sha,
    shortSha: sha.slice(0, 8),
    author: field('author'),
    date: Number.isFinite(epoch) && epoch > 0 ? new Date(epoch * 1000).toISOString() : '',
    subject: field('summary'),
    file: field('filename'),
    uncommitted: /^0+$/.test(sha),
  };
}

let pcreSupport: boolean | undefined;

/** この git が PCRE (-P) を使えるか。使えなければ POSIX 拡張正規表現 (-E) にする。 */
export async function supportsPcre(root: string): Promise<boolean> {
  if (pcreSupport !== undefined) {
    return pcreSupport;
  }
  try {
    // 何にもマッチしないパターンでワーキングツリーを -P で検索する。
    // 終了コード 0/1 は正常 (1 = 一致なし)。コミットが無いリポジトリでも成立する。
    const r = await run(gitPath(), ['grep', '-P', '-I', '-l', '-e', '(?i)zzz_blitzgrep_probe_zzz'], {
      cwd: root,
      maxBuffer: 1 << 16,
    });
    // PCRE 非対応の git だけが明示的にそう言ってくる。それ以外の失敗 (空リポジトリ等) は
    // -P の可否と無関係なので、対応しているものとして扱う。
    pcreSupport = !/pcre|not compiled/i.test(r.stderr);
    if (!pcreSupport) {
      log.info(`git grep -P は使えません (${r.stderr.trim()})。-E にフォールバックします。`);
    }
  } catch {
    pcreSupport = false;
  }
  return pcreSupport;
}

export function resetGitCaches(): void {
  pcreSupport = undefined;
}
