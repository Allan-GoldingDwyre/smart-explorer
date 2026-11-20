import type { SourceType } from './workspaceStore';

export type FileTreeNodeType = 'file' | 'virtualFolder';

export interface FileTreeNode {
  name: string;
  // Chemin relatif depuis la racine du projet (vide pour un virtual folder).
  path: string;
  type: FileTreeNodeType;
}

export const TYPE_ICONS: Record<SourceType, string> = {
  issue: 'issue-opened',
  pr: 'git-pull-request',
  text: 'note',
};

export function truncate(s: string, max = 30): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}
