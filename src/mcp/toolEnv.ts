// Contexte et utilitaires partagés par les tools MCP (sans dépendance à
// 'vscode' : tout passe par ToolEnv, ce qui rend les tools testables sous
// plain Node).
import type { GithubResolver } from '../core/links';
import { WorkspaceFile, loadWorkspace } from '../core/workspaceStore';

export interface ToolEnv {
  // Racine du workspace VS Code (fsPath du 1er dossier ouvert).
  root: string;
  now?: () => Date;
  // Résolution issue/PR GitHub (défaut : `gh`) et dépôt d'origine (défaut :
  // remote `origin`) : remplaçables dans les tests.
  github?: GithubResolver;
  defaultRepo?: () => Promise<string | undefined>;
}

export function nowIso(env: ToolEnv): string {
  return (env.now ? env.now() : new Date()).toISOString();
}

export function err(message: string): never {
  throw new Error(message);
}

export function requireWorkspace(
  env: ToolEnv,
  workspaceId: string,
): WorkspaceFile {
  const ws = loadWorkspace(env.root, workspaceId);
  if (!ws) {
    err(`Workspace introuvable : ${workspaceId}`);
  }
  return ws;
}

export function stringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
    err(`${field} doit être une liste de chaînes`);
  }
  return value;
}
