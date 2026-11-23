export interface FileTreeNode {
  name: string;
  // Chemin relatif depuis la racine du projet (vide pour un virtual folder).
  path: string;
  type: 'file' | 'virtualFolder';
}

// Nature d'un workspace d'après ses liens (voir workspaceKind).
export const TYPE_ICONS: Record<'issue' | 'pr' | 'text', string> = {
  issue: 'issue-opened',
  pr: 'git-pull-request',
  text: 'note',
};

export function truncate(s: string, max = 30): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}
