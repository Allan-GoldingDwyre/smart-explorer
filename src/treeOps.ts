// Opérations sur l'arbre virtuel fourni par l'agent : validation, doublons,
// ajout/retrait de fichiers. Module pur (sans vscode, sans disque). L'agent
// décide des dossiers ; ici on ne fait que garantir un arbre valide.
import { VirtualDir, dedupeTree } from './workspaceStore';

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

// Valide/normalise un arbre fourni par l'agent : noms requis, chemins
// normalisés, doublons retirés (le dossier le plus profond gagne), dossiers
// vides supprimés. Aucune limite de forme n'est imposée.
export function normalizeTree(node: unknown): VirtualDir {
  const walk = (n: any, root: boolean): VirtualDir => {
    if (!n || typeof n !== 'object') {
      throw new Error(
        'tree invalide : chaque dossier doit être un objet { name, files?, dirs? }',
      );
    }
    const name = root ? '.' : typeof n.name === 'string' ? n.name.trim() : '';
    if (!name) {
      throw new Error(
        'tree invalide : chaque dossier doit avoir un name non vide',
      );
    }
    if (
      n.files !== undefined &&
      (!Array.isArray(n.files) ||
        !n.files.every((f: unknown) => typeof f === 'string'))
    ) {
      throw new Error(
        `tree invalide : files de "${name}" doit être une liste de chemins`,
      );
    }
    if (n.dirs !== undefined && !Array.isArray(n.dirs)) {
      throw new Error(`tree invalide : dirs de "${name}" doit être une liste`);
    }
    const dir: VirtualDir = { name };
    const files = normalizeFiles(n.files ?? []);
    if (files.length) {
      dir.files = files;
    }
    const dirs = (n.dirs ?? []).map((d: unknown) => walk(d, false));
    if (dirs.length) {
      dir.dirs = dirs;
    }
    return dir;
  };
  return dedupeTree(walk(node, true));
}

export function countFolders(dir: VirtualDir): number {
  return (dir.dirs ?? []).reduce((n, d) => n + 1 + countFolders(d), 0);
}

// Retire des fichiers d'un arbre (dossiers devenus vides supprimés).
export function removeFilesFromTree(
  dir: VirtualDir,
  remove: Set<string>,
): VirtualDir {
  const out: VirtualDir = { ...dir };
  delete out.files;
  delete out.dirs;
  const files = (dir.files ?? []).filter((f) => !remove.has(f));
  const dirs = (dir.dirs ?? [])
    .map((d) => removeFilesFromTree(d, remove))
    .filter((d) => (d.files?.length ?? 0) + (d.dirs?.length ?? 0) > 0);
  if (files.length) out.files = files;
  if (dirs.length) out.dirs = dirs;
  return out;
}

// Ajoute des fichiers dans un dossier de l'arbre ("a/b" crée/traverse les
// niveaux ; vide ou "." = racine). Les doublons sont retirés ensuite.
export function addFilesToTree(
  dir: VirtualDir,
  files: string[],
  folder?: string,
): VirtualDir {
  const out: VirtualDir = JSON.parse(JSON.stringify(dir));
  let target = out;
  for (const part of (folder ?? '')
    .split('/')
    .map((p) => p.trim())
    .filter((p) => p && p !== '.')) {
    target.dirs = target.dirs ?? [];
    let next = target.dirs.find((d) => d.name === part);
    if (!next) {
      next = { name: part };
      target.dirs.push(next);
    }
    target = next;
  }
  target.files = [...(target.files ?? []), ...files];
  return dedupeTree(out);
}
