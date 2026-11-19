import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_DIR_ICON, iconForVirtualDir } from '../src/virtualDirIcon';

test('icon explicite du YAML prioritaire', () => {
  assert.equal(iconForVirtualDir('Tests', 'symbol-class'), 'symbol-class');
});

test('déduction depuis le nom', () => {
  assert.equal(iconForVirtualDir('Tests unitaires'), 'beaker');
  assert.equal(iconForVirtualDir('Front React'), 'browser');
  assert.equal(iconForVirtualDir('AI agents'), 'robot');
  assert.equal(iconForVirtualDir('Déploiement CI'), 'rocket');
  assert.equal(iconForVirtualDir('Logique métier'), DEFAULT_DIR_ICON);
});
