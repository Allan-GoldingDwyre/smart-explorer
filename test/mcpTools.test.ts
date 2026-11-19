import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ToolEnv,
  applySyncTool,
  buildTreeTool,
  checkWorkspaceFilesTool,
  createWorkspaceTool,
  detectSource,
  exportContextTool,
  levenshtein,
  listWorkspacesTool,
  revealFileTool,
  setActiveWorkspaceTool,
  setInstructionsTool,
  syncWorkspaceTool,
} from '../src/mcpTools';
import { loadWorkspace } from '../src/workspaceStore';

function makeTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'smart-explorer-mcp-'));
}

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function makeGitRoot(): string {
  const root = makeTempRoot();
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 't@example.com']);
  git(root, ['config', 'user.name', 'T']);
  return root;
}

function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function makeEnv(root: string, extra: Partial<ToolEnv> = {}): ToolEnv {
  return { root, now: () => new Date('2026-11-19T10:00:00Z'), ...extra };
}

test('detectSource : Linear, GitHub PR/issue, #N, texte', () => {
  assert.deepEqual(detectSource('abc-123'), { type: 'issue', ref: 'ABC-123' });
  assert.deepEqual(detectSource('https://linear.app/acme/issue/ENG-42/x'), {
    type: 'issue',
    ref: 'ENG-42',
  });
  assert.equal(detectSource('https://github.com/o/r/pull/376').type, 'pr');
  assert.equal(detectSource('https://github.com/o/r/issues/7').type, 'issue');
  assert.deepEqual(detectSource('#42'), { type: 'issue', ref: '#42' });
  assert.equal(detectSource('refactor le store').type, 'text');
});

test('levenshtein', () => {
  assert.equal(levenshtein('kitten', 'sitting'), 3);
  assert.equal(levenshtein('', 'abc'), 3);
  assert.equal(levenshtein('same', 'same'), 0);
});

test('create_workspace + list_workspaces + set_instructions + build_tree', async () => {
  const root = makeGitRoot();
  write(root, 'src/a.ts', 'a');
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'c1']);
  const env = makeEnv(root);

  const created = await createWorkspaceTool(env, {
    source: 'https://github.com/o/r/pull/376',
    name: 'Availability Research',
    instructions: ['Grouper par domaine'],
  });
  assert.equal(created.workspace_id, 'availability-research');

  const ws = loadWorkspace(root, created.workspace_id);
  assert.equal(ws?.source.type, 'pr');
  assert.equal(ws?.lifecycle, 'pr');
  assert.deepEqual(ws?.instructions, ['Grouper par domaine']);

  const listed = await listWorkspacesTool(env);
  assert.equal(listed.workspaces.length, 1);
  assert.equal(listed.workspaces[0].id, 'availability-research');
  assert.equal(listed.workspaces[0].source_type, 'pr');
  assert.equal(listed.workspaces[0].freshness, 'never-synced');

  const instr = await setInstructionsTool(env, {
    workspace_id: created.workspace_id,
    instructions: ['i1', 'i2'],
  });
  assert.deepEqual(instr.instructions, ['i1', 'i2']);

  const tree = {
    name: '.',
    dirs: [
      {
        name: 'Logique métier',
        icon: 'symbol-class',
        files: ['src/a.ts'],
        dirs: [{ name: 'Stockage', files: ['src/store.ts'] }],
      },
    ],
  };
  const built = await buildTreeTool(env, {
    workspace_id: created.workspace_id,
    tree,
  });
  assert.equal(built.files_count, 2);
  const after = loadWorkspace(root, created.workspace_id);
  assert.equal(after?.tree?.dirs?.[0].name, 'Logique métier');
  assert.ok(after?.freshness?.base_commit); // HEAD renseigné
  assert.ok(after?.freshness?.file_hashes?.['src/a.ts']);
});

test('sync_workspace détecte le diff, apply_sync retire les deleted acceptés', async () => {
  const root = makeGitRoot();
  write(root, 'src/keep.ts', 'v1');
  write(root, 'src/gone.ts', 'v1');
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'c1']);
  const env = makeEnv(root);

  const created = await createWorkspaceTool(env, { source: 'texte de test' });
  await buildTreeTool(env, {
    workspace_id: created.workspace_id,
    tree: { name: '.', files: ['src/keep.ts', 'src/gone.ts'] },
  });

  // Changement dans le repo : gone.ts supprimé, keep.ts modifié.
  write(root, 'src/keep.ts', 'v2');
  fs.unlinkSync(path.join(root, 'src/gone.ts'));
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'c2']);

  const sync = await syncWorkspaceTool(env, {
    workspace_id: created.workspace_id,
  });
  assert.equal(sync.base_commit !== sync.head, true);
  const statuses = new Map(sync.changed.map((c) => [c.path, c.status]));
  assert.equal(statuses.get('src/gone.ts'), 'deleted');
  assert.equal(statuses.get('src/keep.ts'), 'modified');
  assert.ok(sync.drifted.includes('src/keep.ts'));

  // On accepte la suppression de gone.ts, on rejette... rien d'autre ici.
  const applied = await applySyncTool(env, {
    workspace_id: created.workspace_id,
    accepted: ['src/gone.ts'],
    rejected: [],
  });
  assert.deepEqual(applied.removed, ['src/gone.ts']);
  assert.equal(applied.head, sync.head);
  const ws = loadWorkspace(root, created.workspace_id);
  assert.equal(ws?.freshness?.base_commit, sync.head);
  assert.deepEqual(ws?.tree?.files, ['src/keep.ts']);

  // Une fois synchronisé, plus de diff.
  const sync2 = await syncWorkspaceTool(env, {
    workspace_id: created.workspace_id,
  });
  assert.deepEqual(sync2.changed, []);
  assert.deepEqual(sync2.drifted, []);
});

test('apply_sync conserve un fichier supprimé quand il est rejeté', async () => {
  const root = makeGitRoot();
  write(root, 'src/gone.ts', 'v1');
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'c1']);
  const env = makeEnv(root);
  const created = await createWorkspaceTool(env, { source: 'txt' });
  await buildTreeTool(env, {
    workspace_id: created.workspace_id,
    tree: { name: '.', files: ['src/gone.ts'] },
  });
  fs.unlinkSync(path.join(root, 'src/gone.ts'));
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'c2']);

  const applied = await applySyncTool(env, {
    workspace_id: created.workspace_id,
    accepted: [],
    rejected: ['src/gone.ts'],
  });
  assert.deepEqual(applied.removed, []);
  assert.deepEqual(loadWorkspace(root, created.workspace_id)?.tree?.files, [
    'src/gone.ts',
  ]);
});

test('check_workspace_files : introuvable + candidats fuzzy', async () => {
  const root = makeTempRoot();
  write(root, 'src/domain/availability_research.py', 'x');
  write(root, 'src/store.py', 'y');
  const env = makeEnv(root);
  const created = await createWorkspaceTool(env, { source: 'txt' });
  await buildTreeTool(env, {
    workspace_id: created.workspace_id,
    tree: {
      name: '.',
      files: [
        'src/domain/availability_research.py',
        'src/domain/availibility_research.py',
      ],
    },
  });
  const report = await checkWorkspaceFilesTool(env, {
    workspace_id: created.workspace_id,
  });
  assert.deepEqual(report.ok, ['src/domain/availability_research.py']);
  assert.equal(report.missing.length, 1);
  assert.equal(report.missing[0].path, 'src/domain/availibility_research.py');
  assert.equal(
    report.missing[0].candidates[0]?.path,
    'src/domain/availability_research.py',
  );
});

test('export_context primary / with_dependencies / max_tokens', async () => {
  const root = makeTempRoot();
  write(root, 'src/main.py', 'from src.store import Store\nprint(1)\n');
  write(root, 'src/store.py', 'class Store: pass\n');
  write(root, 'src/other.py', 'x = 1\n');
  const env = makeEnv(root);
  const created = await createWorkspaceTool(env, { source: 'txt' });
  await buildTreeTool(env, {
    workspace_id: created.workspace_id,
    tree: { name: '.', files: ['src/main.py'] },
  });

  const primary = await exportContextTool(env, {
    workspace_id: created.workspace_id,
    mode: 'primary',
  });
  assert.deepEqual(primary.files, ['src/main.py']);
  assert.ok(primary.content.includes('--- src/main.py ---'));

  const withDeps = await exportContextTool(env, {
    workspace_id: created.workspace_id,
    mode: 'with_dependencies',
  });
  assert.ok(withDeps.files.includes('src/store.py'));

  const limited = await exportContextTool(env, {
    workspace_id: created.workspace_id,
    mode: 'primary',
    max_tokens: 2, // très petit : tronque
  });
  assert.equal(limited.files.length, 0);
  assert.equal(limited.truncated, true);
});

test('reveal_file + set_active_workspace via hooks', async () => {
  const root = makeTempRoot();
  const env = makeEnv(root);
  const created = await createWorkspaceTool(env, { source: 'txt' });
  const calls: any[] = [];
  env.revealFile = (p, where) => void calls.push(['reveal', p, where]);
  env.setActiveWorkspace = (id) => void calls.push(['active', id]);
  env.getActiveWorkspace = () => created.workspace_id;

  await revealFileTool(env, { path: 'src/a.ts', reveal: 'editor' });
  await setActiveWorkspaceTool(env, { workspace_id: created.workspace_id });
  assert.deepEqual(calls, [
    ['reveal', 'src/a.ts', 'editor'],
    ['active', created.workspace_id],
  ]);
  const listed = await listWorkspacesTool(env);
  assert.equal(listed.active, created.workspace_id);
});

test('tools : workspace inconnu -> erreur', async () => {
  const env = makeEnv(makeTempRoot());
  await assert.rejects(
    () => syncWorkspaceTool(env, { workspace_id: 'nope' }),
    /introuvable/,
  );
});
