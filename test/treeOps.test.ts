import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countFolders, normalizeFiles } from '../src/core/treeOps';

test('normalizeFiles : ./ retiré, doublons et vides ignorés', () => {
  assert.deepEqual(normalizeFiles(['./a.rs', 'a.rs', ' b\\c.rs ', '']), [
    'a.rs',
    'b/c.rs',
  ]);
});

test('countFolders : compte les dossiers à tous les niveaux', () => {
  assert.equal(
    countFolders({
      name: '.',
      dirs: [{ name: 'a', dirs: [{ name: 'b' }] }, { name: 'c' }],
    }),
    3,
  );
});
