import './test-home';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  VirtualDir,
  dataHome,
  deleteWorkspace,
  listOrphanProjects,
  projectDataDir,
  readActive,
  gitDiffStat,
  gitDiffText,
  gitShow,
  revExists,
  removeProjectData,
  writeActive,
  diffNameStatus,
  flattenTreeFiles,
  headCommit,
  listWorkspaces,
  loadWorkspace,
  saveWorkspace,
  slugify,
  workspaceFiles,
  uniqueWorkspaceId,
  workspaceFilePath,
} from '../src/core/workspaceStore';

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
    version: 2,
    id: 'my-ws',
    name: 'My WS',
    links: [{ kind: 'github-pr', ref: 'o/r#1', title: 'T' }],
    base_commit: 'abc',
    files: ['src/a.ts'],
  });
  const loaded = loadWorkspace(root, 'my-ws');
  assert.equal(loaded?.name, 'My WS');
  assert.equal(loaded?.links?.[0].kind, 'github-pr');
  assert.equal(loaded?.base_commit, 'abc');
  assert.deepEqual(loaded?.files, ['src/a.ts']);
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
    version: 2,
    id: 'foo-bar',
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

test('workspaceFiles : liste stockée, vide par défaut', () => {
  const ws = {
    version: 2,
    id: 'x',
  };
  assert.deepEqual(workspaceFiles(ws), []);
  assert.deepEqual(workspaceFiles({ ...ws, files: ['f.ts'] }), ['f.ts']);
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

test('les données vivent hors du projet (dossier de données utilisateur)', () => {
  const root = makeTempRoot();
  saveWorkspace(root, {
    version: 2,
    id: 'w',
  });
  assert.ok(workspaceFilePath(root, 'w').startsWith(dataHome()));
  assert.ok(projectDataDir(root).startsWith(path.join(dataHome(), 'projects')));
  assert.deepEqual(fs.readdirSync(root), []); // rien écrit dans le projet
  writeActive(root, 'w');
  assert.equal(readActive(root), 'w');
});

test('projets orphelins : repérés puis supprimés', () => {
  const root = makeTempRoot();
  saveWorkspace(root, {
    version: 2,
    id: 'w',
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

test('gitShow / revExists : contenu d’un fichier à une révision', async () => {
  const root = makeGitRepo();
  write(root, 'src/a.rs', 'v1\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'c1']);
  const first = git(root, ['rev-parse', 'HEAD']);
  write(root, 'src/a.rs', 'v2\n');
  git(root, ['commit', '-qam', 'c2']);
  assert.equal(await gitShow(root, first, 'src/a.rs'), 'v1\n');
  assert.equal(await gitShow(root, 'HEAD', 'src/a.rs'), 'v2\n');
  assert.equal(await gitShow(root, 'HEAD~1', 'src/a.rs'), 'v1\n');
  assert.equal(await gitShow(root, first, 'absent.rs'), ''); // ajouté/supprimé : vide
  assert.equal(await revExists(root, first), true);
  assert.equal(await revExists(root, 'HEAD~1'), true);
  assert.equal(await revExists(root, 'nope'), false);
});

test('gitDiffText / gitDiffStat : diff unifié et taille du changement', async () => {
  const root = makeGitRepo();
  write(root, 'src/a.rs', 'l1\nl2\nl3\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'c1']);
  const base = git(root, ['rev-parse', 'HEAD']);
  write(root, 'src/a.rs', 'l1\nCHANGED\nl3\n');
  write(root, 'src/new.rs', 'n\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'c2']);

  const text = await gitDiffText(root, base, 'HEAD', 'src/a.rs');
  assert.match(text, /@@ -1,3 \+1,3 @@/);
  assert.match(text, /^-l2$/m);
  assert.match(text, /^\+CHANGED$/m);
  // `to` absent : comparé à l'arbre de travail (ici identique à HEAD)
  assert.equal(await gitDiffText(root, 'HEAD', undefined, 'src/a.rs'), '');

  assert.deepEqual(await gitDiffStat(root, base, 'HEAD', 'src/a.rs'), {
    changed: 2,
    existsAtFrom: true,
  });
  const created = await gitDiffStat(root, base, 'HEAD', 'src/new.rs');
  assert.equal(created.existsAtFrom, false);
  assert.equal(created.changed, 1);
});
