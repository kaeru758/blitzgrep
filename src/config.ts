import * as vscode from 'vscode';

export interface BlitzConfig {
  maxResults: number;
  debounceMs: number;
  useGitignore: boolean;
  includeHidden: boolean;
  followSymlinks: boolean;
  excludeGlobs: string[];
  maxFileSizeKb: number;
  branchConcurrency: number;
  highlightInEditor: boolean;
  highlightCurrentLine: boolean;
  flashOnJump: boolean;
  contextLines: number;
  ripgrepPath: string;
  githubMaxFilesPerBranch: number;
  openPreview: boolean;
  historyMaxCommits: number;
}

export function getConfig(): BlitzConfig {
  const c = vscode.workspace.getConfiguration('blitzgrep');
  return {
    maxResults: c.get<number>('maxResults', 10000),
    debounceMs: c.get<number>('debounceMs', 120),
    useGitignore: c.get<boolean>('useGitignore', true),
    includeHidden: c.get<boolean>('includeHidden', false),
    followSymlinks: c.get<boolean>('followSymlinks', false),
    excludeGlobs: c.get<string[]>('excludeGlobs', []),
    maxFileSizeKb: c.get<number>('maxFileSizeKb', 2048),
    branchConcurrency: c.get<number>('branchConcurrency', 6),
    highlightInEditor: c.get<boolean>('highlightInEditor', true),
    highlightCurrentLine: c.get<boolean>('highlightCurrentLine', true),
    flashOnJump: c.get<boolean>('flashOnJump', true),
    contextLines: c.get<number>('contextLines', 0),
    ripgrepPath: c.get<string>('ripgrepPath', ''),
    githubMaxFilesPerBranch: c.get<number>('githubMaxFilesPerBranch', 1500),
    openPreview: c.get<boolean>('openPreview', true),
    historyMaxCommits: c.get<number>('historyMaxCommits', 300),
  };
}

/** 表示・転送コストを抑えるため 1 行あたりの最大文字数。 */
export const MAX_LINE_CHARS = 400;
