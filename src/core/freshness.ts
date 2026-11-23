// Fraîcheur d'un workspace : les fichiers retenus ont-ils bougé depuis le
// commit où la liste a été validée (`base_commit`) ? Calcul déterministe à
// partir de git ; `get_workspace` le rapporte sans rien modifier, et
// `set_files { sync: true }` en applique la partie mécanique (suppressions,
// renommages). Décider des fichiers modifiés ou nouveaux reste à l'agent.
import {
  diffNameStatus,
  fileExists,
  headCommit,
  revExists,
} from './workspaceStore';

export interface Staleness {
  status: 'fresh' | 'stale' | 'never-synced';
  base_commit?: string;
  head?: string;
  // `base_commit` n'existe plus (rebase, force push) : le diff est inconnu.
  base_lost?: boolean;
  // Supprimés depuis base_commit.
  removed: string[];
  renamed: { from: string; to: string }[];
  // Modifiés depuis base_commit (contenu à relire).
  modified: string[];
  // Absents du disque (hors fichiers déjà listés ci-dessus).
  missing: string[];
}

export async function computeStaleness(
  root: string,
  files: string[],
  base?: string,
): Promise<Staleness> {
  const head = await headCommit(root);
  const result: Staleness = {
    status: 'never-synced',
    base_commit: base,
    head,
    removed: [],
    renamed: [],
    modified: [],
    missing: [],
  };
  if (base && head) {
    result.status = base === head ? 'fresh' : 'stale';
    if (base !== head) {
      if (!(await revExists(root, base))) {
        result.base_lost = true;
      } else {
        const tracked = new Set(files);
        for (const entry of await diffNameStatus(root, base)) {
          if (entry.status === 'renamed' && entry.old_path) {
            if (tracked.has(entry.old_path)) {
              result.renamed.push({ from: entry.old_path, to: entry.path });
            }
          } else if (tracked.has(entry.path)) {
            if (entry.status === 'deleted') {
              result.removed.push(entry.path);
            } else if (entry.status === 'modified') {
              result.modified.push(entry.path);
            }
          }
        }
      }
    }
  }
  const handled = new Set([
    ...result.removed,
    ...result.renamed.map((r) => r.from),
  ]);
  result.missing = files.filter((f) => !handled.has(f) && !fileExists(root, f));
  return result;
}

// Partie mécanique de la mise à jour : suit les renommages, retire les
// fichiers supprimés ou absents du disque.
export function applyStaleness(files: string[], s: Staleness): string[] {
  const renamed = new Map(s.renamed.map((r) => [r.from, r.to]));
  const dropped = new Set([...s.removed, ...s.missing]);
  const out: string[] = [];
  for (const f of files) {
    if (dropped.has(f)) {
      continue;
    }
    const next = renamed.get(f) ?? f;
    if (!out.includes(next)) {
      out.push(next);
    }
  }
  return out;
}
