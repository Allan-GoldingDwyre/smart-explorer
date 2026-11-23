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
import type { WorkspaceLink } from './links';

const execFileAsync = promisify(execFile);

export interface VirtualDir {
  name: string;
  files?: string[];
  dirs?: VirtualDir[];
}

export interface WorkspaceFile {
  version: number;
  id: string;
  name?: string;
  // Issues et/ou PR (GitHub, Linear) auxquelles le workspace se rattache.
  links?: WorkspaceLink[];
  // Seuls les fichiers pertinents sont stockés (chemins relatifs, sans doublon) :
  // l'arbre affiché est recalculé à la volée par fuseTree (déterministe).
  files?: string[];
  // HEAD au moment où la liste de fichiers a été validée (voir freshness.ts).
  base_commit?: string;
  // Options de fusion, uniquement si elles diffèrent des défauts.
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
function projectKey(root: string): string {
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

function activeFilePath(root: string): string {
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

// Mise en avant ponctuelle : l'agent désigne un fichier/une plage de lignes
// (tool `focus`), le serveur MCP l'écrit dans focus.json, l'extension le
// surveille et ouvre le fichier à cet endroit. Aucune session : chaque demande
// est indépendante.
//
// Au lieu du code actuel, `diff` montre le diff d'un fichier entre deux
// révisions ; `line`/`end_line` désignent alors le côté `side` (défaut : nouveau).
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

export function focusFilePath(root: string): string {
  return path.join(projectDataDir(root), 'focus.json');
}

export function readFocus(root: string): FocusRequest | undefined {
  try {
    const data = JSON.parse(fs.readFileSync(focusFilePath(root), 'utf8'));
    return data && typeof data.path === 'string' ? data : undefined;
  } catch {
    return undefined;
  }
}

export function writeFocus(root: string, focus: FocusRequest): void {
  ensureProjectDir(root);
  fs.writeFileSync(focusFilePath(root), JSON.stringify(focus));
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

export interface ProjectData {
  dir: string;
  root?: string;
  workspaces: number;
}

// Dossiers de données de tous les projets connus.
function listProjectData(): ProjectData[] {
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

function parseWorkspaceYaml(content: string): WorkspaceFile {
  const doc = YAML.parse(content) as WorkspaceFile;
  if (!doc || typeof doc !== 'object' || !doc.id) {
    throw new Error('YAML de workspace invalide : champ id requis');
  }
  return doc;
}

function serializeWorkspaceYaml(ws: WorkspaceFile): string {
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

function listWorkspaceIds(root: string): string[] {
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

export function fileExists(root: string, relPath: string): boolean {
  return fs.existsSync(path.join(root, relPath));
}

// Aplatit un arbre virtuel en liste de chemins de fichiers.
export function flattenTreeFiles(dir: VirtualDir): string[] {
  const out: string[] = [...(dir.files ?? [])];
  for (const sub of dir.dirs ?? []) {
    out.push(...flattenTreeFiles(sub));
  }
  return out;
}

export function workspaceFiles(ws: WorkspaceFile): string[] {
  return ws.files ?? [];
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

type DiffStatus = 'added' | 'modified' | 'deleted' | 'renamed';

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
