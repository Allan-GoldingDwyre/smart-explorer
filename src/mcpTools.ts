// Logique des tools MCP exposés par l'extension. Module volontairement
// sans dépendance à 'vscode' : tout passe par l'objet ToolEnv, ce qui rend
// les tools testables sous plain Node. Le câblage vscode (createMcpServer)
// vit dans mcpServer.ts.
import * as fs from 'fs';
import * as path from 'path';
import {
  DiffEntry,
  SourceType,
  VirtualDir,
  WorkspaceFile,
  computeFileHashes,
  flattenTreeFiles,
  deleteWorkspace,
  diffNameStatus,
  fileExists,
  headCommit,
  listWorkspaces,
  readActive,
  writeActive,
  loadWorkspace,
  saveWorkspace,
  treeFiles,
  uniqueWorkspaceId,
  workspaceFilePath,
} from './workspaceStore';
import {
  addFilesToTree,
  countFolders,
  normalizeFiles,
  normalizeTree,
  removeFilesFromTree,
} from './treeOps';
import { FusionOptions, fuseTree } from './treeFusion';

export interface ToolEnv {
  // Racine du workspace VS Code (fsPath du 1er dossier ouvert).
  root: string;
  now?: () => Date;
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
  },
): Promise<BuildTreeResult> {
  const ws = requireWorkspace(env, args.workspace_id);
  if ((args.files === undefined) === (args.tree === undefined)) {
    err(
      'fournis exactement un des deux : `files` (fusion automatique) ou `tree` (arbre défini par toi)',
    );
  }
  if (args.files !== undefined) {
    const options = fusionOptions(args);
    const tree = fuseTree(stringList(args.files, 'files'), options);
    return persistTree(env, ws, tree, options);
  }
  let tree: VirtualDir;
  try {
    tree = normalizeTree(args.tree);
  } catch (e) {
    err((e as Error).message);
  }
  return persistTree(env, ws, tree);
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
export function listRepoFiles(root: string, max = 5000): string[] {
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

// Le client ouvre le fichier lui-même : on retourne son chemin absolu.
export async function revealFileTool(
  env: ToolEnv,
  args: { path: string; workspace_id?: string },
): Promise<{ ok: true; path: string; absolute_path: string }> {
  if (!args.path) {
    err('path requis');
  }
  if (args.workspace_id) {
    requireWorkspace(env, args.workspace_id);
  }
  return {
    ok: true,
    path: args.path,
    absolute_path: path.join(env.root, args.path),
  };
}

export async function setActiveWorkspaceTool(
  env: ToolEnv,
  args: { workspace_id: string },
): Promise<{ ok: true; active: string }> {
  requireWorkspace(env, args.workspace_id);
  writeActive(env.root, args.workspace_id);
  return { ok: true, active: args.workspace_id };
}

export { deleteWorkspace, workspaceFilePath };
