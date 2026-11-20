import './test-home';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  VirtualDir,
  computeFileHashes,
  dedupeTree,
  dataHome,
  deleteWorkspace,
  listOrphanProjects,
  migrateLegacyStore,
  projectDataDir,
  readActive,
  removeProjectData,
  writeActive,
  diffNameStatus,
  flattenTreeFiles,
  headCommit,
  listWorkspaces,
  loadWorkspace,
  saveWorkspace,
  slugify,
  treeFiles,
  uniqueWorkspaceId,
  workspaceFilePath,
} from '../src/workspaceStore';

function makeTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'smart-explorer-test-'));
}

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function makeGitRepo(): string {
  const root = makeTempRoot();
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'Test']);
  git(root, ['config', 'commit.gpgsign', 'false']); // indépendant de la config globale
  return root;
}

function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

test('slugify produit un kebab-case ascii', () => {
  assert.equal(
    slugify('Feature Availability Research'),
    'feature-availability-research',
  );
  assert.equal(slugify('Évolution du móvil !!'), 'evolution-du-movil');
  assert.equal(slugify('???'), 'workspace');
});

test('save/load/list/delete workspace YAML', () => {
  const root = makeTempRoot();
  saveWorkspace(root, {
    version: 1,
    id: 'my-ws',
    name: 'My WS',
    source: { type: 'pr', url: 'https://github.com/o/r/pull/1', title: 'T' },
    lifecycle: 'pr',
    instructions: ['a', 'b'],
    freshness: { base_commit: 'abc' },
    tree: { name: '.', dirs: [{ name: 'A', files: ['src/a.ts'] }] },
  });
  const loaded = loadWorkspace(root, 'my-ws');
  assert.equal(loaded?.name, 'My WS');
  assert.equal(loaded?.source.type, 'pr');
  assert.deepEqual(loaded?.instructions, ['a', 'b']);
  assert.equal(loaded?.tree?.dirs?.[0].files?.[0], 'src/a.ts');
  assert.deepEqual(
    listWorkspaces(root).map((w) => w.id),
    ['my-ws'],
  );
  assert.ok(fs.existsSync(workspaceFilePath(root, 'my-ws')));
  assert.equal(deleteWorkspace(root, 'my-ws'), true);
  assert.equal(loadWorkspace(root, 'my-ws'), undefined);
  assert.equal(deleteWorkspace(root, 'my-ws'), false);
});

test('uniqueWorkspaceId suffixe en cas de collision', () => {
  const root = makeTempRoot();
  assert.equal(uniqueWorkspaceId(root, 'Foo Bar'), 'foo-bar');
  saveWorkspace(root, {
    version: 1,
    id: 'foo-bar',
    source: { type: 'text', url: 'x' },
  });
  assert.equal(uniqueWorkspaceId(root, 'Foo Bar'), 'foo-bar-2');
});

test('flattenTreeFiles', () => {
  const tree: VirtualDir = {
    name: '.',
    files: ['root.ts'],
    dirs: [
      {
        name: 'A',
        files: ['a.ts', 'b.ts'],
        dirs: [{ name: 'B', files: ['c.ts'] }],
      },
    ],
  };
  assert.deepEqual(flattenTreeFiles(tree).sort(), [
    'a.ts',
    'b.ts',
    'c.ts',
    'root.ts',
  ]);
});

test('computeFileHashes ne garde que les fichiers existants', () => {
  const root = makeTempRoot();
  write(root, 'src/a.ts', 'hello');
  const hashes = computeFileHashes(root, ['src/a.ts', 'missing.ts']);
  assert.ok(hashes['src/a.ts'].startsWith('sha256:'));
  assert.equal('missing.ts' in hashes, false);
});

test('treeFiles aplati depuis WorkspaceFile.tree', () => {
  const ws = {
    version: 1 as const,
    id: 'x',
    source: { type: 'text' as const, url: 'u' },
    tree: { name: '.', dirs: [{ name: 'D', files: ['f.ts'] }] },
  };
  assert.deepEqual(treeFiles(ws), ['f.ts']);
});

test('headCommit + diffNameStatus sur un vrai repo git', async () => {
  const root = makeGitRepo();
  write(root, 'src/keep.ts', 'v1');
  write(root, 'src/old.ts', 'v1');
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'c1']);
  const base = await headCommit(root);
  assert.ok(base && base.length === 40);

  write(root, 'src/keep.ts', 'v2'); // modified
  write(root, 'src/new.ts', 'new'); // added
  fs.unlinkSync(path.join(root, 'src/old.ts')); // deleted
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'c2']);

  const diff = await diffNameStatus(root, base);
  const byPath = new Map(diff.map((d) => [d.path, d.status]));
  assert.equal(byPath.get('src/keep.ts'), 'modified');
  assert.equal(byPath.get('src/new.ts'), 'added');
  assert.equal(byPath.get('src/old.ts'), 'deleted');

  // rename d'un fichier présent dans base
  const root2 = makeGitRepo();
  write(root2, 'src/a.ts', 'aaa');
  git(root2, ['add', '.']);
  git(root2, ['commit', '-qm', 'c1']);
  const base2 = await headCommit(root2);
  assert.ok(base2);
  git(root2, ['mv', 'src/a.ts', 'src/b.ts']);
  git(root2, ['commit', '-qm', 'c2']);
  const diff2 = await diffNameStatus(root2, base2);
  const renamed = diff2.find((d) => d.status === 'renamed');
  assert.equal(renamed?.old_path, 'src/a.ts');
  assert.equal(renamed?.path, 'src/b.ts');
});

test('dedupeTree : un fichier une seule fois, dossier le plus profond prioritaire', () => {
  const tree: VirtualDir = {
    name: '.',
    files: ['a.rs', './b.rs', 'd.rs'],
    dirs: [
      { name: 'x', files: ['b.rs', 'c.rs', 'c.rs'] },
      { name: 'y', files: ['a.rs'] },
      { name: 'vide', files: ['c.rs'] },
    ],
  };
  const out = dedupeTree(tree);
  assert.deepEqual(out.files, ['d.rs']);
  assert.deepEqual(out.dirs, [
    { name: 'x', files: ['b.rs', 'c.rs'] },
    { name: 'y', files: ['a.rs'] },
  ]);
  assert.equal(flattenTreeFiles(out).length, 4);
});

test('les données vivent hors du projet (dossier de données utilisateur)', () => {
  const root = makeTempRoot();
  saveWorkspace(root, {
    version: 1,
    id: 'w',
    source: { type: 'text', url: 'u' },
  });
  assert.ok(workspaceFilePath(root, 'w').startsWith(dataHome()));
  assert.ok(projectDataDir(root).startsWith(path.join(dataHome(), 'projects')));
  assert.deepEqual(fs.readdirSync(root), []); // rien écrit dans le projet
  writeActive(root, 'w');
  assert.equal(readActive(root), 'w');
});

test('migrateLegacyStore : déplace .smart-explorer/ du projet vers le dossier de données', () => {
  const root = makeTempRoot();
  const yaml = 'version: 1\nid: old\nsource:\n  type: text\n  url: u\n';
  write(root, '.smart-explorer/workspaces/old.yaml', yaml);
  write(root, '.smart-explorer/active', 'old');
  assert.equal(migrateLegacyStore(root), 1);
  assert.equal(loadWorkspace(root, 'old')?.id, 'old');
  assert.equal(readActive(root), 'old');
  assert.equal(fs.existsSync(path.join(root, '.smart-explorer')), false);
  assert.equal(migrateLegacyStore(root), 0); // idempotent
});

test('projets orphelins : repérés puis supprimés', () => {
  const root = makeTempRoot();
  saveWorkspace(root, {
    version: 1,
    id: 'w',
    source: { type: 'text', url: 'u' },
  });
  const dir = projectDataDir(root); // calculé avant la suppression du projet
  assert.equal(
    listOrphanProjects().some((o) => o.dir === dir),
    false,
  );
  fs.rmSync(root, { recursive: true });
  const orphan = listOrphanProjects().find((o) => o.dir === dir);
  assert.ok(orphan);
  assert.equal(orphan.workspaces, 1);
  removeProjectData(orphan.dir);
  assert.equal(fs.existsSync(orphan.dir), false);
  assert.throws(() => removeProjectData(os.tmpdir()), /Refus/);
});
