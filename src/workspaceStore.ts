// Store YAML des workspaces : état partagé entre l'extension (rendering)
// et les tools MCP (agent). Un fichier par workspace :
//   <root>/.smart-explorer/workspaces/<id>.yaml
// Ce module est volontairement sans dépendance à 'vscode' pour rester
// testable sous plain Node.
import { execFile } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import YAML from 'yaml';

const execFileAsync = promisify(execFile);

export const STORE_DIR = '.smart-explorer/workspaces';

export type SourceType = 'issue' | 'pr' | 'text';
export type Lifecycle = 'exploration' | 'issue' | 'branche' | 'pr' | 'mergée';

export interface SourceInfo {
  type: SourceType;
  url: string;
  title?: string;
}

export interface Freshness {
  base_commit?: string;
  synced_at?: string;
  file_hashes?: Record<string, string>;
}

export interface VirtualDir {
  name: string;
  icon?: string;
  files?: string[];
  dirs?: VirtualDir[];
}

export interface WorkspaceFile {
  version: number;
  id: string;
  name?: string;
  source: SourceInfo;
  lifecycle?: Lifecycle;
  instructions?: string[];
  freshness?: Freshness;
  tree?: VirtualDir;
}

export function workspacesDir(root: string): string {
  return path.join(root, STORE_DIR);
}

export function workspaceFilePath(root: string, id: string): string {
  return path.join(workspacesDir(root), `${id}.yaml`);
}

// Slugifie un nom en id de workspace (kebab-case, ascii).
export function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'workspace';
}

export function parseWorkspaceYaml(content: string): WorkspaceFile {
  const doc = YAML.parse(content) as WorkspaceFile;
  if (!doc || typeof doc !== 'object' || !doc.id || !doc.source) {
    throw new Error('YAML de workspace invalide : champs id/source requis');
  }
  doc.version = doc.version ?? 1;
  return doc;
}

export function serializeWorkspaceYaml(ws: WorkspaceFile): string {
  return YAML.stringify(ws, { lineWidth: 100 });
}

export function loadWorkspace(
  root: string,
  id: string,
): WorkspaceFile | undefined {
  const file = workspaceFilePath(root, id);
  if (!fs.existsSync(file)) {
    return undefined;
  }
  return parseWorkspaceYaml(fs.readFileSync(file, 'utf8'));
}

export function listWorkspaceIds(root: string): string[] {
  const dir = workspacesDir(root);
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => f.slice(0, -'.yaml'.length))
    .sort();
}

export function listWorkspaces(root: string): WorkspaceFile[] {
  return listWorkspaceIds(root)
    .map((id) => {
      try {
        return loadWorkspace(root, id);
      } catch {
        return undefined;
      }
    })
    .filter((w): w is WorkspaceFile => !!w);
}

export function saveWorkspace(root: string, ws: WorkspaceFile): void {
  const dir = workspacesDir(root);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(workspaceFilePath(root, ws.id), serializeWorkspaceYaml(ws));
}

export function deleteWorkspace(root: string, id: string): boolean {
  const file = workspaceFilePath(root, id);
  if (!fs.existsSync(file)) {
    return false;
  }
  fs.unlinkSync(file);
  return true;
}

// Id unique : ajoute -2, -3... si le slug existe déjà.
export function uniqueWorkspaceId(root: string, base: string): string {
  const slug = slugify(base);
  if (!fs.existsSync(workspaceFilePath(root, slug))) {
    return slug;
  }
  for (let i = 2; ; i++) {
    const candidate = `${slug}-${i}`;
    if (!fs.existsSync(workspaceFilePath(root, candidate))) {
      return candidate;
    }
  }
}

// --- Fichiers ---

export function hashContent(content: Buffer | string): string {
  return 'sha256:' + createHash('sha256').update(content).digest('hex');
}

export function hashFileContent(file: string): string {
  return hashContent(fs.readFileSync(file));
}

export function fileExists(root: string, relPath: string): boolean {
  return fs.existsSync(path.join(root, relPath));
}

// Hash de contenu pour une liste de chemins relatifs (drift detection).
export function computeFileHashes(
  root: string,
  relPaths: string[],
): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const rel of relPaths) {
    const abs = path.join(root, rel);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      hashes[rel] = hashFileContent(abs);
    }
  }
  return hashes;
}

// Aplatit l'arbre virtuel en liste de chemins de fichiers.
export function flattenTreeFiles(dir: VirtualDir): string[] {
  const out: string[] = [...(dir.files ?? [])];
  for (const sub of dir.dirs ?? []) {
    out.push(...flattenTreeFiles(sub));
  }
  return out;
}

export function treeFiles(ws: WorkspaceFile): string[] {
  return ws.tree ? flattenTreeFiles(ws.tree) : [];
}

// Retire un chemin de l'arbre virtuel (tous les virtual dirs).
export function removeFileFromTree(tree: VirtualDir, relPath: string): boolean {
  let removed = false;
  if (tree.files) {
    const idx = tree.files.indexOf(relPath);
    if (idx >= 0) {
      tree.files.splice(idx, 1);
      removed = true;
    }
  }
  for (const sub of tree.dirs ?? []) {
    removed = removeFileFromTree(sub, relPath) || removed;
  }
  return removed;
}

// --- Git ---

export async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd: root });
  return stdout.trim();
}

export async function headCommit(root: string): Promise<string | undefined> {
  try {
    return await git(root, ['rev-parse', 'HEAD']);
  } catch {
    return undefined;
  }
}

export type DiffStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface DiffEntry {
  status: DiffStatus;
  path: string;
  old_path?: string;
}

// git diff --name-status <base>..HEAD, parsé en entrées typées.
export async function diffNameStatus(
  root: string,
  base: string,
): Promise<DiffEntry[]> {
  let out: string;
  try {
    out = await git(root, ['diff', '--name-status', '-M', `${base}..HEAD`]);
  } catch {
    return [];
  }
  const entries: DiffEntry[] = [];
  for (const line of out.split('\n')) {
    if (!line) {
      continue;
    }
    const [statusRaw, ...rest] = line.split('\t');
    const status = statusRaw[0].toLowerCase();
    if (status === 'r' || status === 'c') {
      entries.push({
        status: 'renamed',
        old_path: rest[0],
        path: rest[1] ?? rest[0],
      });
    } else if (status === 'a') {
      entries.push({ status: 'added', path: rest[0] });
    } else if (status === 'd') {
      entries.push({ status: 'deleted', path: rest[0] });
    } else {
      entries.push({ status: 'modified', path: rest[0] });
    }
  }
  return entries;
}

// Remote GitHub du repo (owner/repo) via 'origin' puis le 1er remote.
export async function githubRemote(
  root: string,
): Promise<{ owner: string; repo: string } | undefined> {
  const parse = (url: string) => {
    const m = url.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/i);
    return m ? { owner: m[1], repo: m[2] } : undefined;
  };
  try {
    return parse(await git(root, ['remote', 'get-url', 'origin']));
  } catch {
    try {
      const remotes = await git(root, ['remote']);
      const first = remotes.split('\n')[0];
      if (!first) {
        return undefined;
      }
      return parse(await git(root, ['remote', 'get-url', first]));
    } catch {
      return undefined;
    }
  }
}
