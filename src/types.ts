import * as vscode from 'vscode';

export type WorkspaceType = 'issue' | 'pr' | 'text' | 'smart';

export interface WorkspaceEntry {
  name: string;
  type: WorkspaceType;
  ref: string;
  instructions?: string[];
  // Arbre virtuel fourni par l'agent (virtual folders). S'il est présent,
  // il est affiché à la place de l'arbre physique du projet.
  tree?: FileTreeNode[];
}

export type FileTreeNodeType = 'file' | 'folder' | 'virtualFolder';

export interface FileTreeNode {
  name: string;
  // Chemin relatif depuis la racine du projet (les virtual folders
  // regroupent des fichiers venant de dossiers différents).
  path: string;
  type: FileTreeNodeType;
  children?: FileTreeNode[];
}

export interface TypePickItem extends vscode.QuickPickItem {
  type: WorkspaceType;
}

export const TYPE_ICONS: Record<WorkspaceType, string> = {
  issue: 'issue-opened',
  pr: 'git-pull-request',
  text: 'note',
  smart: 'lightbulb',
};

export function truncate(s: string, max = 30): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}
