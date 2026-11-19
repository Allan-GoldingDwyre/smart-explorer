import * as vscode from 'vscode';

export type WorkspaceType = 'issue' | 'pr' | 'text' | 'smart';

export interface WorkspaceEntry {
  name: string;
  type: WorkspaceType;
  ref: string;
}

export interface TypePickItem extends vscode.QuickPickItem {
  type: WorkspaceType;
}

export const TYPE_ICONS: Record<WorkspaceType, string> = {
  issue: 'issue-opened',
  pr: 'git-pull-request',
  text: 'note',
  smart: 'lightbulb'
};

export function truncate(s: string, max = 30): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}
