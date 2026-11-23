// Visite guidée : une page (webview) par visite, rendue par l'extension à partir
// du JSON (voir walkthroughHtml.ts). Module pur, sans dépendance à vscode.
//
//   walkthrough.json  état (écrit par le serveur MCP) : titre, étapes, extraits ;
//                     l'extension le surveille et met la page à jour
//
// Les questions de l'utilisateur passent par l'agent (terminal) : il met à jour
// l'étape concernée (même `id`) en même temps qu'il répond.
import * as fs from 'fs';
import * as path from 'path';
import { ensureProjectDir, projectDataDir } from '../core/workspaceStore';

export type WalkMode = 'flow' | 'changes' | 'review' | 'gap';

// Zone de code citée par une étape. `snippet` est figé à la création : la page
// reste lisible même si le code change ensuite.
export interface WalkRef {
  path: string;
  // Première / dernière ligne de l'extrait (1-based), si une zone est visée.
  start?: number;
  end?: number;
  // Diff unifié au lieu du code (changement de petite taille).
  diff?: boolean;
  snippet?: string;
  // Rôle de ce snippet dans l'intention de l'étape (une ligne).
  note?: string;
}

export interface WalkStep {
  id: string;
  title: string;
  // Intention de la demande (issue, PR ou prompt) que l'étape sert, avec sa source.
  intent?: string;
  // Macro (markdown) : pourquoi ces extraits, ensemble, réalisent l'intention.
  text: string;
  refs: WalkRef[];
  updated_at: string;
}

export interface Walkthrough {
  title: string;
  // Le besoin de départ (issue, PR ou prompt), affiché en tête de page.
  goal?: string;
  mode?: WalkMode;
  workspace_id?: string;
  steps: WalkStep[];
  created_at: string;
  updated_at: string;
}

export function walkthroughFilePath(root: string): string {
  return path.join(projectDataDir(root), 'walkthrough.json');
}

export function readWalkthrough(root: string): Walkthrough | undefined {
  try {
    const data = JSON.parse(fs.readFileSync(walkthroughFilePath(root), 'utf8'));
    return data && Array.isArray(data.steps) ? data : undefined;
  } catch {
    return undefined;
  }
}

// Écriture atomique : l'extension surveille ce fichier et ne doit jamais le
// lire à moitié écrit.
export function writeWalkthrough(root: string, wt: Walkthrough): void {
  ensureProjectDir(root);
  const file = walkthroughFilePath(root);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(wt, null, 2));
  fs.renameSync(tmp, file);
}

export function deleteWalkthrough(root: string): boolean {
  const file = walkthroughFilePath(root);
  if (!fs.existsSync(file)) {
    return false;
  }
  fs.unlinkSync(file);
  return true;
}
