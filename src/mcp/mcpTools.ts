// Logique des tools MCP exposés par l'extension. Module volontairement
// sans dépendance à 'vscode' : tout passe par l'objet ToolEnv, ce qui rend
// les tools testables sous plain Node. Le câblage vscode (createMcpServer)
// vit dans mcpServer.ts.
import * as fs from 'fs';
import * as path from 'path';
import {
  DiffEntry,
  DiffRequest,
  SourceType,
  VirtualDir,
  WorkspaceFile,
  computeFileHashes,
  flattenTreeFiles,
  diffNameStatus,
  fileExists,
  headCommit,
  listWorkspaces,
  readActive,
  gitDiffStat,
  readFollow,
  revExists,
  writeActive,
  writeFollow,
  loadWorkspace,
  saveWorkspace,
  treeFiles,
  uniqueWorkspaceId,
} from '../core/workspaceStore';
import {
  addFilesToTree,
  countFolders,
  normalizeFiles,
  normalizeTree,
  removeFilesFromTree,
} from '../core/treeOps';
import {
  WalkEvent,
  WalkMode,
  WalkSession,
  isUiAlive,
  readUiDisplay,
  readEvents,
  readWalkthrough,
  resetEvents,
  writeWalkthrough,
} from '../walkthrough/walkthrough';
import {
  MAX_DIFF_LINES,
  MAX_RANGE_LINES,
  clampEndLine,
  isSafeRelPath,
  isSafeRev,
  workspaceForFile,
} from '../core/focus';
import { FusionOptions, fuseTree } from '../core/treeFusion';

export interface ToolEnv {
  // Racine du workspace VS Code (fsPath du 1er dossier ouvert).
  root: string;
  now?: () => Date;
  // Attente (walkthrough_wait) : remplaçable dans les tests.
  sleep?: (ms: number) => Promise<void>;
}

function nowIso(env: ToolEnv): string {
  return (env.now ? env.now() : new Date()).toISOString();
}

function err(message: string): never {
  throw new Error(message);
}

function requireWorkspace(env: ToolEnv, workspaceId: string): WorkspaceFile {
  const ws = loadWorkspace(env.root, workspaceId);
  if (!ws) {
    err(`Workspace introuvable : ${workspaceId}`);
  }
  return ws;
}

// --- Détection de source (pur) ---

export interface DetectedSource {
  type: SourceType;
  ref: string;
}

export function detectSource(input: string): DetectedSource {
  const value = input.trim();
  const linearId = value.match(/^([A-Za-z][A-Za-z0-9]+-\d+)$/);
  if (linearId) {
    return { type: 'issue', ref: linearId[1].toUpperCase() };
  }
  if (/linear\.app\/[^/]+\/issue\/[A-Za-z][A-Za-z0-9]+-\d+/i.test(value)) {
    const m = value.match(/issue\/([A-Za-z][A-Za-z0-9]+-\d+)/i);
    return { type: 'issue', ref: (m?.[1] ?? value).toUpperCase() };
  }
  if (/github\.com\/[^/]+\/[^/]+\/pull\/\d+/i.test(value)) {
    return { type: 'pr', ref: value };
  }
  if (/github\.com\/[^/]+\/[^/]+\/issues\/\d+/i.test(value)) {
    return { type: 'issue', ref: value };
  }
  if (/^#\d+$/.test(value)) {
    return { type: 'issue', ref: value };
  }
  return { type: 'text', ref: value };
}

// --- Tools ---

export interface WorkspaceSummary {
  id: string;
  name: string;
  source_type: SourceType;
  source_url: string;
  lifecycle?: string;
  freshness: 'fresh' | 'stale' | 'never-synced';
  files_in_tree: number;
}

export async function listWorkspacesTool(env: ToolEnv): Promise<{
  workspaces: WorkspaceSummary[];
  active?: string;
}> {
  const head = await headCommit(env.root);
  const summaries: WorkspaceSummary[] = [];
  for (const ws of listWorkspaces(env.root)) {
    const base = ws.freshness?.base_commit;
    let freshness: WorkspaceSummary['freshness'] = 'never-synced';
    if (base && head) {
      freshness = base === head ? 'fresh' : 'stale';
    }
    summaries.push({
      id: ws.id,
      name: ws.name ?? ws.source.title ?? ws.id,
      source_type: ws.source.type,
      source_url: ws.source.url,
      lifecycle: ws.lifecycle,
      freshness,
      files_in_tree: treeFiles(ws).length,
    });
  }
  return { workspaces: summaries, active: readActive(env.root) };
}

export interface WorkspaceDetails {
  id: string;
  name: string;
  active: boolean;
  source: { type: SourceType; url: string };
  lifecycle?: string;
  // Le besoin de l'utilisateur sur l'issue/PR (voir create_workspace).
  instructions: string[];
  files: string[];
  tree?: VirtualDir;
}

// Lecture d'un workspace : source, besoin de l'utilisateur, fichiers retenus
// et arbre. Sert à s'appuyer sur l'issue/PR et sur le workspace actif (visite
// guidée, review) sans tout redemander.
export async function getWorkspaceTool(
  env: ToolEnv,
  args: { workspace_id?: string },
): Promise<WorkspaceDetails> {
  const id = args.workspace_id ?? readActive(env.root);
  if (!id) {
    err('aucun workspace actif : passe workspace_id (voir list_workspaces)');
  }
  const ws = requireWorkspace(env, id);
  return {
    id: ws.id,
    name: ws.name ?? ws.source.title ?? ws.id,
    active: readActive(env.root) === ws.id,
    source: { type: ws.source.type, url: ws.source.url },
    lifecycle: ws.lifecycle,
    instructions: ws.instructions ?? [],
    files: treeFiles(ws),
    tree: ws.tree,
  };
}

export async function createWorkspaceTool(
  env: ToolEnv,
  args: { source: string; name?: string; instructions?: string[] },
): Promise<{ workspace_id: string }> {
  if (!args.source || !args.source.trim()) {
    err('source requis (URL issue/PR GitHub ou Linear, ou texte)');
  }
  const detected = detectSource(args.source);
  const id = uniqueWorkspaceId(
    env.root,
    args.name ?? detected.ref ?? 'workspace',
  );
  const ws: WorkspaceFile = {
    version: 1,
    id,
    name: args.name ?? detected.ref,
    source: { type: detected.type, url: detected.ref },
    lifecycle:
      detected.type === 'pr'
        ? 'pr'
        : detected.type === 'issue'
          ? 'issue'
          : 'exploration',
    instructions: args.instructions ?? [],
    freshness: {},
  };
  saveWorkspace(env.root, ws);
  return { workspace_id: id };
}

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
async function prepareFocus(
  env: ToolEnv,
  target: FocusTarget,
): Promise<{ target: FocusTarget; notes: string[] }> {
  const notes: string[] = [];
  const out: FocusTarget = { ...target };

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
  for (const p of [target.path, diff.from_path]) {
    if (p !== undefined && !isSafeRelPath(p)) {
      err(`chemin invalide dans diff : ${p}`);
    }
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

// Met un fichier/une plage en avant pour l'extension (canal : follow.json du
// dossier de données). Sans workspace explicite : celui qui contient le
// fichier (l'actif s'il en fait partie). Relance toujours le suivi, même si
// l'utilisateur avait cliqué sur Stop côté VS Code.
function requestFocus(
  env: ToolEnv,
  target: FocusTarget,
  workspaceId?: string,
): { workspace?: string } {
  // (la cible a déjà été validée/corrigée par prepareFocus)
  if (!target.path || typeof target.path !== 'string') {
    err('focus.path requis');
  }
  const now = env.now ? env.now() : new Date();
  const relPath = target.path.replace(/\\/g, '/').replace(/^\.\//, '');
  const active = readActive(env.root);
  const holders = listWorkspaces(env.root)
    .filter((w) => treeFiles(w).includes(relPath))
    .map((w) => w.id);
  const resolved = workspaceId ?? workspaceForFile(holders, active);
  if (resolved && resolved !== active) {
    writeActive(env.root, resolved);
  }
  writeFollow(
    env.root,
    {
      status: 'following',
      focus: {
        path: relPath,
        line: target.line,
        end_line: target.end_line,
        match: target.match,
        diff: target.diff,
        workspace_id: resolved,
        at: now.toISOString(),
      },
    },
    now,
  );
  return { workspace: resolved };
}

// L'agent a terminé sa visite : la ligne « Following agent » et le
// surlignage disparaissent dans VS Code.
export async function stopFollowingTool(
  env: ToolEnv,
): Promise<{ ok: true; was: string }> {
  const now = env.now ? env.now() : new Date();
  const current = readFollow(env.root, now);
  writeFollow(env.root, { status: 'ended' }, now);
  endSession(env, now);
  return { ok: true, was: current?.status ?? 'none' };
}

export interface BuildTreeResult {
  ok: true;
  mode: 'fusion' | 'custom';
  files_count: number;
  folders_count: number;
  missing_files: string[];
}

// Enregistre l'arbre + la fraîcheur (base_commit, hashes) du workspace.
async function persistTree(
  env: ToolEnv,
  ws: WorkspaceFile,
  tree: VirtualDir,
  fusion?: FusionOptions,
): Promise<BuildTreeResult> {
  const files = flattenTreeFiles(tree);
  if (fusion) {
    ws.fusion = fusion;
  } else {
    delete ws.fusion;
  }
  ws.tree = tree;
  ws.freshness = {
    ...ws.freshness,
    base_commit: (await headCommit(env.root)) ?? ws.freshness?.base_commit,
    synced_at: nowIso(env),
    file_hashes: computeFileHashes(env.root, files),
  };
  saveWorkspace(env.root, ws);
  return {
    ok: true,
    mode: fusion ? 'fusion' : 'custom',
    files_count: files.length,
    folders_count: countFolders(tree),
    missing_files: files.filter((f) => !fileExists(env.root, f)),
  };
}

function stringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
    err(`${field} doit être une liste de chemins (chaînes)`);
  }
  return value;
}

function fusionOptions(args: {
  min_folder_files?: number;
  max_loose_files?: number;
}): FusionOptions {
  const out: FusionOptions = {};
  if (args.min_folder_files !== undefined) {
    out.min_folder_files = args.min_folder_files;
  }
  if (args.max_loose_files !== undefined) {
    out.max_loose_files = args.max_loose_files;
  }
  return out;
}

// Deux modes : `files` (l'agent choisit les fichiers, le serveur fusionne les
// dossiers) ou `tree` (l'agent décide de tout, l'arbre est pris tel quel après
// retrait des doublons et des dossiers vides).
export async function buildTreeTool(
  env: ToolEnv,
  args: {
    workspace_id: string;
    files?: string[];
    tree?: unknown;
    min_folder_files?: number;
    max_loose_files?: number;
    focus?: FocusTarget;
  },
): Promise<BuildTreeResult> {
  const ws = requireWorkspace(env, args.workspace_id);
  if ((args.files === undefined) === (args.tree === undefined)) {
    err(
      'fournis exactement un des deux : `files` (fusion automatique) ou `tree` (arbre défini par toi)',
    );
  }
  let result: BuildTreeResult;
  if (args.files !== undefined) {
    const options = fusionOptions(args);
    const tree = fuseTree(stringList(args.files, 'files'), options);
    result = await persistTree(env, ws, tree, options);
  } else {
    let tree: VirtualDir;
    try {
      tree = normalizeTree(args.tree);
    } catch (e) {
      err((e as Error).message);
    }
    result = await persistTree(env, ws, tree);
  }
  // Fin de construction : l'agent peut mettre en avant le fichier/la ligne
  // qui demande l'attention (ouvert dans VS Code, sélectionné dans l'arbre).
  if (args.focus) {
    const prepared = await prepareFocus(env, args.focus);
    requestFocus(env, prepared.target, ws.id);
  }
  return result;
}

// Ajoute/retire des fichiers. Arbre fusionné : la fusion est rejouée sur la
// nouvelle liste. Arbre défini par l'agent : les fichiers ajoutés vont dans
// `into` (dossier existant ou créé, "a/b" pour imbriquer ; absent = racine) et
// le reste de l'arbre est conservé.
export async function updateFilesTool(
  env: ToolEnv,
  args: {
    workspace_id: string;
    add?: string[];
    remove?: string[];
    into?: string;
  },
): Promise<BuildTreeResult> {
  const ws = requireWorkspace(env, args.workspace_id);
  const remove = new Set(
    normalizeFiles(stringList(args.remove ?? [], 'remove')),
  );
  const add = normalizeFiles(stringList(args.add ?? [], 'add'));
  if (ws.fusion) {
    if (args.into) {
      err(
        'into ne s’applique qu’à un arbre défini par `tree` ; ici les dossiers sont calculés par fusion',
      );
    }
    const files = normalizeFiles([...treeFiles(ws), ...add]).filter(
      (f) => !remove.has(f),
    );
    return persistTree(env, ws, fuseTree(files, ws.fusion), ws.fusion);
  }
  let tree = removeFilesFromTree(ws.tree ?? { name: '.' }, remove);
  tree = addFilesToTree(tree, add, args.into);
  return persistTree(env, ws, tree);
}

export async function setInstructionsTool(
  env: ToolEnv,
  args: { workspace_id: string; instructions: string[] },
): Promise<{ ok: true; instructions: string[] }> {
  const ws = requireWorkspace(env, args.workspace_id);
  if (!Array.isArray(args.instructions)) {
    err('instructions doit être une liste de chaînes');
  }
  ws.instructions = args.instructions.filter((i) => typeof i === 'string');
  saveWorkspace(env.root, ws);
  return { ok: true, instructions: ws.instructions };
}

export interface SyncDiff {
  workspace_id: string;
  base_commit?: string;
  head?: string;
  changed: DiffEntry[];
  drifted: string[];
}

export async function syncWorkspaceTool(
  env: ToolEnv,
  args: { workspace_id: string },
): Promise<SyncDiff> {
  const ws = requireWorkspace(env, args.workspace_id);
  const head = await headCommit(env.root);
  const base = ws.freshness?.base_commit;
  const changed: DiffEntry[] =
    base && head && base !== head ? await diffNameStatus(env.root, base) : [];
  // Drift : fichiers de l'arbre dont le hash courant diffère du hash enregistré.
  const recorded = ws.freshness?.file_hashes ?? {};
  const current = computeFileHashes(env.root, treeFiles(ws));
  const drifted: string[] = [];
  for (const [file, hash] of Object.entries(recorded)) {
    if (!(file in current) || current[file] !== hash) {
      drifted.push(file);
    }
  }
  return {
    workspace_id: ws.id,
    base_commit: base,
    head,
    changed,
    drifted,
  };
}

export async function applySyncTool(
  env: ToolEnv,
  args: { workspace_id: string; accepted: string[]; rejected: string[] },
): Promise<{
  ok: true;
  removed: string[];
  base_commit?: string;
  head?: string;
}> {
  const ws = requireWorkspace(env, args.workspace_id);
  const accepted = new Set(args.accepted ?? []);
  const rejected = new Set(args.rejected ?? []);
  const head = await headCommit(env.root);
  const base = ws.freshness?.base_commit;
  const diff =
    base && head && base !== head ? await diffNameStatus(env.root, base) : [];

  // Fichiers supprimés/renommés : retirés de l'arbre s'ils sont acceptés,
  // conservés (introuvables) s'ils sont rejetés.
  const removed: string[] = [];
  if (ws.tree) {
    const files = new Set(treeFiles(ws));
    for (const entry of diff) {
      if (entry.status !== 'deleted' && entry.status !== 'renamed') {
        continue;
      }
      const target =
        entry.status === 'renamed' ? entry.old_path ?? entry.path : entry.path;
      if (accepted.has(target) && !rejected.has(target)) {
        if (files.delete(target)) {
          removed.push(target);
        }
      }
    }
    if (removed.length) {
      ws.tree = ws.fusion
        ? fuseTree([...files], ws.fusion)
        : removeFilesFromTree(ws.tree, new Set(removed));
    }
  }
  ws.freshness = {
    base_commit: head ?? base,
    synced_at: nowIso(env),
    file_hashes: computeFileHashes(env.root, treeFiles(ws)),
  };
  saveWorkspace(env.root, ws);
  return { ok: true, removed, base_commit: ws.freshness.base_commit, head };
}

// --- Résolution de fichiers introuvables ---

export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (!m) {
    return n;
  }
  if (!n) {
    return m;
  }
  let prev = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) {
    prev[j] = j;
  }
  for (let i = 1; i <= m; i++) {
    const cur = new Array<number>(n + 1);
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[n];
}

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'out',
  'dist',
  '__pycache__',
  '.venv',
  'venv',
]);

// Liste les fichiers du repo (chemins relatifs), pour la résolution fuzzy.
function listRepoFiles(root: string, max = 5000): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    if (out.length >= max) {
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!IGNORED_DIRS.has(e.name)) {
          walk(child);
        }
      } else if (e.isFile()) {
        out.push(child);
      }
      if (out.length >= max) {
        return;
      }
    }
  };
  walk('');
  return out;
}

function similarity(missing: string, candidate: string): number {
  const baseMissing = path.basename(missing);
  const baseCandidate = path.basename(candidate);
  const nameDist = levenshtein(
    baseMissing.toLowerCase(),
    baseCandidate.toLowerCase(),
  );
  const pathDist = levenshtein(missing.toLowerCase(), candidate.toLowerCase());
  // Score 0..1 : même basename = très fort, sinon proximité de chemin.
  const nameScore = Math.max(0, 1 - nameDist / Math.max(baseMissing.length, 1));
  const pathScore = Math.max(0, 1 - pathDist / Math.max(missing.length, 1));
  return nameScore * 0.7 + pathScore * 0.3;
}

export interface MissingFileReport {
  path: string;
  candidates: { path: string; score: number }[];
}

export async function checkWorkspaceFilesTool(
  env: ToolEnv,
  args: { workspace_id: string },
): Promise<{ missing: MissingFileReport[]; ok: string[] }> {
  const ws = requireWorkspace(env, args.workspace_id);
  const files = treeFiles(ws);
  const repoFiles = listRepoFiles(env.root);
  const missing: MissingFileReport[] = [];
  const ok: string[] = [];
  for (const rel of files) {
    if (fileExists(env.root, rel)) {
      ok.push(rel);
      continue;
    }
    const candidates = repoFiles
      .map((c) => ({ path: c, score: similarity(rel, c) }))
      .filter((c) => c.score > 0.45)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
    missing.push({ path: rel, candidates });
  }
  return { missing, ok };
}

// --- Export de contexte ---

export interface ExportResult {
  workspace_id: string;
  files: string[];
  estimated_tokens: number;
  truncated: boolean;
  content: string;
}

export async function exportContextTool(
  env: ToolEnv,
  args: { workspace_id: string; max_tokens?: number },
): Promise<ExportResult> {
  const ws = requireWorkspace(env, args.workspace_id);
  const files = treeFiles(ws);
  const maxTokens =
    args.max_tokens && args.max_tokens > 0 ? args.max_tokens : undefined;
  // Estimation : ~4 caractères par token. On tronque en retirant les fichiers
  // les uns après les autres depuis la fin.
  const parts: string[] = [];
  let used = 0;
  let truncated = false;
  const kept: string[] = [];
  for (const rel of files) {
    const abs = path.join(env.root, rel);
    let content: string;
    try {
      content = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    const block = `--- ${rel} ---\n${content}\n`;
    const cost = Math.ceil(block.length / 4);
    if (maxTokens && used + cost > maxTokens) {
      truncated = true;
      continue;
    }
    parts.push(block);
    used += cost;
    kept.push(rel);
  }
  return {
    workspace_id: ws.id,
    files: kept,
    estimated_tokens: used,
    truncated,
    content: parts.join('\n'),
  };
}

// --- UI ---

// Met un fichier/une plage en avant : VS Code ouvre le fichier, sélectionne la
// ligne (ou seulement `match`) ou la petite plage `line`..`end_line`, et
// sélectionne le fichier dans l'arbre. Sans `line` : le fichier entier (aucune
// sélection). Retourne le chemin absolu (clients hors VS Code) et des `notes`
// quand un garde-fou a corrigé la demande (plage plafonnée, diff ignoré).
export async function revealFileTool(
  env: ToolEnv,
  args: {
    path: string;
    line?: number;
    end_line?: number;
    match?: string;
    diff?: DiffRequest;
    workspace_id?: string;
  },
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

// --- Visite guidée dans VS Code (étapes poussées une à une, fils de commentaire) ---

const WAIT_DEFAULT_S = 300;
const WAIT_MAX_S = 1800;
const WAIT_POLL_MS = 400;
// Dernier événement utilisateur consommé, par visite (mémoire du processus).
const consumedEvents = new Map<string, number>();

const THREAD_RE = /^(step|user)-\d+$/;

function activeSession(env: ToolEnv): WalkSession | undefined {
  const session = readWalkthrough(env.root);
  return session && session.status === 'active' ? session : undefined;
}

function requireSession(env: ToolEnv): WalkSession {
  const session = activeSession(env);
  if (!session) {
    err('aucune visite en cours : appelle walkthrough_start');
  }
  return session;
}

function touch(session: WalkSession, env: ToolEnv): void {
  session.updated_at = (env.now ? env.now() : new Date()).toISOString();
  writeWalkthrough(env.root, session);
}

// Commentaires de l'utilisateur pas encore consommés (aperçu, sans consommer) :
// l'agent peut y répondre sans attendre la fin de sa génération.
function pendingComments(env: ToolEnv, session: WalkSession) {
  const after = consumedEvents.get(session.id) ?? 0;
  return readEvents(env.root, after)
    .filter((e) => e.session === session.id && e.type === 'comment')
    .slice(0, 5)
    .map((e) => ({
      seq: e.seq,
      step: e.step,
      thread: e.thread,
      text: e.text,
      path: e.path,
      line: e.line,
    }));
}

// L'utilisateur a-t-il arrêté la visite dans VS Code (événement stop pas encore
// consommé) ? L'agent doit alors cesser de pousser des étapes.
function userStopped(env: ToolEnv, session: WalkSession): boolean {
  const after = consumedEvents.get(session.id) ?? 0;
  return readEvents(env.root, after).some(
    (e) => e.session === session.id && e.type === 'stop',
  );
}

function endSession(env: ToolEnv, now: Date): void {
  const session = readWalkthrough(env.root);
  if (session && session.status === 'active') {
    session.status = 'ended';
    session.updated_at = now.toISOString();
    writeWalkthrough(env.root, session);
  }
}

// Lance une visite : la suite (étapes, réponses) se passe dans VS Code. Si
// l'extension n'est pas active sur ce projet, on le dit (ui: false) pour que
// l'agent fasse la visite dans le terminal au lieu d'attendre dans le vide.
export async function walkthroughStartTool(
  env: ToolEnv,
  args: {
    mode: WalkMode;
    title?: string;
    workspace_id?: string;
    outline?: string[];
  },
): Promise<{
  ok: boolean;
  ui: boolean;
  display?: 'vscode' | 'cli';
  session?: string;
  note?: string;
}> {
  const now = env.now ? env.now() : new Date();
  if (!isUiAlive(env.root, now)) {
    return {
      ok: false,
      ui: false,
      note: "VS Code n'est pas ouvert sur ce projet (extension Smart Explorer inactive) : fais la visite dans le terminal.",
    };
  }
  if (!['flow', 'changes', 'review'].includes(args.mode)) {
    err('mode invalide : flow, changes ou review');
  }
  // Réglage « cli » : pas de fil de commentaire, VS Code ne sert qu'au focus
  // (reveal_file) ; l'agent explique dans le terminal et attend « go » ou une
  // question. Aucune session n'est créée.
  if (readUiDisplay(env.root) === 'cli') {
    return {
      ok: true,
      ui: false,
      display: 'cli',
      note: "Réglage smartExplorer.walkthrough.display = cli : pour chaque étape, `reveal_file` (focus/sélection dans VS Code), explique dans le terminal (1 à 2 phrases), puis demande « go » pour continuer ou une question. N'utilise pas walkthrough_step/walkthrough_wait.",
    };
  }
  const workspaceId = args.workspace_id ?? readActive(env.root);
  if (args.workspace_id) {
    requireWorkspace(env, args.workspace_id);
    writeActive(env.root, args.workspace_id);
  }
  const outline = (args.outline ?? [])
    .filter((t): t is string => typeof t === 'string' && !!t.trim())
    .map((t) => t.trim());
  const id = `wt-${now.getTime().toString(36)}`;
  resetEvents(env.root);
  consumedEvents.delete(id);
  writeWalkthrough(env.root, {
    id,
    mode: args.mode,
    title: args.title,
    workspace_id: workspaceId,
    outline,
    steps: [],
    complete: false,
    messages: [],
    status: 'active',
    updated_at: now.toISOString(),
  });
  return { ok: true, ui: true, display: 'vscode', session: id };
}

// Pousse l'étape suivante (affichée dans VS Code dès son arrivée). L'agent
// peut enchaîner les appels pendant que l'utilisateur lit l'étape 1.
export async function walkthroughStepTool(
  env: ToolEnv,
  args: {
    title: string;
    text: string;
    path: string;
    line?: number;
    end_line?: number;
    match?: string;
    diff?: DiffRequest;
    last?: boolean;
  },
): Promise<{
  ok: true;
  n: number;
  notes?: string[];
  stopped?: boolean;
  note?: string;
  pending_comments: ReturnType<typeof pendingComments>;
}> {
  const session = requireSession(env);
  if (!args.text?.trim() || !args.title?.trim()) {
    err('title et text requis');
  }
  if (!args.path) {
    err('path requis');
  }
  const prepared = await prepareFocus(env, {
    path: args.path,
    line: args.line,
    end_line: args.end_line,
    match: args.match,
    diff: args.diff,
  });
  const t = prepared.target;
  const n = session.steps.length + 1;
  session.steps.push({
    n,
    title: args.title.trim(),
    text: args.text.trim(),
    path: t.path.replace(/\\/g, '/').replace(/^\.\//, ''),
    line: t.line,
    end_line: t.end_line,
    match: t.match,
    diff: t.diff,
    at: (env.now ? env.now() : new Date()).toISOString(),
  });
  if (args.last === true) {
    session.complete = true;
  }
  touch(session, env);
  return {
    ok: true,
    n,
    ...(prepared.notes.length ? { notes: prepared.notes } : {}),
    ...(userStopped(env, session)
      ? {
          stopped: true,
          note: "L'utilisateur a arrêté la visite : arrête de pousser des étapes et appelle walkthrough_end.",
        }
      : {}),
    pending_comments: pendingComments(env, session),
  };
}

// Répond dans un fil de commentaire (`thread` vient d'un événement de
// walkthrough_wait ou de pending_comments).
export async function walkthroughReplyTool(
  env: ToolEnv,
  args: { thread: string; text: string },
): Promise<{
  ok: true;
  stopped?: boolean;
  pending_comments: ReturnType<typeof pendingComments>;
}> {
  const session = requireSession(env);
  if (!THREAD_RE.test(args.thread ?? '')) {
    err(
      'thread invalide (ex. step-2 ou user-5, tel que reçu dans l’événement)',
    );
  }
  if (!args.text?.trim()) {
    err('text requis');
  }
  session.messages.push({
    thread: args.thread,
    text: args.text.trim(),
    at: (env.now ? env.now() : new Date()).toISOString(),
  });
  touch(session, env);
  return {
    ok: true,
    ...(userStopped(env, session) ? { stopped: true } : {}),
    pending_comments: pendingComments(env, session),
  };
}

// Attend une action de l'utilisateur dans VS Code : un commentaire (à qui tu
// réponds avec walkthrough_reply) ou l'arrêt. Continuer/Précédent sont gérés
// par l'extension seule : ils ne te réveillent pas. Bloque jusqu'à
// `timeout_s` (défaut 300 s, max 1800), puis rend la main avec idle: true.
export async function walkthroughWaitTool(
  env: ToolEnv,
  args: { timeout_s?: number },
): Promise<{
  status: 'active' | 'ended';
  events: WalkEvent[];
  idle?: boolean;
  current_step: number;
  steps_ready: number;
  complete: boolean;
}> {
  const first = readWalkthrough(env.root);
  if (!first) {
    err('aucune visite : appelle walkthrough_start');
  }
  const id = first.id;
  const seconds = Math.min(
    Math.max(args.timeout_s ?? WAIT_DEFAULT_S, 1),
    WAIT_MAX_S,
  );
  const rounds = Math.ceil((seconds * 1000) / WAIT_POLL_MS);
  const sleep =
    env.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let currentStep = 1;
  // Preuve de vie pendant l'attente : sans écriture du serveur depuis 45 min,
  // l'interface considère la visite comme abandonnée (agent interrompu).
  const touchEvery = Math.round(60_000 / WAIT_POLL_MS);
  for (let i = 0; i <= rounds; i++) {
    const session = readWalkthrough(env.root);
    if (
      session &&
      session.id === id &&
      session.status === 'active' &&
      i % touchEvery === 0
    ) {
      touch(session, env);
    }
    if (!session || session.id !== id) {
      return {
        status: 'ended',
        events: [],
        current_step: currentStep,
        steps_ready: first.steps.length,
        complete: true,
      };
    }
    const after = consumedEvents.get(id) ?? 0;
    const fresh = readEvents(env.root, after).filter((e) => e.session === id);
    if (fresh.length) {
      consumedEvents.set(id, fresh[fresh.length - 1].seq);
      currentStep = fresh[fresh.length - 1].step;
      const relevant = fresh.filter(
        (e) => e.type === 'comment' || e.type === 'stop',
      );
      if (relevant.length) {
        const stopped = relevant.some((e) => e.type === 'stop');
        if (stopped) {
          endSession(env, env.now ? env.now() : new Date());
        }
        return {
          status: stopped ? 'ended' : 'active',
          events: relevant,
          current_step: currentStep,
          steps_ready: session.steps.length,
          complete: session.complete,
        };
      }
    }
    if (session.status === 'ended') {
      return {
        status: 'ended',
        events: [],
        current_step: currentStep,
        steps_ready: session.steps.length,
        complete: session.complete,
      };
    }
    if (i < rounds) {
      await sleep(WAIT_POLL_MS);
    }
  }
  const last = readWalkthrough(env.root);
  return {
    status: 'active',
    events: [],
    idle: true,
    current_step: currentStep,
    steps_ready: last?.steps.length ?? 0,
    complete: last?.complete ?? false,
  };
}

// Termine la visite : les fils disparaissent dans VS Code.
export async function walkthroughEndTool(
  env: ToolEnv,
): Promise<{ ok: true; was: string }> {
  const now = env.now ? env.now() : new Date();
  const session = readWalkthrough(env.root);
  const was = session?.status ?? 'none';
  endSession(env, now);
  writeFollow(env.root, { status: 'ended' }, now);
  return { ok: true, was };
}

export async function setActiveWorkspaceTool(
  env: ToolEnv,
  args: { workspace_id: string },
): Promise<{ ok: true; active: string }> {
  requireWorkspace(env, args.workspace_id);
  writeActive(env.root, args.workspace_id);
  return { ok: true, active: args.workspace_id };
}
