import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addFilesToTree,
  countFolders,
  normalizeFiles,
  normalizeTree,
  removeFilesFromTree,
} from '../src/treeOps';
import { flattenTreeFiles as listTreeFiles } from '../src/workspaceStore';

test('normalizeFiles : ./ retiré, doublons et vides ignorés', () => {
  assert.deepEqual(normalizeFiles(['./a.rs', 'a.rs', ' b\\c.rs ', '']), [
    'a.rs',
    'b/c.rs',
  ]);
});

test('normalizeTree : aucun plafond, doublons (dossier le plus profond gagne), vides retirés', () => {
  const tree = normalizeTree({
    files: ['a.rs', 'z.rs'],
    dirs: [
      {
        name: 'x',
        files: ['a.rs', 'b.rs'],
        dirs: [{ name: 'deep', files: ['c.rs'] }],
      },
      { name: 'vide', files: ['z.rs'], dirs: [] },
      ...Array.from({ length: 10 }, (_, i) => ({
        name: `d${i}`,
        files: [`f${i}.rs`],
      })),
    ],
  });
  assert.deepEqual(tree.files, undefined); // a.rs et z.rs placés dans les dossiers
  assert.equal(tree.dirs?.length, 12);
  assert.equal(countFolders(tree), 13);
  assert.equal(new Set(listTreeFiles(tree)).size, listTreeFiles(tree).length);
});

test('normalizeTree : structure invalide refusée', () => {
  assert.throws(() => normalizeTree(null), /objet/);
  assert.throws(() => normalizeTree({ dirs: [{ files: ['a'] }] }), /name/);
  assert.throws(() => normalizeTree({ files: 'a.rs' }), /liste/);
});

test('removeFilesFromTree / addFilesToTree', () => {
  let tree = normalizeTree({
    dirs: [
      { name: 's', files: ['a.rs', 'b.rs'] },
      { name: 't', files: ['c.rs'] },
    ],
  });
  tree = removeFilesFromTree(tree, new Set(['c.rs']));
  assert.deepEqual(tree.dirs?.map((d) => d.name), ['s']); // t vidé -> supprimé
  tree = addFilesToTree(tree, ['d.rs', 'a.rs'], 's');
  assert.deepEqual(tree.dirs?.[0].files, ['a.rs', 'b.rs', 'd.rs']);
  tree = addFilesToTree(tree, ['e.rs'], 'x/y');
  assert.deepEqual(tree.dirs?.[1].dirs?.[0].files, ['e.rs']);
  tree = addFilesToTree(tree, ['r.rs']);
  assert.deepEqual(tree.files, ['r.rs']);
});
