import * as vscode from 'vscode';

let channel: vscode.LogOutputChannel | undefined;

export function initLog(): vscode.LogOutputChannel {
  channel ??= vscode.window.createOutputChannel('BlitzGrep', { log: true });
  return channel;
}

export const log = {
  info(msg: string, ...args: unknown[]): void {
    initLog().info(msg, ...args);
  },
  warn(msg: string, ...args: unknown[]): void {
    initLog().warn(msg, ...args);
  },
  error(msg: string, ...args: unknown[]): void {
    initLog().error(msg, ...args);
  },
  debug(msg: string, ...args: unknown[]): void {
    initLog().debug(msg, ...args);
  },
  show(): void {
    initLog().show();
  },
};

export function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
