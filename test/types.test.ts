import './vscode-mock';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { truncate, TYPE_ICONS } from '../src/types';

test('truncate : court inchangé, long tronqué avec ellipse', () => {
  assert.equal(truncate('abc'), 'abc');
  assert.equal(truncate('a'.repeat(30)), 'a'.repeat(30));
  assert.equal(truncate('a'.repeat(31)), 'a'.repeat(30) + '…');
  assert.equal(truncate('hello world', 5), 'hello…');
});

test('TYPE_ICONS : couvre tous les types de workspace', () => {
  for (const t of ['issue', 'pr', 'text'] as const) {
    assert.ok(TYPE_ICONS[t], `icône manquante pour ${t}`);
  }
});
