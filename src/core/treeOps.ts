// Utilitaires sur les chemins de fichiers d'un workspace. Module pur (sans
// vscode, sans disque). L'arbre affiché n'est jamais stocké : voir fuseTree.
import type { VirtualDir } from './workspaceStore';

// Normalise une liste de chemins : trim, séparateurs `/`, sans `./`, sans doublon.
export function normalizeFiles(files: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of files) {
    if (typeof raw !== 'string') {
      continue;
    }
    const f = raw.trim().replace(/\\/g, '/').replace(/^\.\//, '');
    if (f && !seen.has(f)) {
      seen.add(f);
      out.push(f);
    }
  }
  return out;
}

export function countFolders(dir: VirtualDir): number {
  return (dir.dirs ?? []).reduce((n, d) => n + 1 + countFolders(d), 0);
}
