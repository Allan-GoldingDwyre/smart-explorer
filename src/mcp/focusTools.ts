// Tool `focus` : met un fichier/une plage en avant dans VS Code (ouverture,
// sélection, surlignage, sélection dans l'arbre). Demande ponctuelle, sans
// session : le serveur écrit focus.json, l'extension l'exécute.
import * as fs from 'fs';
import * as path from 'path';
import {
  MAX_DIFF_LINES,
  MAX_RANGE_LINES,
  clampEndLine,
  isSafeRelPath,
  isSafeRev,
  workspaceForFile,
} from '../core/focus';
import {
  DiffRequest,
  gitDiffStat,
  listWorkspaces,
  readActive,
  revExists,
  workspaceFiles,
  writeActive,
  writeFocus,
} from '../core/workspaceStore';
import { ToolEnv, err, nowIso, requireWorkspace } from './toolEnv';

export interface FocusTarget {
  path: string;
  line?: number;
  end_line?: number;
  match?: string;
  diff?: DiffRequest;
}

// Prépare une demande de mise en avant : valide les révisions d'un diff
// (erreur claire plutôt qu'un diff vide dans VS Code) et applique les
// garde-fous de granularité. Retourne la cible corrigée et des notes pour
// l'agent :
//  - un diff n'est gardé que pour un changement de taille raisonnable sur un
//    fichier qui existait déjà ; sinon on montre le code actuel ;
//  - la plage est plafonnée (une petite fonction, pas un fichier entier) ;
//  - sans `line`, `end_line` est ignorée (on parle du fichier entier).
export async function prepareFocus(
  env: ToolEnv,
  target: FocusTarget,
): Promise<{ target: FocusTarget; notes: string[] }> {
  const notes: string[] = [];
  const out: FocusTarget = { ...target };
  if (!isSafeRelPath(target.path)) {
    err(`chemin invalide : ${target.path}`);
  }

  const { end, clamped } = clampEndLine(target.line, target.end_line);
  out.end_line = end;
  if (clamped) {
    notes.push(
      `plage plafonnée à ${MAX_RANGE_LINES} lignes (une petite fonction, pas un gros bloc) : une étape par exemple`,
    );
  } else if (target.end_line !== undefined && target.line === undefined) {
    notes.push(
      'end_line ignorée sans line (fichier entier : aucune sélection)',
    );
  }

  const diff = target.diff;
  if (!diff) {
    return { target: out, notes };
  }
  for (const [name, rev] of [
    ['from', diff.from],
    ['to', diff.to],
  ] as const) {
    if (rev === undefined && name === 'to') {
      continue;
    }
    if (typeof rev !== 'string' || !isSafeRev(rev)) {
      err(
        `diff.${name} invalide : donne un SHA, une branche, un tag ou HEAD~N`,
      );
    }
    if (!(await revExists(env.root, rev))) {
      err(`diff.${name} : révision introuvable (${rev})`);
    }
  }
  if (diff.from_path !== undefined && !isSafeRelPath(diff.from_path)) {
    err(`chemin invalide dans diff : ${diff.from_path}`);
  }
  const stat = await gitDiffStat(
    env.root,
    diff.from,
    diff.to,
    target.path,
    diff.from_path,
  );
  if (!stat.existsAtFrom) {
    delete out.diff;
    notes.push(
      'diff ignoré : fichier nouveau (absent à `from`) ; code actuel affiché',
    );
  } else if (stat.changed === 0) {
    delete out.diff;
    notes.push('diff ignoré : aucun changement ; code actuel affiché');
  } else if (stat.changed > MAX_DIFF_LINES) {
    delete out.diff;
    notes.push(
      `diff ignoré : ${stat.changed} lignes modifiées (max ${MAX_DIFF_LINES}) ; code actuel affiché. Réserve le diff aux petits changements`,
    );
  }
  return { target: out, notes };
}

// Écrit la demande pour l'extension (canal : focus.json du dossier de données).
// Sans workspace explicite : celui qui contient le fichier (l'actif s'il en
// fait partie).
function requestFocus(
  env: ToolEnv,
  target: FocusTarget,
  workspaceId?: string,
): void {
  const relPath = target.path.replace(/\\/g, '/').replace(/^\.\//, '');
  const active = readActive(env.root);
  const holders = listWorkspaces(env.root)
    .filter((w) => workspaceFiles(w).includes(relPath))
    .map((w) => w.id);
  const resolved = workspaceId ?? workspaceForFile(holders, active);
  if (resolved && resolved !== active) {
    writeActive(env.root, resolved);
  }
  writeFocus(env.root, {
    path: relPath,
    line: target.line,
    end_line: target.end_line,
    match: target.match,
    diff: target.diff,
    workspace_id: resolved,
    at: nowIso(env),
  });
}

// VS Code ouvre le fichier, sélectionne la ligne (ou seulement `match`) ou la
// petite plage `line`..`end_line`, et le sélectionne dans l'arbre. Sans
// `line` : le fichier entier (aucune sélection). Retourne le chemin absolu
// (clients hors VS Code) et des `notes` quand un garde-fou a corrigé la
// demande (plage plafonnée, diff ignoré).
export async function focusTool(
  env: ToolEnv,
  args: FocusTarget & { workspace_id?: string },
): Promise<{
  ok: true;
  path: string;
  absolute_path: string;
  exists: boolean;
  notes?: string[];
}> {
  if (!args.path) {
    err('path requis');
  }
  if (args.workspace_id) {
    requireWorkspace(env, args.workspace_id);
  }
  const prepared = await prepareFocus(env, args);
  requestFocus(env, prepared.target, args.workspace_id);
  const absolute = path.join(env.root, args.path);
  return {
    ok: true,
    path: args.path,
    absolute_path: absolute,
    exists: fs.existsSync(absolute),
    ...(prepared.notes.length ? { notes: prepared.notes } : {}),
  };
}
