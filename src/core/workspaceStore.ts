// Store YAML des workspaces : état partagé entre l'extension (rendering)
// et les tools MCP (agent). Les données sont de la métadonnée utilisateur : elles
// vivent hors du projet, dans le dossier de données de l'utilisateur :
//   <data home>/projects/<nom>-<hash du chemin>/workspaces/<id>.yaml
//   <data home>/projects/<nom>-<hash du chemin>/active
// <data home> = $SMART_EXPLORER_HOME, sinon $XDG_DATA_HOME/smart-explorer,
// sinon ~/.local/share/smart-explorer (%APPDATA% sous Windows).
// Ce module est volontairement sans dépendance à 'vscode' pour rester
// testable sous plain Node.
import { execFile } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import YAML from 'yaml';

const execFileAsync = promisify(execFile);

// Ancien emplacement (dans le projet), migré au démarrage.
const LEGACY_DIR = '.smart-explorer';

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
  // Présent quand l'arbre a été construit par fusion à partir d'une liste de
  // fichiers (options utilisées, rejouées par update_files/apply_sync). Absent :
  // arbre défini tel quel par l'agent.
  fusion?: { min_folder_files?: number; max_loose_files?: number };
}

export function dataHome(): string {
  if (process.env.SMART_EXPLORER_HOME) {
    return path.resolve(process.env.SMART_EXPLORER_HOME);
  }
  const base =
    process.env.XDG_DATA_HOME ||
    (process.platform === 'win32' ? process.env.APPDATA : undefined) ||
    path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'smart-explorer');
}

function realPath(root: string): string {
  try {
    return fs.realpathSync(root);
  } catch {
    return path.resolve(root);
  }
}

// Clé stable d'un projet : nom du dossier + hash de son chemin réel.
export function projectKey(root: string): string {
  const real = realPath(root);
  const hash = createHash('sha1').update(real).digest('hex').slice(0, 8);
  return `${slugify(path.basename(real))}-${hash}`;
}

export function projectDataDir(root: string): string {
  return path.join(dataHome(), 'projects', projectKey(root));
}

export function workspacesDir(root: string): string {
  return path.join(projectDataDir(root), 'workspaces');
}

export function activeFilePath(root: string): string {
  return path.join(projectDataDir(root), 'active');
}

export function readActive(root: string): string | undefined {
  try {
    return fs.readFileSync(activeFilePath(root), 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

export function writeActive(root: string, id: string): void {
  ensureProjectDir(root);
  fs.writeFileSync(activeFilePath(root), id);
}

// Suivi de l'agent (baby steps), à la Live Share : l'agent met un fichier/une
// plage de lignes en avant (tool reveal_file / build_tree avec `focus`), le
// serveur MCP l'écrit dans follow.json, l'extension le surveille (ouvre le
// fichier, surligne, affiche la ligne « Following agent » dans la vue).
// Au lieu du code actuel, montre le diff d'un fichier entre deux révisions.
// `line`/`end_line` désignent alors le côté `side` (défaut : nouveau).
export interface DiffRequest {
  from: string;
  // Défaut : l'arbre de travail (code actuel).
  to?: string;
  // Chemin du fichier à la révision `from` (renommage), défaut : `path`.
  from_path?: string;
  side?: 'old' | 'new';
}

export interface FocusRequest {
  path: string;
  line?: number;
  end_line?: number;
  match?: string;
  diff?: DiffRequest;
  // Workspace à mettre en avant (devient l'actif si différent).
  workspace_id?: string;
  at: string;
}

// following : l'agent mène, la vue suit. ended : le suivi est terminé (l'agent
// a appelé stop_following, l'utilisateur a cliqué sur Stop, ou la session est
// périmée). Un nouveau reveal_file de l'agent relance toujours le suivi.
export type FollowStatus = 'following' | 'ended';

export interface FollowState {
  status: FollowStatus;
  focus?: FocusRequest;
  updated_at: string;
}

// Une session sans activité depuis ce délai est considérée terminée.
export const FOLLOW_IDLE_MS = 30 * 60 * 1000;

export function followFilePath(root: string): string {
  return path.join(projectDataDir(root), 'follow.json');
}

export function readFollow(
  root: string,
  now: Date = new Date(),
): FollowState | undefined {
  try {
    const data = JSON.parse(fs.readFileSync(followFilePath(root), 'utf8'));
    if (!data || typeof data.status !== 'string') {
      return undefined;
    }
    // Tout état autre que « following » (dont l'ancien « stopped ») = terminé.
    const status: FollowStatus =
      data.status === 'following' ? 'following' : 'ended';
    const idle = now.getTime() - Date.parse(data.updated_at);
    return { ...data, status: idle > FOLLOW_IDLE_MS ? 'ended' : status };
  } catch {
    return undefined;
  }
}

export function writeFollow(
  root: string,
  state: Omit<FollowState, 'updated_at'>,
  now: Date = new Date(),
): void {
  ensureProjectDir(root);
  const payload: FollowState = { ...state, updated_at: now.toISOString() };
  fs.writeFileSync(followFilePath(root), JSON.stringify(payload));
}

// Crée le dossier du projet et y note le chemin d'origine (sert à repérer
// les données orphelines quand le projet n'existe plus).
export function ensureProjectDir(root: string): void {
  const dir = projectDataDir(root);
  fs.mkdirSync(path.join(dir, 'workspaces'), { recursive: true });
  const meta = path.join(dir, 'project.json');
  if (!fs.existsSync(meta)) {
    fs.writeFileSync(meta, JSON.stringify({ root: realPath(root) }));
  }
}

// Déplace l'ancien store `<root>/.smart-explorer/` vers le dossier de
// données. Retourne le nombre de workspaces migrés.
export function migrateLegacyStore(root: string): number {
  const legacy = path.join(root, LEGACY_DIR);
  const legacyWs = path.join(legacy, 'workspaces');
  let moved = 0;
  if (fs.existsSync(legacyWs)) {
    ensureProjectDir(root);
    for (const f of fs
      .readdirSync(legacyWs)
      .filter((n) => n.endsWith('.yaml'))) {
      const dest = path.join(workspacesDir(root), f);
      if (!fs.existsSync(dest)) {
        fs.copyFileSync(path.join(legacyWs, f), dest);
        moved++;
      }
      fs.unlinkSync(path.join(legacyWs, f));
    }
  }
  const legacyActive = path.join(legacy, 'active');
  if (fs.existsSync(legacyActive)) {
    if (!readActive(root)) {
      ensureProjectDir(root);
      fs.copyFileSync(legacyActive, activeFilePath(root));
    }
    fs.unlinkSync(legacyActive);
  }
  for (const dir of [legacyWs, legacy]) {
    try {
      fs.rmdirSync(dir); // seulement s'il est vide
    } catch {
      // absent ou non vide : on n'y touche pas
    }
  }
  return moved;
}

export interface ProjectData {
  dir: string;
  root?: string;
  workspaces: number;
}

// Dossiers de données de tous les projets connus.
export function listProjectData(): ProjectData[] {
  const base = path.join(dataHome(), 'projects');
  if (!fs.existsSync(base)) {
    return [];
  }
  return fs
    .readdirSync(base)
    .map((name) => path.join(base, name))
    .filter((dir) => fs.statSync(dir).isDirectory())
    .map((dir) => {
      let root: string | undefined;
      try {
        root = JSON.parse(
          fs.readFileSync(path.join(dir, 'project.json'), 'utf8'),
        ).root;
      } catch {
        root = undefined;
      }
      const wsDir = path.join(dir, 'workspaces');
      const workspaces = fs.existsSync(wsDir)
        ? fs.readdirSync(wsDir).filter((f) => f.endsWith('.yaml')).length
        : 0;
      return { dir, root, workspaces };
    });
}

// Projets dont le dossier d'origine n'existe plus.
export function listOrphanProjects(): ProjectData[] {
  return listProjectData().filter((p) => !p.root || !fs.existsSync(p.root));
}

export function removeProjectData(dir: string): void {
  const base = path.join(dataHome(), 'projects') + path.sep;
  if (!path.resolve(dir).startsWith(base)) {
    throw new Error(`Refus de supprimer hors du dossier de données : ${dir}`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
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
  ensureProjectDir(root);
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
// Retire les fichiers en double d'un arbre : un fichier n'apparaît qu'une
// fois, dans son dossier le plus profond (puis premier dans l'ordre). Les
// dossiers qui se retrouvent vides sont supprimés.
export function dedupeTree(dir: VirtualDir): VirtualDir {
  return dedupeInto(dir, new Set());
}

function dedupeInto(dir: VirtualDir, seen: Set<string>): VirtualDir {
  const out: VirtualDir = { ...dir };
  const dirs = (dir.dirs ?? [])
    .map((sub) => dedupeInto(sub, seen))
    .filter((sub) => (sub.files?.length ?? 0) + (sub.dirs?.length ?? 0) > 0);
  const files = (dir.files ?? []).filter((f) => {
    const key = f.replace(/^\.\//, '');
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
  delete out.files;
  delete out.dirs;
  if (files.length) {
    out.files = files;
  }
  if (dirs.length) {
    out.dirs = dirs;
  }
  return out;
}

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

// Contenu d'un fichier à une révision (git show) ; '' s'il n'existe pas à cette
// révision (fichier ajouté/supprimé).
export async function gitShow(
  root: string,
  rev: string,
  relPath: string,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['show', `${rev}:${relPath}`],
      {
        cwd: root,
        maxBuffer: 32 * 1024 * 1024,
      },
    );
    return stdout;
  } catch {
    return '';
  }
}

// Pathspecs d'un fichier (chemin actuel + ancien chemin en cas de renommage).
function diffPaths(relPath: string, fromPath?: string): string[] {
  return fromPath && fromPath !== relPath ? [fromPath, relPath] : [relPath];
}

// Texte du diff unifié d'un fichier entre deux révisions (`to` absent : arbre
// de travail). Vide s'il n'y a aucun changement.
export async function gitDiffText(
  root: string,
  from: string,
  to: string | undefined,
  relPath: string,
  fromPath?: string,
): Promise<string> {
  const args = ['diff', '--no-color', '--no-ext-diff', '-U3', '-M', from];
  if (to) {
    args.push(to);
  }
  args.push('--', ...diffPaths(relPath, fromPath));
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: root,
      maxBuffer: 32 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return '';
  }
}

export interface DiffStat {
  // Lignes ajoutées + supprimées (Infinity pour un fichier binaire).
  changed: number;
  // Le fichier existe-t-il à la révision `from` ?
  existsAtFrom: boolean;
}

// Taille du changement d'un fichier entre deux révisions : sert à refuser un
// diff trop gros ou sans objet (fichier nouveau).
export async function gitDiffStat(
  root: string,
  from: string,
  to: string | undefined,
  relPath: string,
  fromPath?: string,
): Promise<DiffStat> {
  let existsAtFrom = true;
  try {
    await execFileAsync(
      'git',
      ['cat-file', '-e', `${from}:${fromPath ?? relPath}`],
      {
        cwd: root,
      },
    );
  } catch {
    existsAtFrom = false;
  }
  const args = ['diff', '--numstat', '-M', from];
  if (to) {
    args.push(to);
  }
  args.push('--', ...diffPaths(relPath, fromPath));
  let changed = 0;
  try {
    const { stdout } = await execFileAsync('git', args, { cwd: root });
    for (const line of stdout.split('\n').filter(Boolean)) {
      const [added, deleted] = line.split('\t');
      changed +=
        added === '-' || deleted === '-'
          ? Number.POSITIVE_INFINITY
          : Number(added) + Number(deleted);
    }
  } catch {
    // diff impossible : traité comme un changement nul
  }
  return { changed, existsAtFrom };
}

export async function revExists(root: string, rev: string): Promise<boolean> {
  try {
    await execFileAsync(
      'git',
      ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`],
      { cwd: root },
    );
    return true;
  } catch {
    return false;
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
