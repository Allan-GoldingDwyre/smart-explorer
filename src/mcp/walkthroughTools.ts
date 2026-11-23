// Tools de la visite guidée : `add_step`, `get_walkthrough`,
// `delete_walkthrough`. L'agent pousse les étapes une à une ; chacune porte
// une explication et des extraits de code figés (cliquables dans la page). Le
// serveur écrit l'état JSON (voir walkthrough/walkthrough.ts), rendu par l'extension.
import * as fs from 'fs';
import * as path from 'path';
import { MAX_RANGE_LINES, resolveRange } from '../core/focus';
import { gitDiffText, readActive } from '../core/workspaceStore';
import {
  WalkMode,
  WalkRef,
  WalkStep,
  Walkthrough,
  deleteWalkthrough,
  readWalkthrough,
  writeWalkthrough,
} from '../walkthrough/walkthrough';
import { FocusTarget, prepareFocus } from './focusTools';
import { ToolEnv, err, nowIso, requireWorkspace } from './toolEnv';

const MAX_REFS_PER_STEP = 4;

// Extrait d'une zone de code (ou du diff) cité par une étape.
async function buildRef(
  env: ToolEnv,
  target: FocusTarget,
  notes: string[],
): Promise<WalkRef> {
  const prepared = await prepareFocus(env, target);
  notes.push(...prepared.notes.map((n) => `${target.path} : ${n}`));
  const { path: rel, line, end_line, match, diff } = prepared.target;
  const ref: WalkRef = { path: rel.replace(/\\/g, '/').replace(/^\.\//, '') };
  const abs = path.join(env.root, ref.path);
  let content: string;
  try {
    content = fs.readFileSync(abs, 'utf8');
  } catch {
    notes.push(`${ref.path} : fichier introuvable, lien sans extrait`);
    return ref;
  }
  if (!line && !match) {
    return ref; // fichier entier : lien seul
  }
  const { start, end } = resolveRange(content, line, end_line, match);
  ref.start = start;
  ref.end = Math.min(end, start + MAX_RANGE_LINES - 1);
  if (diff) {
    const text = await gitDiffText(
      env.root,
      diff.from,
      diff.to,
      ref.path,
      diff.from_path,
    );
    const hunks = text.slice(Math.max(0, text.indexOf('@@')));
    if (hunks) {
      ref.diff = true;
      ref.snippet = hunks;
      return ref;
    }
  }
  ref.snippet = content
    .split('\n')
    .slice(ref.start - 1, ref.end)
    .join('\n');
  return ref;
}

function nextStepId(wt: Walkthrough): string {
  const max = wt.steps.reduce((m, s) => {
    const n = /^step-(\d+)$/.exec(s.id);
    return n ? Math.max(m, Number(n[1])) : m;
  }, 0);
  return `step-${max + 1}`;
}

export interface AddStepResult {
  ok: true;
  step_id: string;
  position: number;
  total: number;
  // Étape créée (false : une étape de même `step_id` a été remplacée).
  created: boolean;
  notes?: string[];
}

// Ajoute une étape, ou remplace celle de même `step_id` (mise à jour après une
// question de l'utilisateur). La première étape crée la visite.
export async function addStepTool(
  env: ToolEnv,
  args: {
    title: string;
    text: string;
    refs?: FocusTarget[];
    step_id?: string;
    walkthrough_title?: string;
    mode?: WalkMode;
    workspace_id?: string;
  },
): Promise<AddStepResult> {
  if (!args.title?.trim() || !args.text?.trim()) {
    err('title et text requis');
  }
  const refs = args.refs ?? [];
  if (!Array.isArray(refs) || refs.length > MAX_REFS_PER_STEP) {
    err(
      `refs : au plus ${MAX_REFS_PER_STEP} zones par étape (une étape = une idée)`,
    );
  }
  if (args.workspace_id) {
    requireWorkspace(env, args.workspace_id);
  }
  const now = nowIso(env);
  const existing = readWalkthrough(env.root);
  const wt: Walkthrough = existing ?? {
    title: 'Visite guidée',
    steps: [],
    created_at: now,
    updated_at: now,
    workspace_id: args.workspace_id ?? readActive(env.root),
  };
  if (args.walkthrough_title?.trim()) {
    wt.title = args.walkthrough_title.trim();
  }
  if (args.mode) {
    wt.mode = args.mode;
  }

  const notes: string[] = [];
  const step: WalkStep = {
    id: args.step_id?.trim() || nextStepId(wt),
    title: args.title.trim(),
    text: args.text.trim(),
    refs: [],
    updated_at: now,
  };
  for (const target of refs) {
    step.refs.push(await buildRef(env, target, notes));
  }

  const index = wt.steps.findIndex((s) => s.id === step.id);
  if (index >= 0) {
    wt.steps[index] = step;
  } else {
    wt.steps.push(step);
  }
  wt.updated_at = now;
  writeWalkthrough(env.root, wt);
  return {
    ok: true,
    step_id: step.id,
    position: (index >= 0 ? index : wt.steps.length - 1) + 1,
    total: wt.steps.length,
    created: index < 0,
    ...(notes.length ? { notes } : {}),
  };
}

export interface WalkthroughDetails {
  exists: boolean;
  title?: string;
  mode?: WalkMode;
  workspace_id?: string;
  steps?: {
    id: string;
    title: string;
    text: string;
    refs: { path: string; start?: number; end?: number }[];
  }[];
}

// État de la visite (pour la reprendre ou mettre une étape à jour). Les
// extraits figés ne sont pas renvoyés.
export async function getWalkthroughTool(
  env: ToolEnv,
): Promise<WalkthroughDetails> {
  const wt = readWalkthrough(env.root);
  if (!wt) {
    return { exists: false };
  }
  return {
    exists: true,
    title: wt.title,
    mode: wt.mode,
    workspace_id: wt.workspace_id,
    steps: wt.steps.map((s) => ({
      id: s.id,
      title: s.title,
      text: s.text,
      refs: s.refs.map((r) => ({ path: r.path, start: r.start, end: r.end })),
    })),
  };
}

export async function deleteWalkthroughTool(
  env: ToolEnv,
): Promise<{ ok: true; deleted: boolean }> {
  return { ok: true, deleted: deleteWalkthrough(env.root) };
}
