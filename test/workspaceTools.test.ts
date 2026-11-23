import './test-home';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { GithubResolver } from '../src/core/links';
import {
  loadWorkspace,
  readActive,
  workspaceFilePath,
} from '../src/core/workspaceStore';
import type { ToolEnv } from '../src/mcp/toolEnv';
import {
  createWorkspaceTool,
  deleteWorkspaceTool,
  getWorkspaceTool,
  listWorkspacesTool,
  setActiveWorkspaceTool,
  setFilesTool,
  setLinksTool,
} from '../src/mcp/workspaceTools';

function makeTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'smart-explorer-ws-'));
}

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function makeGitRoot(): string {
  const root = makeTempRoot();
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 't@example.com']);
  git(root, ['config', 'user.name', 'T']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  return root;
}

function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function commit(root: string, message: string): string {
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', message]);
  return git(root, ['rev-parse', 'HEAD']);
}

// `gh` simulé : #5 est une PR, le reste des issues ; jamais de réseau.
const github: GithubResolver = async (_repo, n) =>
  n === 5
    ? { kind: 'github-pr', title: 'Ma PR' }
    : { kind: 'github-issue', title: 'Un bug' };

function makeEnv(root: string, extra: Partial<ToolEnv> = {}): ToolEnv {
  return {
    root,
    now: () => new Date('2026-11-19T10:00:00Z'),
    github,
    defaultRepo: async () => 'o/r',
    ...extra,
  };
}

test('create_workspace : liens en formes courtes, nom par défaut = premier lien', async () => {
  const root = makeTempRoot();
  const env = makeEnv(root);
  const created = await createWorkspaceTool(env, {
    links: ['ARCHON-120', '#12', 'https://github.com/o/r/pull/5'],
  });
  assert.equal(created.workspace_id, 'archon-120');
  assert.deepEqual(
    created.links.map((l) => [l.kind, l.ref]),
    [
      ['linear-issue', 'ARCHON-120'],
      ['github-issue', 'o/r#12'],
      ['github-pr', 'o/r#5'],
    ],
  );
  const ws = loadWorkspace(root, 'archon-120');
  assert.equal(ws?.version, 2);
  assert.equal(ws?.links?.length, 3);
  await assert.rejects(() => createWorkspaceTool(env, {}), /name/);
});

test('set_links : incrémental, issue -> PR sans rien perdre, lien inconnu conservé', async () => {
  const root = makeTempRoot();
  const env = makeEnv(root);
  const { workspace_id } = await createWorkspaceTool(env, {
    name: 'dispo',
    links: ['ARCHON-118', '#9'],
  });
  // la PR est créée : on l'ajoute, les issues restent
  const added = await setLinksTool(env, { workspace_id, add: ['#5'] });
  assert.deepEqual(
    added.links.map((l) => l.ref),
    ['ARCHON-118', 'o/r#9', 'o/r#5'],
  );
  assert.equal(added.links[2].kind, 'github-pr');
  // retrait ciblé
  const removed = await setLinksTool(env, {
    workspace_id,
    remove: ['archon-118'],
  });
  assert.deepEqual(
    removed.links.map((l) => l.ref),
    ['o/r#9', 'o/r#5'],
  );
  // gh indisponible : conservé en unknown avec une note, puis précisé plus tard
  const offline = makeEnv(root, { github: async () => undefined });
  const unknown = await setLinksTool(offline, { workspace_id, add: ['#77'] });
  assert.equal(unknown.links.at(-1)?.kind, 'unknown');
  assert.equal(unknown.notes.length, 1);
  const fixed = await setLinksTool(env, { workspace_id, add: ['#77'] });
  assert.equal(fixed.links.at(-1)?.kind, 'github-issue');
  assert.equal(fixed.links.length, 3);
  // tout retirer : plus de clé links dans le YAML
  await setLinksTool(env, { workspace_id, remove: ['#9', '#5', '#77'] });
  assert.equal(loadWorkspace(root, workspace_id)?.links, undefined);
});

test('set_files : remplace, ajuste, normalise ; seuls chemins et options sont stockés', async () => {
  const root = makeTempRoot();
  const env = makeEnv(root);
  const { workspace_id } = await createWorkspaceTool(env, { name: 'ws' });
  const files = [
    ...[1, 2, 3].map((i) => `src/a/f${i}.rs`),
    ...[1, 2, 3].map((i) => `src/b/f${i}.rs`),
    'src/one/x.rs',
    './src/one/x.rs',
  ];
  const built = await setFilesTool(env, { workspace_id, files });
  assert.equal(built.files_count, 7); // doublon retiré
  assert.equal(built.folders_count, 2); // a et b ; one dissous par la fusion
  assert.equal(built.missing_files.length, 7); // rien sur le disque ici
  const raw = fs.readFileSync(workspaceFilePath(root, workspace_id), 'utf8');
  assert.equal(/^(tree|freshness|instructions|source):/m.test(raw), false);
  assert.equal(loadWorkspace(root, workspace_id)?.fusion, undefined);

  await setFilesTool(env, {
    workspace_id,
    add: ['z.rs', 'src/a/f1.rs'],
    remove: ['src/b/f1.rs', 'src/b/f2.rs'],
  });
  const after = loadWorkspace(root, workspace_id)?.files;
  assert.equal(after?.length, 6);
  assert.ok(after?.includes('z.rs'));
  assert.ok(!after?.includes('src/b/f1.rs'));

  // réglages persistants, conservés par un ajustement
  const flat = await setFilesTool(env, {
    workspace_id,
    files,
    min_folder_files: 99,
    max_loose_files: 99,
  });
  assert.equal(flat.folders_count, 0);
  const adjusted = await setFilesTool(env, { workspace_id, add: ['q/r.rs'] });
  assert.equal(adjusted.folders_count, 0);
  assert.deepEqual(loadWorkspace(root, workspace_id)?.fusion, {
    min_folder_files: 99,
    max_loose_files: 99,
  });

  await assert.rejects(
    () => setFilesTool(env, { workspace_id, files, add: ['x'] }),
    /ne le combine pas/,
  );
  await assert.rejects(
    () => setFilesTool(env, { workspace_id: 'nope', files }),
    /introuvable/,
  );
});

test('get_workspace : fichiers, arbre recalculé, fraîcheur sans rien modifier', async () => {
  const root = makeGitRoot();
  write(root, 'src/keep.ts', 'v1');
  write(root, 'src/mod.ts', 'v1');
  write(root, 'src/gone.ts', 'v1');
  write(root, 'src/old-name.ts', 'same content\nsecond line\nthird line\n');
  const c1 = commit(root, 'c1');
  const env = makeEnv(root);
  const { workspace_id } = await createWorkspaceTool(env, {
    links: ['#5'],
  });
  await setFilesTool(env, {
    workspace_id,
    files: ['src/keep.ts', 'src/mod.ts', 'src/gone.ts', 'src/old-name.ts'],
  });
  await assert.rejects(
    () => getWorkspaceTool(env, {}),
    /aucun workspace actif/,
  );

  let details = await getWorkspaceTool(env, { workspace_id });
  assert.equal(details.stale.status, 'fresh');
  assert.equal(details.stale.base_commit, c1);
  assert.equal(details.files.length, 4);
  assert.equal(details.tree.files?.length, 4); // petit dossier remonté
  assert.equal(details.links[0].kind, 'github-pr');
  assert.equal(details.stale.hint, undefined);

  // le repo avance : modification, suppression, renommage
  write(root, 'src/mod.ts', 'v2');
  fs.unlinkSync(path.join(root, 'src/gone.ts'));
  git(root, ['mv', 'src/old-name.ts', 'src/new-name.ts']);
  const c2 = commit(root, 'c2');
  const before = fs.readFileSync(workspaceFilePath(root, workspace_id), 'utf8');

  details = await getWorkspaceTool(env, { workspace_id });
  assert.equal(details.stale.status, 'stale');
  assert.equal(details.stale.head, c2);
  assert.deepEqual(details.stale.removed, ['src/gone.ts']);
  assert.deepEqual(details.stale.renamed, [
    { from: 'src/old-name.ts', to: 'src/new-name.ts' },
  ]);
  assert.deepEqual(details.stale.modified, ['src/mod.ts']);
  assert.match(details.stale.hint!, /sync: true/);
  // get ne modifie rien
  assert.equal(
    fs.readFileSync(workspaceFilePath(root, workspace_id), 'utf8'),
    before,
  );
  const listed = await listWorkspacesTool(env);
  assert.equal(listed.workspaces[0].freshness, 'stale');
  assert.deepEqual(listed.workspaces[0].links, ['o/r#5']);

  // set_files { sync } : partie mécanique appliquée, base_commit avancé
  const synced = await setFilesTool(env, { workspace_id, sync: true });
  assert.deepEqual(synced.synced, {
    removed: ['src/gone.ts'],
    renamed: [{ from: 'src/old-name.ts', to: 'src/new-name.ts' }],
  });
  assert.equal(synced.base_commit, c2);
  assert.deepEqual(synced.missing_files, []);
  const ws = loadWorkspace(root, workspace_id);
  assert.deepEqual(ws?.files?.sort(), [
    'src/keep.ts',
    'src/mod.ts',
    'src/new-name.ts',
  ]);
  details = await getWorkspaceTool(env, { workspace_id });
  assert.equal(details.stale.status, 'fresh');
});

test('get_workspace : base_commit introuvable (rebase) ; fichiers absents retirés par sync', async () => {
  const root = makeGitRoot();
  write(root, 'a.ts', 'a');
  commit(root, 'c1');
  const env = makeEnv(root);
  const { workspace_id } = await createWorkspaceTool(env, { name: 'ws' });
  await setFilesTool(env, { workspace_id, files: ['a.ts', 'absent.ts'] });
  const ws = loadWorkspace(root, workspace_id)!;
  // base_commit disparu (ex. rebase + gc) : on le simule
  ws.base_commit = '0'.repeat(40);
  fs.writeFileSync(
    workspaceFilePath(root, workspace_id),
    `version: 2\nid: ${workspace_id}\nfiles: [a.ts, absent.ts]\nbase_commit: "${ws.base_commit}"\n`,
  );
  const details = await getWorkspaceTool(env, { workspace_id });
  assert.equal(details.stale.base_lost, true);
  assert.deepEqual(details.stale.missing, ['absent.ts']);
  assert.match(details.stale.hint!, /introuvable/);
  const synced = await setFilesTool(env, { workspace_id, sync: true });
  assert.deepEqual(synced.synced?.removed, ['absent.ts']);
  assert.deepEqual(loadWorkspace(root, workspace_id)?.files, ['a.ts']);
});

test('get_workspace : sans commit validé -> never-synced', async () => {
  const root = makeTempRoot(); // pas de repo git
  const env = makeEnv(root);
  const { workspace_id } = await createWorkspaceTool(env, { name: 'ws' });
  await setFilesTool(env, { workspace_id, files: ['a.ts'] });
  const details = await getWorkspaceTool(env, { workspace_id });
  assert.equal(details.stale.status, 'never-synced');
});

test('set_active_workspace, list_workspaces, delete_workspace', async () => {
  const root = makeTempRoot();
  const env = makeEnv(root);
  const a = (await createWorkspaceTool(env, { name: 'a' })).workspace_id;
  const b = (await createWorkspaceTool(env, { name: 'b' })).workspace_id;
  await setActiveWorkspaceTool(env, { workspace_id: b });
  assert.equal(readActive(root), b);
  const listed = await listWorkspacesTool(env);
  assert.equal(listed.active, b);
  assert.deepEqual(
    listed.workspaces.map((w) => w.id),
    [a, b],
  );
  await deleteWorkspaceTool(env, { workspace_id: a });
  assert.deepEqual(
    (await listWorkspacesTool(env)).workspaces.map((w) => w.id),
    [b],
  );
  await assert.rejects(
    () => deleteWorkspaceTool(env, { workspace_id: a }),
    /introuvable/,
  );
  await assert.rejects(
    () => setActiveWorkspaceTool(env, { workspace_id: a }),
    /introuvable/,
  );
});
