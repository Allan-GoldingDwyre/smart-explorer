// Fusion de dossiers : à partir des fichiers choisis par l'agent, on reprend
// l'arborescence physique (un virtual dir par dossier) puis on la compacte en
// remontant les fichiers des petits dossiers vers leur parent. Les vrais
// fichiers ne bougent jamais : seuls les virtual dirs changent.
//
// Règles (de bas en haut) :
//  1. un dossier dont le sous-arbre contient moins de `min_folder_files`
//     fichiers est dissous dans son parent (les plus petits d'abord) ;
//  2. on s'arrête quand le parent dépasserait `max_loose_files` fichiers en
//     vrac (évite de fabriquer une longue liste plate) ;
//  3. absorption : un dossier sans fichier propre et avec un seul sous-dossier
//     absorbe ce sous-dossier (il garde son nom, prend ses fichiers et ses
//     sous-dossiers) ; un dossier avec des fichiers dont l'unique sous-dossier
//     est un simple conteneur (sans fichier) le fait disparaître. Valable aussi
//     pour la racine :
//       apps/backend/src/backend/internal/{x.py, services/s/y.py}
//         -> src/{x.py, services/{y.py}}   et   tests/unit/t.py -> tests/{t.py}
// Module pur (sans vscode, sans disque).
import { normalizeFiles } from './treeOps';
import type { VirtualDir } from './workspaceStore';

export interface FusionOptions {
  min_folder_files?: number;
  max_loose_files?: number;
}

export const DEFAULT_MIN_FOLDER_FILES = 3;
export const DEFAULT_MAX_LOOSE_FILES = 12;

interface Node {
  name: string;
  files: string[];
  dirs: Node[];
}

function size(node: Node): number {
  return node.files.length + node.dirs.reduce((n, d) => n + size(d), 0);
}

function allFiles(node: Node): string[] {
  return [...node.files, ...node.dirs.flatMap(allFiles)];
}

function buildTrie(files: string[]): Node {
  const root: Node = { name: '.', files: [], dirs: [] };
  for (const file of files) {
    const parts = file.split('/');
    let cur = root;
    for (const part of parts.slice(0, -1)) {
      let next = cur.dirs.find((d) => d.name === part);
      if (!next) {
        next = { name: part, files: [], dirs: [] };
        cur.dirs.push(next);
      }
      cur = next;
    }
    cur.files.push(file);
  }
  return root;
}

function fuse(node: Node, min: number, max: number): Node {
  node.dirs = node.dirs.map((d) => fuse(d, min, max));
  // 1-2. dissolution des petits dossiers, les plus petits d'abord, tant que
  // le parent reste lisible.
  const small = node.dirs
    .filter((d) => size(d) < min)
    .sort((a, b) => size(a) - size(b) || a.name.localeCompare(b.name));
  for (const d of small) {
    if (node.files.length + size(d) <= max) {
      node.files.push(...allFiles(d));
      node.dirs.splice(node.dirs.indexOf(d), 1);
    }
  }
  // 3. absorption des dossiers intermédiaires (voir l'en-tête).
  while (
    node.dirs.length === 1 &&
    (node.files.length === 0 || node.dirs[0].files.length === 0)
  ) {
    const child = node.dirs[0];
    node.files = [...node.files, ...child.files];
    node.dirs = child.dirs;
  }
  return node;
}

function toVirtualDir(node: Node, name: string): VirtualDir {
  const dir: VirtualDir = { name };
  const files = [...node.files].sort(
    (a, b) =>
      a.split('/').pop()!.localeCompare(b.split('/').pop()!) ||
      a.localeCompare(b),
  );
  if (files.length) {
    dir.files = files;
  }
  const dirs = [...node.dirs]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((d) => toVirtualDir(d, d.name));
  if (dirs.length) {
    dir.dirs = dirs;
  }
  return dir;
}

export function fuseTree(
  rawFiles: string[],
  options: FusionOptions = {},
): VirtualDir {
  const min = Math.max(1, options.min_folder_files ?? DEFAULT_MIN_FOLDER_FILES);
  const max = Math.max(1, options.max_loose_files ?? DEFAULT_MAX_LOOSE_FILES);
  const root = fuse(buildTrie(normalizeFiles(rawFiles)), min, max);
  return toVirtualDir(root, '.');
}
