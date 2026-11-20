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
  getWorkspaceTool,
  levenshtein,
  listWorkspacesTool,
  revealFileTool,
  stopFollowingTool,
  updateFilesTool,
  setActiveWorkspaceTool,
  setInstructionsTool,
  syncWorkspaceTool,
} from '../src/mcpTools';
import {
  loadWorkspace,
  readActive,
  readFollow,
  writeFollow,
} from '../src/workspaceStore';

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
  git(root, ['config', 'commit.gpgsign', 'false']); // indépendant de la config globale
  return root;
}

function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

// Horloge des tools (voir makeEnv) : la lecture de follow.json doit l'utiliser,
// sinon la session est jugée expirée.
const NOW = new Date('2026-11-19T10:00:00Z');

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

test('reveal_file : écrit la demande de focus (ligne, extrait, workspace) et retourne le chemin absolu', async () => {
  const root = makeTempRoot();
  write(root, 'src/a.ts', 'x');
  const env = makeEnv(root);
  const { workspace_id } = await createWorkspaceTool(env, { source: 'txt' });
  const res = await revealFileTool(env, {
    path: './src/a.ts',
    line: 12,
    end_line: 20,
    match: 'fn start',
    workspace_id,
  });
  assert.equal(res.absolute_path, path.join(root, 'src/a.ts'));
  assert.equal(res.exists, true);
  const focus = readFollow(root, NOW)?.focus;
  assert.equal(focus?.path, 'src/a.ts');
  assert.equal(focus?.line, 12);
  assert.equal(focus?.end_line, 20);
  assert.equal(readFollow(root, NOW)?.status, 'following');
  assert.equal(focus?.match, 'fn start');
  assert.equal(focus?.workspace_id, workspace_id);
  assert.equal(focus?.at, '2026-11-19T10:00:00.000Z');
  await assert.rejects(
    () => revealFileTool(env, { path: 'a', workspace_id: 'nope' }),
    /introuvable/,
  );
  assert.equal(
    (await revealFileTool(env, { path: 'absent.ts' })).exists,
    false,
  );
});

test('reveal_file sans workspace_id : suit le workspace qui contient le fichier (PR 326 vs issue 118)', async () => {
  const root = makeTempRoot();
  const env = makeEnv(root);
  const issue = (await createWorkspaceTool(env, { source: 'ARCHON-118' }))
    .workspace_id;
  const pr = (
    await createWorkspaceTool(env, {
      source: 'https://github.com/o/r/pull/326',
    })
  ).workspace_id;
  await buildTreeTool(env, {
    workspace_id: issue,
    files: ['svc/a.py', 'shared.py'],
  });
  await buildTreeTool(env, {
    workspace_id: pr,
    files: ['crate/b.rs', 'shared.py'],
  });
  await setActiveWorkspaceTool(env, { workspace_id: issue });

  // fichier propre à la PR : la vue bascule sur la PR
  await revealFileTool(env, { path: 'crate/b.rs' });
  assert.equal(readActive(root), pr);
  assert.equal(readFollow(root, NOW)?.focus?.workspace_id, pr);

  // fichier présent dans les deux : l'actif reste en place
  await revealFileTool(env, { path: 'shared.py' });
  assert.equal(readActive(root), pr);
  await setActiveWorkspaceTool(env, { workspace_id: issue });
  await revealFileTool(env, { path: './shared.py' });
  assert.equal(readActive(root), issue);

  // fichier connu d'aucun workspace : pas de basculement
  await revealFileTool(env, { path: 'ailleurs.txt' });
  assert.equal(readActive(root), issue);
  assert.equal(readFollow(root, NOW)?.focus?.workspace_id, undefined);

  // workspace_id explicite : prioritaire
  await revealFileTool(env, { path: 'svc/a.py', workspace_id: pr });
  assert.equal(readActive(root), pr);
});

test('suivi : stop_following (agent), Stop (utilisateur) et relance par un nouveau reveal', async () => {
  const root = makeTempRoot();
  const env = makeEnv(root);
  const { workspace_id } = await createWorkspaceTool(env, { source: 'txt' });
  await revealFileTool(env, { path: 'a.ts', line: 1, workspace_id });
  assert.equal(readFollow(root, NOW)?.status, 'following');

  // l'agent termine : la ligne et le surlignage doivent disparaître
  const ended = await stopFollowingTool(env);
  assert.equal(ended.was, 'following');
  assert.equal(readFollow(root, NOW)?.status, 'ended');

  // l'utilisateur clique sur Stop dans VS Code : l'affichage s'efface...
  await revealFileTool(env, { path: 'a.ts', line: 1, workspace_id });
  writeFollow(
    root,
    { status: 'ended', focus: readFollow(root, NOW)?.focus },
    NOW,
  );
  assert.equal(readFollow(root, NOW)?.status, 'ended');

  // ... mais un nouveau reveal de l'agent relance le suivi sans condition
  await revealFileTool(env, { path: 'b.ts', line: 5, workspace_id });
  assert.equal(readFollow(root, NOW)?.status, 'following');
  assert.equal(readFollow(root, NOW)?.focus?.path, 'b.ts');
});

test('reveal_file avec diff : révisions validées, demande enregistrée', async () => {
  const root = makeGitRoot();
  write(root, 'src/a.rs', 'v1\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'c1']);
  const base = git(root, ['rev-parse', 'HEAD']);
  write(root, 'src/a.rs', 'v2\n');
  git(root, ['commit', '-qam', 'c2']);
  const env = makeEnv(root);

  await revealFileTool(env, {
    path: 'src/a.rs',
    line: 1,
    end_line: 1,
    diff: { from: base, to: 'HEAD', side: 'old' },
  });
  const focus = readFollow(root, NOW)?.focus;
  assert.deepEqual(focus?.diff, { from: base, to: 'HEAD', side: 'old' });

  // `to` absent = code actuel ; renommage via from_path
  await revealFileTool(env, {
    path: 'src/b.rs',
    diff: { from: 'HEAD~1', from_path: 'src/a.rs' },
  });
  assert.equal(readFollow(root, NOW)?.focus?.diff?.from_path, 'src/a.rs');

  await assert.rejects(
    () => revealFileTool(env, { path: 'src/a.rs', diff: { from: 'nope' } }),
    /introuvable/,
  );
  await assert.rejects(
    () =>
      revealFileTool(env, { path: 'src/a.rs', diff: { from: '--output=x' } }),
    /invalide/,
  );
  await assert.rejects(
    () =>
      revealFileTool(env, {
        path: 'src/a.rs',
        diff: { from: 'HEAD', from_path: '../secret' },
      }),
    /chemin invalide/,
  );
  // sans diff : comportement inchangé
  await revealFileTool(env, { path: 'src/a.rs', line: 2 });
  assert.equal(readFollow(root, NOW)?.focus?.diff, undefined);
});

test('reveal_file : garde-fous de granularité et de diff', async () => {
  const root = makeGitRoot();
  const lines = (n: number, tag: string) =>
    Array.from({ length: n }, (_, i) => `${tag}${i + 1}`).join('\n') + '\n';
  write(root, 'src/small.rs', lines(10, 'a'));
  write(root, 'src/big.rs', lines(200, 'b'));
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'c1']);
  const base = git(root, ['rev-parse', 'HEAD']);
  write(root, 'src/small.rs', lines(10, 'a').replace('a3', 'CHANGED')); // 1 ligne modifiée
  write(root, 'src/big.rs', lines(200, 'z')); // réécriture totale
  write(root, 'src/new.rs', lines(300, 'n')); // fichier nouveau
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'c2']);
  const env = makeEnv(root);

  // petit changement sur un fichier existant : le diff est conservé
  const ok = await revealFileTool(env, {
    path: 'src/small.rs',
    line: 3,
    diff: { from: base, to: 'HEAD' },
  });
  assert.equal(ok.notes, undefined);
  assert.equal(readFollow(root, NOW)?.focus?.diff?.from, base);

  // réécriture totale : diff ignoré (trop gros), code actuel affiché
  const big = await revealFileTool(env, {
    path: 'src/big.rs',
    line: 1,
    diff: { from: base, to: 'HEAD' },
  });
  assert.match(big.notes?.join(' ') ?? '', /diff ignoré.*lignes modifiées/);
  assert.equal(readFollow(root, NOW)?.focus?.diff, undefined);

  // fichier nouveau : pas de diff, code actuel
  const created = await revealFileTool(env, {
    path: 'src/new.rs',
    line: 1,
    diff: { from: base, to: 'HEAD' },
  });
  assert.match(created.notes?.join(' ') ?? '', /fichier nouveau/);
  assert.equal(readFollow(root, NOW)?.focus?.diff, undefined);

  // fichier inchangé : pas de diff vide
  write(root, 'src/same.rs', 'x\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'c3']);
  const same = await revealFileTool(env, {
    path: 'src/same.rs',
    diff: { from: 'HEAD~0', to: 'HEAD' },
  });
  assert.match(same.notes?.join(' ') ?? '', /aucun changement/);

  // plage énorme (« tout le fichier ») : plafonnée à 25 lignes
  const clamped = await revealFileTool(env, {
    path: 'src/new.rs',
    line: 1,
    end_line: 300,
  });
  assert.match(clamped.notes?.join(' ') ?? '', /plafonnée à 25 lignes/);
  assert.equal(readFollow(root, NOW)?.focus?.end_line, 25);

  // une plage normale n'est pas touchée ; sans line, end_line est ignorée
  await revealFileTool(env, { path: 'src/new.rs', line: 10, end_line: 20 });
  assert.equal(readFollow(root, NOW)?.focus?.end_line, 20);
  const whole = await revealFileTool(env, { path: 'src/new.rs', end_line: 50 });
  assert.match(whole.notes?.join(' ') ?? '', /end_line ignorée/);
  assert.equal(readFollow(root, NOW)?.focus?.end_line, undefined);
  assert.equal(readFollow(root, NOW)?.focus?.line, undefined); // fichier entier
});

test('build_tree avec focus : le fichier d’attention est demandé après la construction', async () => {
  const root = makeTempRoot();
  const env = makeEnv(root);
  const { workspace_id } = await createWorkspaceTool(env, { source: 'txt' });
  assert.equal(readFollow(root, NOW)?.focus, undefined);
  await buildTreeTool(env, {
    workspace_id,
    files: ['src/a.ts', 'src/b.ts'],
    focus: { path: 'src/b.ts', line: 3 },
  });
  const focus = readFollow(root, NOW)?.focus;
  assert.equal(focus?.path, 'src/b.ts');
  assert.equal(focus?.line, 3);
  assert.equal(focus?.workspace_id, workspace_id);
  assert.ok(loadWorkspace(root, workspace_id)?.tree);
  // pas de focus demandé : celui d'avant n'est pas réécrit
  await buildTreeTool(env, { workspace_id, files: ['src/a.ts'] });
  assert.equal(readFollow(root, NOW)?.focus?.path, 'src/b.ts');
});

test('get_workspace : source, besoin, fichiers et arbre ; par défaut le workspace actif', async () => {
  const root = makeTempRoot();
  const env = makeEnv(root);
  const { workspace_id } = await createWorkspaceTool(env, {
    source: 'https://github.com/o/r/pull/7',
    instructions: ['relire la migration serde'],
  });
  await buildTreeTool(env, { workspace_id, files: ['src/a.rs', 'src/b.rs'] });
  await assert.rejects(
    () => getWorkspaceTool(env, {}),
    /aucun workspace actif/,
  );
  await setActiveWorkspaceTool(env, { workspace_id });
  const ws = await getWorkspaceTool(env, {});
  assert.equal(ws.id, workspace_id);
  assert.equal(ws.active, true);
  assert.equal(ws.source.url, 'https://github.com/o/r/pull/7');
  assert.deepEqual(ws.instructions, ['relire la migration serde']);
  assert.deepEqual(ws.files.sort(), ['src/a.rs', 'src/b.rs']);
  assert.ok(ws.tree);
});

test('tools : workspace inconnu -> erreur', async () => {
  const env = makeEnv(makeTempRoot());
  await assert.rejects(
    () => syncWorkspaceTool(env, { workspace_id: 'nope' }),
    /introuvable/,
  );
});
