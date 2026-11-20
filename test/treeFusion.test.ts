import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fuseTree } from '../src/core/treeFusion';
import { flattenTreeFiles as listTreeFiles } from '../src/core/workspaceStore';

const W = 'apps/catalogue-worker/';

test('petite liste éparpillée : tout remonte, liste plate', () => {
  const tree = fuseTree(['a/x/1.rs', 'a/y/2.rs', 'b/3.rs', 'c/z/4.rs']);
  assert.equal(tree.dirs, undefined);
  assert.deepEqual(tree.files, ['a/x/1.rs', 'a/y/2.rs', 'b/3.rs', 'c/z/4.rs']);
});

test('cas archon : préfixe commun retiré, petits dossiers dissous, structure physique conservée', () => {
  const files = [
    ...['source_models', 'snapshots', 'source_snapshots', 'mod'].map(
      (n) => `${W}src/storage/${n}.rs`,
    ),
    ...['records', 'contracts', 'builder'].map(
      (n) => `${W}src/catalogue/${n}.rs`,
    ),
    `${W}src/documents/docstral.rs`,
    `${W}src/refresh.rs`,
    ...[
      'source_models',
      'documents',
      'engine_invariants',
      'postgres',
      'refresh_postgres',
    ].map((n) => `${W}tests/${n}.rs`),
    `${W}Cargo.toml`,
    `${W}Cargo.lock`,
    `${W}deny.toml`,
  ];
  const tree = fuseTree(files);
  assert.deepEqual(tree.files, [
    `${W}Cargo.lock`,
    `${W}Cargo.toml`,
    `${W}deny.toml`,
  ]);
  assert.deepEqual(tree.dirs?.map((d) => d.name), ['src', 'tests']);
  const src = tree.dirs![0];
  assert.deepEqual(src.files, [
    `${W}src/documents/docstral.rs`,
    `${W}src/refresh.rs`,
  ]);
  assert.deepEqual(src.dirs?.map((d) => d.name), ['catalogue', 'storage']);
  assert.equal(listTreeFiles(tree).length, 17);
});

test('absorption : back/f1/f2/f3/x -> back/x (le dossier du haut garde son nom)', () => {
  const files = [
    ...[1, 2, 3].map((i) => `back/f1/f2/f3/n${i}.rs`),
    ...[1, 2, 3].map((i) => `front/ui${i}.tsx`),
    ...[1, 2, 3].map((i) => `front/lib/l${i}.ts`),
  ];
  const tree = fuseTree(files);
  const back = tree.dirs!.find((d) => d.name === 'back')!;
  assert.equal(back.dirs, undefined);
  assert.equal(back.files?.length, 3);
  const front = tree.dirs!.find((d) => d.name === 'front')!;
  assert.equal(front.files?.length, 3);
  assert.deepEqual(front.dirs?.map((d) => d.name), ['lib']);
});

test('cas archon-118 : apps/backend/src/backend/internal/... -> src/services + tests', () => {
  const base = 'apps/backend/src/backend/internal';
  const svc = `${base}/services/availability_research`;
  const files = [
    'docs/feature-availability-research.md',
    `${base}/domain/availability_research.py`,
    `${base}/workflows/workflow_availability_research.py`,
    ...[
      'dashboard_flags',
      'helm_values',
      'prompts',
      'releases',
      'research_tools',
      'store',
      'tools',
    ].map((n) => `${svc}/${n}.py`),
    ...['dashboard_flags', 'helm_values', 'prompts', 'main'].map(
      (n) => `apps/backend/tests/unit/test_availability_research_${n}.py`,
    ),
  ];
  const tree = fuseTree(files);
  assert.deepEqual(tree.files, ['docs/feature-availability-research.md']);
  assert.deepEqual(tree.dirs?.map((d) => d.name), ['src', 'tests']);
  const src = tree.dirs![0];
  assert.deepEqual(src.files, [
    `${base}/domain/availability_research.py`,
    `${base}/workflows/workflow_availability_research.py`,
  ]);
  assert.deepEqual(src.dirs?.map((d) => d.name), ['services']);
  assert.equal(src.dirs![0].files?.length, 7);
  assert.equal(tree.dirs![1].files?.length, 4);
  assert.equal(listTreeFiles(tree).length, files.length);
});

test('plafond : on arrête de fusionner quand le parent deviendrait trop chargé', () => {
  const files = Array.from({ length: 10 }, (_, i) => [
    `s/d${i}/a.rs`,
    `s/d${i}/b.rs`,
  ]).flat();
  const tree = fuseTree(files, { max_loose_files: 8 });
  const loose = tree.files?.length ?? 0;
  assert.ok(loose <= 8);
  assert.ok((tree.dirs?.length ?? 0) > 0, 'des dossiers restent');
  assert.equal(listTreeFiles(tree).length, 20);
});

test('réglages : min_folder_files élevé = liste plate, 1 = structure physique compactée', () => {
  const files = [
    'x/a/1.rs',
    'x/a/2.rs',
    'x/b/3.rs',
    'x/b/4.rs',
    'x/b/5.rs',
    'x/c/6.rs',
  ];
  assert.equal(
    fuseTree(files, { min_folder_files: 99, max_loose_files: 99 }).dirs,
    undefined,
  );
  const physical = fuseTree(files, { min_folder_files: 1 });
  assert.deepEqual(physical.dirs?.map((d) => d.name), ['a', 'b', 'c']);
});

test('doublons et ./ ignorés, vrais chemins jamais modifiés', () => {
  const tree = fuseTree(['./a/b/1.rs', 'a/b/1.rs', 'a/b/2.rs']);
  assert.deepEqual(listTreeFiles(tree).sort(), ['a/b/1.rs', 'a/b/2.rs']);
});
