// Logique des tools MCP exposés par l'extension. Module volontairement
// sans dépendance à 'vscode' : tout passe par l'objet ToolEnv, ce qui rend
// les tools testables sous plain Node. Le câblage vscode (createMcpServer)
// vit dans mcpServer.ts.
import * as fs from 'fs';
import * as path from 'path';
import {
  DiffEntry,
  SourceType,
  WorkspaceFile,
  computeFileHashes,
  deleteWorkspace,
  diffNameStatus,
  fileExists,
  flattenTreeFiles,
  githubRemote,
  headCommit,
  listWorkspaces,
  loadWorkspace,
  removeFileFromTree,
  saveWorkspace,
  treeFiles,
  uniqueWorkspaceId,
  workspaceFilePath,
} from './workspaceStore';

export interface ToolEnv {
  // Racine du workspace VS Code (fsPath du 1er dossier ouvert).
  root: string;
  // Hooks UI fournis par l'extension (reveal_file, set_active_workspace).
  revealFile?: (
    relPath: string,
    where: 'editor' | 'tree',
  ) => void | Promise<void>;
  setActiveWorkspace?: (id: string) => void;
  getActiveWorkspace?: () => string | undefined;
  // Tokens optionnels pour fetch_source (GitHub via session VS Code, Linear via secrets).
  githubToken?: () => Promise<string | undefined>;
  linearToken?: () => Promise<string | undefined>;
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

interface GithubRef {
  owner: string;
  repo: string;
  num: string;
  kind: 'issues' | 'pulls';
}

function parseGithubUrl(ref: string): GithubRef | undefined {
  const m = ref.match(/github\.com\/([^/]+)\/([^/]+)\/(issues|pull)\/(\d+)/i);
  if (!m) {
    return undefined;
  }
  return {
    owner: m[1],
    repo: m[2],
    kind: m[3].toLowerCase() === 'pull' ? 'pulls' : 'issues',
    num: m[4],
  };
}

async function resolveGithubRef(
  env: ToolEnv,
  ref: string,
  type: SourceType,
): Promise<GithubRef | undefined> {
  const fromUrl = parseGithubUrl(ref);
  if (fromUrl) {
    return fromUrl;
  }
  const short = ref.match(/^#(\d+)$/);
  if (short) {
    const remote = await githubRemote(env.root);
    if (remote) {
      return {
        ...remote,
        num: short[1],
        kind: type === 'pr' ? 'pulls' : 'issues',
      };
    }
  }
  return undefined;
}

export function isLinearRef(ref: string): boolean {
  return /^[A-Z][A-Z0-9]+-\d+$/.test(ref.trim());
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
  return { workspaces: summaries, active: env.getActiveWorkspace?.() };
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

export interface CanonicalSource {
  type: SourceType;
  url: string;
  title?: string;
  description?: string;
  files?: string[];
  head_sha?: string;
}

export async function fetchSourceTool(
  env: ToolEnv,
  args: { ref: string },
): Promise<CanonicalSource> {
  const detected = detectSource(args.ref);
  if (detected.type === 'text') {
    return { type: 'text', url: detected.ref, description: detected.ref };
  }
  if (isLinearRef(detected.ref)) {
    const token = env.linearToken ? await env.linearToken() : undefined;
    if (!token) {
      err(`Ref Linear ${detected.ref} : aucune clé API Linear configurée`);
    }
    const res = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: { Authorization: token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query:
          'query($id: String!) { issue(id: $id) { title description url } }',
        variables: { id: detected.ref },
      }),
    });
    if (!res.ok) {
      err(`Linear API a répondu ${res.status}`);
    }
    const data = (await res.json()) as {
      data?: { issue?: { title?: string; description?: string; url?: string } };
    };
    const issue = data.data?.issue;
    if (!issue) {
      err(`Issue Linear introuvable : ${detected.ref}`);
    }
    return {
      type: 'issue',
      url: issue.url ?? detected.ref,
      title: issue.title,
      description: issue.description ?? undefined,
    };
  }
  const gh = await resolveGithubRef(env, detected.ref, detected.type);
  if (!gh) {
    err(`Ref GitHub non résoluble : ${detected.ref}`);
  }
  const url = `https://github.com/${gh.owner}/${gh.repo}/${
    gh.kind === 'pulls' ? 'pull' : 'issues'
  }/${gh.num}`;
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'smart-explorer',
  };
  const token = env.githubToken ? await env.githubToken() : undefined;
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const base = `https://api.github.com/repos/${gh.owner}/${gh.repo}`;
  const res = await fetch(`${base}/${gh.kind}/${gh.num}`, { headers });
  if (!res.ok) {
    err(`GitHub API a répondu ${res.status} pour ${url}`);
  }
  const data = (await res.json()) as {
    title?: string;
    body?: string;
    head?: { sha?: string };
  };
  const out: CanonicalSource = {
    type: gh.kind === 'pulls' ? 'pr' : 'issue',
    url,
    title: data.title,
    description: data.body ?? undefined,
    head_sha: data.head?.sha,
  };
  if (gh.kind === 'pulls') {
    const filesRes = await fetch(`${base}/pulls/${gh.num}/files?per_page=100`, {
      headers,
    });
    if (filesRes.ok) {
      const files = (await filesRes.json()) as { filename?: string }[];
      out.files = files.map((f) => f.filename ?? '').filter(Boolean);
    }
  }
  return out;
}

export async function buildTreeTool(
  env: ToolEnv,
  args: { workspace_id: string; tree: unknown },
): Promise<{ ok: true; files_count: number }> {
  const ws = requireWorkspace(env, args.workspace_id);
  const tree = normalizeVirtualDir(args.tree, true);
  if (!tree) {
    err('tree invalide : objet avec name requis');
  }
  ws.tree = tree;
  ws.freshness = {
    ...ws.freshness,
    base_commit: (await headCommit(env.root)) ?? ws.freshness?.base_commit,
    synced_at: nowIso(env),
    file_hashes: computeFileHashes(env.root, flattenTreeFiles(tree)),
  };
  saveWorkspace(env.root, ws);
  return { ok: true, files_count: flattenTreeFiles(tree).length };
}

// Valide/normalise un virtual dir coming from l'agent. `root` est true pour
// le noeud racine (name '.' accepté), false pour les sous-dossiers.
function normalizeVirtualDir(
  node: any,
  root: boolean,
): import('./workspaceStore').VirtualDir | undefined {
  if (!node || typeof node !== 'object' || typeof node.name !== 'string') {
    return undefined;
  }
  if (!root && !node.name.trim()) {
    return undefined;
  }
  const dir: import('./workspaceStore').VirtualDir = {
    name: root ? '.' : node.name,
  };
  if (typeof node.icon === 'string' && node.icon.trim()) {
    dir.icon = node.icon.trim();
  }
  if (Array.isArray(node.files)) {
    dir.files = node.files.filter((f: any) => typeof f === 'string');
  }
  if (Array.isArray(node.dirs)) {
    const subs = node.dirs
      .map((d: any) => normalizeVirtualDir(d, false))
      .filter((d: any) => !!d);
    if (subs.length) {
      dir.dirs = subs;
    }
  }
  return dir;
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
    for (const entry of diff) {
      if (entry.status !== 'deleted' && entry.status !== 'renamed') {
        continue;
      }
      const target =
        entry.status === 'renamed' ? entry.old_path ?? entry.path : entry.path;
      if (accepted.has(target) && !rejected.has(target)) {
        if (removeFileFromTree(ws.tree, target)) {
          removed.push(target);
        }
      }
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
  '.smart-explorer',
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

export type ExportMode = 'primary' | 'with_dependencies';

export interface ExportResult {
  workspace_id: string;
  mode: ExportMode;
  files: string[];
  estimated_tokens: number;
  truncated: boolean;
  content: string;
}

// Détection légère des dépendances directes (imports Python / TS-JS).
export function findDirectDependencies(
  root: string,
  relPath: string,
  allFiles: string[],
): string[] {
  const abs = path.join(root, relPath);
  let content: string;
  try {
    content = fs.readFileSync(abs, 'utf8');
  } catch {
    return [];
  }
  const dir = path.dirname(relPath);
  const wanted = new Set<string>();
  const moduleOf = (spec: string): string =>
    spec.replace(/\.py$/, '').replace(/\//g, '.');
  // Python : from x.y import z / import x.y
  for (const m of content.matchAll(/^\s*from\s+([\w.]+)\s+import/gm)) {
    wanted.add(moduleOf(m[1]));
  }
  for (const m of content.matchAll(/^\s*import\s+([\w.]+)/gm)) {
    wanted.add(moduleOf(m[1]));
  }
  // TS/JS : from './x' / from '../x' / from '@/x'
  for (const m of content.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
    const spec = m[1];
    if (spec.startsWith('.')) {
      const resolved = path.posix.normalize(path.posix.join(dir, spec));
      wanted.add(resolved);
    }
  }
  const candidates = new Set(allFiles);
  const deps = new Set<string>();
  for (const w of wanted) {
    for (const ext of ['', '.py', '.ts', '.js', '.tsx', '.jsx']) {
      const p =
        (w.startsWith('.') || w.includes('/') ? w : w.replace(/\./g, '/')) +
        ext;
      if (candidates.has(p)) {
        deps.add(p);
      }
      const idx = p + '/index';
      for (const ext2 of ['.py', '.ts', '.js']) {
        if (candidates.has(idx + ext2)) {
          deps.add(idx + ext2);
        }
      }
    }
  }
  deps.delete(relPath);
  return [...deps];
}

export async function exportContextTool(
  env: ToolEnv,
  args: { workspace_id: string; mode?: ExportMode; max_tokens?: number },
): Promise<ExportResult> {
  const ws = requireWorkspace(env, args.workspace_id);
  const mode: ExportMode =
    args.mode === 'with_dependencies' ? 'with_dependencies' : 'primary';
  let files = treeFiles(ws);
  if (mode === 'with_dependencies') {
    const all = listRepoFiles(env.root);
    const extra = new Set<string>();
    for (const f of files) {
      for (const dep of findDirectDependencies(env.root, f, all)) {
        if (!files.includes(dep)) {
          extra.add(dep);
        }
      }
    }
    files = [...files, ...extra];
  }
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
    mode,
    files: kept,
    estimated_tokens: used,
    truncated,
    content: parts.join('\n'),
  };
}

// --- UI ---

export async function revealFileTool(
  env: ToolEnv,
  args: { path: string; workspace_id?: string; reveal: 'editor' | 'tree' },
): Promise<{ ok: true; path: string; reveal: string }> {
  if (!args.path) {
    err('path requis');
  }
  if (args.workspace_id) {
    requireWorkspace(env, args.workspace_id);
  }
  if (!env.revealFile) {
    err('reveal_file non disponible hors VS Code');
  }
  await env.revealFile(args.path, args.reveal ?? 'editor');
  return { ok: true, path: args.path, reveal: args.reveal ?? 'editor' };
}

export async function setActiveWorkspaceTool(
  env: ToolEnv,
  args: { workspace_id: string },
): Promise<{ ok: true; active: string }> {
  requireWorkspace(env, args.workspace_id);
  if (!env.setActiveWorkspace) {
    err('set_active_workspace non disponible hors VS Code');
  }
  env.setActiveWorkspace(args.workspace_id);
  return { ok: true, active: args.workspace_id };
}

export { deleteWorkspace, workspaceFilePath };
