import './test-home';
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
  updateFilesTool,
  setActiveWorkspaceTool,
  setInstructionsTool,
  syncWorkspaceTool,
} from '../src/mcpTools';
import { loadWorkspace, readActive } from '../src/workspaceStore';

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

  const built = await buildTreeTool(env, {
    workspace_id: created.workspace_id,
    tree: { files: ['src/a.ts', './src/a.ts', 'src/store.ts'] },
  });
  assert.equal(built.files_count, 2); // doublon retiré
  assert.deepEqual(built.missing_files, ['src/store.ts']);
  const after = loadWorkspace(root, created.workspace_id);
  assert.deepEqual(after?.tree?.files, ['src/a.ts', 'src/store.ts']);
  assert.equal(after?.tree?.dirs, undefined);
  assert.ok(after?.freshness?.base_commit); // HEAD renseigné
  assert.ok(after?.freshness?.file_hashes?.['src/a.ts']);
});

test('build_tree : l’agent décide les dossiers, sans limite ; doublons retirés', async () => {
  const root = makeTempRoot();
  const env = makeEnv(root);
  const { workspace_id } = await createWorkspaceTool(env, { source: 'txt' });
  const built = await buildTreeTool(env, {
    workspace_id,
    tree: {
      files: ['README.md'],
      dirs: [
        {
          name: 'Types simples',
          files: ['a.rs', 'b.rs'],
          dirs: [{ name: 'Sous', files: ['c.rs'] }],
        },
        { name: 'Storage', files: ['a.rs', 'd.rs'] }, // a.rs déjà placé plus haut
        { name: 'vide', files: [] },
        { name: 'D1', files: ['1.rs'] },
        { name: 'D2', files: ['2.rs'] },
        { name: 'D3', files: ['3.rs'] },
        { name: 'D4', files: ['4.rs'] },
        { name: 'D5', files: ['5.rs'] },
        { name: 'D6', files: ['6.rs'] },
      ],
    },
  });
  assert.equal(built.files_count, 11); // a.rs une seule fois
  assert.equal(built.folders_count, 9); // aucun plafond, "vide" supprimé
  const ws = loadWorkspace(root, workspace_id);
  assert.equal(ws?.tree?.dirs?.[0].dirs?.[0].name, 'Sous');
  await assert.rejects(
    () =>
      buildTreeTool(env, { workspace_id, tree: { dirs: [{ files: ['x'] }] } }),
    /name/,
  );
  await assert.rejects(
    () => buildTreeTool(env, { workspace_id, tree: undefined }),
    /exactement/,
  );
});

test('update_files : into, remove, structure conservée', async () => {
  const root = makeTempRoot();
  const env = makeEnv(root);
  const { workspace_id } = await createWorkspaceTool(env, { source: 'txt' });
  await buildTreeTool(env, {
    workspace_id,
    tree: {
      dirs: [
        { name: 'Storage', files: ['s1.rs', 's2.rs'] },
        { name: 'Tests', files: ['t1.rs'] },
      ],
    },
  });
  await updateFilesTool(env, {
    workspace_id,
    add: ['s3.rs', 'n1.rs'],
    remove: ['t1.rs'],
    into: 'Storage',
  });
  const tree = loadWorkspace(root, workspace_id)?.tree;
  assert.deepEqual(tree?.dirs?.map((d) => d.name), ['Storage']); // Tests vidé -> supprimé
  assert.deepEqual(tree?.dirs?.[0].files, ['s1.rs', 's2.rs', 's3.rs', 'n1.rs']);
  await updateFilesTool(env, {
    workspace_id,
    add: ['r.rs'],
    into: 'Nouveau/Sous',
  });
  assert.equal(
    loadWorkspace(root, workspace_id)?.tree?.dirs?.[1].dirs?.[0].files?.[0],
    'r.rs',
  );
});

test('build_tree files : fusion automatique, rejouée par update_files ; into refusé', async () => {
  const root = makeTempRoot();
  const env = makeEnv(root);
  const { workspace_id } = await createWorkspaceTool(env, { source: 'txt' });
  const files = [
    ...[1, 2, 3].map((i) => `src/a/f${i}.rs`),
    ...[1, 2, 3].map((i) => `src/b/f${i}.rs`),
    'src/one/x.rs',
  ];
  const built = await buildTreeTool(env, { workspace_id, files });
  assert.equal(built.mode, 'fusion');
  assert.equal(built.files_count, 7);
  const tree = loadWorkspace(root, workspace_id)?.tree;
  assert.deepEqual(tree?.dirs?.map((d) => d.name), ['a', 'b']);
  assert.deepEqual(tree?.files, ['src/one/x.rs']); // petit dossier remonté

  await updateFilesTool(env, {
    workspace_id,
    remove: ['src/b/f1.rs', 'src/b/f2.rs'],
  });
  const after = loadWorkspace(root, workspace_id)?.tree;
  assert.deepEqual(after?.dirs?.map((d) => d.name), ['a']); // b trop petit -> dissous
  await assert.rejects(
    () => updateFilesTool(env, { workspace_id, add: ['z.rs'], into: 'a' }),
    /into/,
  );
  // flat via réglage
  const flat = await buildTreeTool(env, {
    workspace_id,
    files,
    min_folder_files: 99,
    max_loose_files: 99,
  });
  assert.equal(flat.folders_count, 0);
  // files et tree ensemble, ou aucun : refusé
  await assert.rejects(
    () => buildTreeTool(env, { workspace_id, files, tree: {} }),
    /exactement/,
  );
  await assert.rejects(
    () => buildTreeTool(env, { workspace_id }),
    /exactement/,
  );
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
    tree: { files: ['src/keep.ts', 'src/gone.ts'] },
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
    tree: { files: ['src/gone.ts'] },
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

test('export_context : contenu des fichiers, tronqué à max_tokens', async () => {
  const root = makeTempRoot();
  write(root, 'src/main.py', 'print(1)\n');
  const env = makeEnv(root);
  const created = await createWorkspaceTool(env, { source: 'txt' });
  await buildTreeTool(env, {
    workspace_id: created.workspace_id,
    tree: { files: ['src/main.py'] },
  });

  const full = await exportContextTool(env, {
    workspace_id: created.workspace_id,
  });
  assert.deepEqual(full.files, ['src/main.py']);
  assert.ok(full.content.includes('--- src/main.py ---'));

  const limited = await exportContextTool(env, {
    workspace_id: created.workspace_id,
    max_tokens: 2, // très petit : tronque
  });
  assert.equal(limited.files.length, 0);
  assert.equal(limited.truncated, true);
});

test('set_active_workspace écrit le fichier actif, list_workspaces le relit', async () => {
  const root = makeTempRoot();
  const env = makeEnv(root);
  const created = await createWorkspaceTool(env, { source: 'txt' });
  await setActiveWorkspaceTool(env, { workspace_id: created.workspace_id });
  assert.equal(readActive(root), created.workspace_id);
  const listed = await listWorkspacesTool(env);
  assert.equal(listed.active, created.workspace_id);
});

test('reveal_file : retourne le chemin absolu', async () => {
  const root = makeTempRoot();
  const res = await revealFileTool(makeEnv(root), { path: 'src/a.ts' });
  assert.equal(res.absolute_path, path.join(root, 'src/a.ts'));
});

test('tools : workspace inconnu -> erreur', async () => {
  const env = makeEnv(makeTempRoot());
  await assert.rejects(
    () => syncWorkspaceTool(env, { workspace_id: 'nope' }),
    /introuvable/,
  );
});
