// Tools MCP du workspace : N workspaces par projet, chacun = une liste de
// fichiers pertinents + des liens vers des issues/PR. Seuls ces chemins sont
// stockés ; l'arbre affiché est recalculé par fuseTree. `get_workspace`
// signale ce qui est périmé sans rien modifier ; la mise à jour passe par
// `set_files` (voir freshness.ts).
import { Staleness, applyStaleness, computeStaleness } from '../core/freshness';
import { ghResolver, originRepo } from '../core/github';
import {
  WorkspaceLink,
  addLinks,
  removeLinks,
  resolveLink,
} from '../core/links';
import { FusionOptions, fuseTree } from '../core/treeFusion';
import { countFolders, normalizeFiles } from '../core/treeOps';
import {
  VirtualDir,
  WorkspaceFile,
  deleteWorkspace,
  fileExists,
  headCommit,
  listWorkspaces,
  readActive,
  saveWorkspace,
  uniqueWorkspaceId,
  workspaceFiles,
  writeActive,
} from '../core/workspaceStore';
import { ToolEnv, err, requireWorkspace, stringList } from './toolEnv';

function displayName(ws: WorkspaceFile): string {
  return ws.name ?? ws.links?.find((l) => l.title)?.title ?? ws.id;
}

async function resolveLinks(
  env: ToolEnv,
  inputs: string[],
): Promise<{ links: WorkspaceLink[]; notes: string[] }> {
  const defaultRepo = env.defaultRepo
    ? await env.defaultRepo()
    : await originRepo(env.root);
  const links: WorkspaceLink[] = [];
  const notes: string[] = [];
  for (const input of inputs) {
    const { link, note } = await resolveLink(input, {
      defaultRepo,
      github: env.github ?? ghResolver,
    });
    links.push(link);
    if (note) {
      notes.push(note);
    }
  }
  return { links, notes };
}

// --- list / get ---

export interface WorkspaceSummary {
  id: string;
  name: string;
  links: string[];
  freshness: Staleness['status'];
  files_count: number;
}

export async function listWorkspacesTool(env: ToolEnv): Promise<{
  workspaces: WorkspaceSummary[];
  active?: string;
}> {
  const head = await headCommit(env.root);
  const workspaces = listWorkspaces(env.root).map((ws) => ({
    id: ws.id,
    name: displayName(ws),
    links: (ws.links ?? []).map((l) => l.ref),
    freshness: (ws.base_commit && head
      ? ws.base_commit === head
        ? 'fresh'
        : 'stale'
      : 'never-synced') as Staleness['status'],
    files_count: workspaceFiles(ws).length,
  }));
  return { workspaces, active: readActive(env.root) };
}

export interface WorkspaceDetails {
  id: string;
  name: string;
  active: boolean;
  links: WorkspaceLink[];
  files: string[];
  // Arbre compacté tel qu'affiché dans VS Code (recalculé, non stocké).
  tree: VirtualDir;
  // Fraîcheur des fichiers depuis base_commit ; rien n'est modifié.
  stale: Staleness & { hint?: string };
}

export async function getWorkspaceTool(
  env: ToolEnv,
  args: { workspace_id?: string },
): Promise<WorkspaceDetails> {
  const id = args.workspace_id ?? readActive(env.root);
  if (!id) {
    err('aucun workspace actif : passe workspace_id (voir list_workspaces)');
  }
  const ws = requireWorkspace(env, id);
  const files = workspaceFiles(ws);
  const stale: WorkspaceDetails['stale'] = await computeStaleness(
    env.root,
    files,
    ws.base_commit,
  );
  const mechanical =
    stale.removed.length || stale.renamed.length || stale.missing.length;
  if (stale.status === 'never-synced' && files.length) {
    stale.hint =
      'jamais validé : relis la liste puis appelle set_files { sync: true } pour fixer base_commit';
  } else if (stale.base_lost) {
    stale.hint =
      'base_commit introuvable (rebase ?) : set_files { sync: true } retire les fichiers absents et repart de HEAD';
  } else if (mechanical || stale.modified.length) {
    stale.hint = [
      mechanical
        ? 'set_files { sync: true } suit les renommages et retire les fichiers supprimés'
        : undefined,
      stale.modified.length
        ? 'relis les fichiers modifiés, ajoute/retire via set_files { add, remove }'
        : undefined,
    ]
      .filter(Boolean)
      .join(' ; ');
  }
  return {
    id: ws.id,
    name: displayName(ws),
    active: readActive(env.root) === ws.id,
    links: ws.links ?? [],
    files,
    tree: fuseTree(files, ws.fusion),
    stale,
  };
}

// --- create / delete / active ---

export async function createWorkspaceTool(
  env: ToolEnv,
  args: { name?: string; links?: string[] },
): Promise<{ workspace_id: string; links: WorkspaceLink[]; notes: string[] }> {
  const { links, notes } = await resolveLinks(
    env,
    stringList(args.links ?? [], 'links'),
  );
  const name = args.name?.trim() || links[0]?.ref;
  if (!name) {
    err('donne un `name` et/ou des `links` (issue/PR GitHub ou Linear)');
  }
  const id = uniqueWorkspaceId(env.root, name);
  const ws: WorkspaceFile = {
    version: 2,
    id,
    name,
    ...(links.length ? { links: addLinks([], links) } : {}),
  };
  saveWorkspace(env.root, ws);
  return { workspace_id: id, links: ws.links ?? [], notes };
}

export async function deleteWorkspaceTool(
  env: ToolEnv,
  args: { workspace_id: string },
): Promise<{ ok: true; active?: string }> {
  requireWorkspace(env, args.workspace_id);
  deleteWorkspace(env.root, args.workspace_id);
  return { ok: true, active: readActive(env.root) };
}

export async function setActiveWorkspaceTool(
  env: ToolEnv,
  args: { workspace_id: string },
): Promise<{ ok: true; active: string }> {
  requireWorkspace(env, args.workspace_id);
  writeActive(env.root, args.workspace_id);
  return { ok: true, active: args.workspace_id };
}

// --- links ---

// Incrémental : `add` ajoute (ou précise) des liens, `remove` en retire. Les
// saisies courtes (`#12`, `owner/repo#12`, `ABC-123`) suffisent ; issue ou PR
// est déterminé par `gh`, et ce qui ne l'est pas est conservé en `unknown`.
export async function setLinksTool(
  env: ToolEnv,
  args: { workspace_id: string; add?: string[]; remove?: string[] },
): Promise<{ ok: true; links: WorkspaceLink[]; notes: string[] }> {
  const ws = requireWorkspace(env, args.workspace_id);
  const add = stringList(args.add ?? [], 'add');
  const remove = stringList(args.remove ?? [], 'remove');
  const defaultRepo = env.defaultRepo
    ? await env.defaultRepo()
    : await originRepo(env.root);
  const resolved = await resolveLinks(env, add);
  let links = removeLinks(ws.links ?? [], remove, defaultRepo);
  links = addLinks(links, resolved.links);
  if (links.length) {
    ws.links = links;
  } else {
    delete ws.links;
  }
  saveWorkspace(env.root, ws);
  return { ok: true, links, notes: resolved.notes };
}

// --- files ---

export interface SetFilesResult {
  ok: true;
  files_count: number;
  folders_count: number;
  missing_files: string[];
  base_commit?: string;
  // Partie mécanique appliquée par `sync`.
  synced?: { removed: string[]; renamed: { from: string; to: string }[] };
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

// Définit les fichiers pertinents : `files` remplace la liste, `add`/`remove`
// l'ajustent. `sync: true` applique d'abord la partie mécanique de la mise à
// jour (renommages suivis, fichiers supprimés retirés) et avance base_commit
// sur HEAD. `files` avance aussi base_commit : la liste vient d'être choisie.
export async function setFilesTool(
  env: ToolEnv,
  args: {
    workspace_id: string;
    files?: string[];
    add?: string[];
    remove?: string[];
    sync?: boolean;
    min_folder_files?: number;
    max_loose_files?: number;
  },
): Promise<SetFilesResult> {
  const ws = requireWorkspace(env, args.workspace_id);
  if (args.files !== undefined && (args.add || args.remove)) {
    err('`files` remplace la liste : ne le combine pas avec add/remove');
  }
  let files =
    args.files !== undefined
      ? normalizeFiles(stringList(args.files, 'files'))
      : workspaceFiles(ws);

  let synced: SetFilesResult['synced'];
  if (args.sync) {
    const staleness = await computeStaleness(env.root, files, ws.base_commit);
    files = applyStaleness(files, staleness);
    synced = {
      removed: [...staleness.removed, ...staleness.missing],
      renamed: staleness.renamed,
    };
  }
  const remove = new Set(
    normalizeFiles(stringList(args.remove ?? [], 'remove')),
  );
  files = normalizeFiles([
    ...files,
    ...stringList(args.add ?? [], 'add'),
  ]).filter((f) => !remove.has(f));

  ws.files = files;
  const options = { ...ws.fusion, ...fusionOptions(args) };
  if (Object.keys(options).length) {
    ws.fusion = options;
  } else {
    delete ws.fusion;
  }
  if (args.files !== undefined || args.sync || !ws.base_commit) {
    ws.base_commit = (await headCommit(env.root)) ?? ws.base_commit;
  }
  saveWorkspace(env.root, ws);
  return {
    ok: true,
    files_count: files.length,
    folders_count: countFolders(fuseTree(files, ws.fusion)),
    missing_files: files.filter((f) => !fileExists(env.root, f)),
    base_commit: ws.base_commit,
    ...(synced ? { synced } : {}),
  };
}
