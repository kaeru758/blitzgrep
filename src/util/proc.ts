import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as vscode from 'vscode';

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** stdout をまとめて受け取る単発実行。git の問い合わせ系コマンド向け。 */
export function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; token?: vscode.CancellationToken; maxBuffer?: number } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    if (opts.token?.isCancellationRequested) {
      resolve({ code: null, stdout: '', stderr: '' });
      return;
    }
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        windowsHide: true,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      });
    } catch (err) {
      reject(err);
      return;
    }

    const maxBuffer = opts.maxBuffer ?? 64 * 1024 * 1024;
    let out = '';
    let err = '';
    let overflow = false;
    let settled = false;

    const sub = opts.token?.onCancellationRequested(() => {
      child.kill();
    });

    const finish = (fn: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      sub?.dispose();
      fn();
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      if (out.length + d.length > maxBuffer) {
        overflow = true;
        child.kill();
        return;
      }
      out += d;
    });
    child.stderr.on('data', (d: string) => {
      if (err.length < 64 * 1024) {
        err += d;
      }
    });
    child.on('error', (e) => finish(() => reject(e)));
    child.on('close', (code) =>
      finish(() =>
        resolve({
          code,
          stdout: out,
          stderr: overflow ? `${err}\n(output truncated)` : err,
        }),
      ),
    );
  });
}

/**
 * 行単位ストリーミング実行。ripgrep / git grep の逐次表示に使う。
 * `onLine` が false を返したら即座にプロセスを kill する (上限到達など)。
 */
export function runStreaming(
  cmd: string,
  args: string[],
  opts: {
    cwd?: string;
    token?: vscode.CancellationToken;
    /** 行区切り文字。既定は "\n"。 */
    separator?: string;
    onLine: (line: string) => boolean;
  },
): Promise<{ code: number | null; stderr: string; stopped: boolean }> {
  return new Promise((resolve, reject) => {
    // 起動前にキャンセル済みなら onCancellationRequested はもう発火しないので、ここで弾く。
    if (opts.token?.isCancellationRequested) {
      resolve({ code: null, stderr: '', stopped: true });
      return;
    }
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        windowsHide: true,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      });
    } catch (err) {
      reject(err);
      return;
    }

    const sep = opts.separator ?? '\n';
    let buffer = '';
    let stderr = '';
    let stopped = false;
    let settled = false;

    const stop = () => {
      if (!stopped) {
        stopped = true;
        child.kill();
      }
    };

    const sub = opts.token?.onCancellationRequested(stop);

    const finish = (fn: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      sub?.dispose();
      fn();
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (chunk: string) => {
      if (stopped) {
        return;
      }
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf(sep)) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + sep.length);
        if (line.length > 0 && !opts.onLine(line)) {
          stop();
          return;
        }
      }
    });

    child.stderr.on('data', (d: string) => {
      if (stderr.length < 64 * 1024) {
        stderr += d;
      }
    });

    child.on('error', (e) => finish(() => reject(e)));
    child.on('close', (code) =>
      finish(() => {
        if (!stopped && buffer.length > 0) {
          opts.onLine(buffer);
        }
        resolve({ code, stderr, stopped });
      }),
    );
  });
}

/** 同時実行数を制限しながら全タスクを走らせる。 */
export async function pool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  const limit = Math.max(1, Math.min(concurrency, items.length));
  let cursor = 0;
  const runners = Array.from({ length: limit }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) {
        return;
      }
      await worker(items[i], i);
    }
  });
  await Promise.all(runners);
}
