import './vscode-mock';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalizeRef,
  detectRef,
  normalizeRef,
  resolveGithubRef,
} from '../src/refs';
import { isGithubRef, isLinearRef } from '../src/auth';
import { resetMock, vscodeMock } from './vscode-mock';

test('detectRef : ID Linear (normalisé en majuscules)', () => {
  assert.deepEqual(detectRef('abc-123'), { type: 'issue', ref: 'ABC-123' });
  assert.deepEqual(detectRef('  ENG-42  '), { type: 'issue', ref: 'ENG-42' });
});

test('detectRef : URL Linear', () => {
  assert.deepEqual(
    detectRef('https://linear.app/mistral/issue/eng-42/some-title'),
    {
      type: 'issue',
      ref: 'ENG-42',
    },
  );
});

test('detectRef : URL PR GitHub', () => {
  const url = 'https://github.com/org/repo/pull/42';
  assert.deepEqual(detectRef(url), { type: 'pr', ref: url });
});

test('detectRef : URL issue GitHub', () => {
  const url = 'https://github.com/org/repo/issues/376';
  assert.deepEqual(detectRef(url), { type: 'issue', ref: url });
});

test('detectRef : raccourci #N GitHub', () => {
  assert.deepEqual(detectRef('#376'), { type: 'issue', ref: '#376' });
});

test('detectRef : texte libre en fallback', () => {
  assert.deepEqual(detectRef('Feature Availability Research'), {
    type: 'text',
    ref: 'Feature Availability Research',
  });
});

test('normalizeRef : majuscules pour Linear, inchangé sinon', () => {
  assert.equal(normalizeRef('abc-1'), 'ABC-1');
  assert.equal(normalizeRef('ABC-1'), 'ABC-1');
  assert.equal(normalizeRef('#42'), '#42');
  assert.equal(
    normalizeRef('https://github.com/o/r/pull/1'),
    'https://github.com/o/r/pull/1',
  );
});

test('resolveGithubRef : URL complète', async () => {
  const gh = await resolveGithubRef(
    'https://github.com/org/repo/pull/42',
    'pr',
  );
  assert.deepEqual(gh, {
    owner: 'org',
    repo: 'repo',
    num: '42',
    kind: 'pulls',
  });
  const issue = await resolveGithubRef(
    'https://github.com/org/repo/issues/376',
    'issue',
  );
  assert.deepEqual(issue, {
    owner: 'org',
    repo: 'repo',
    num: '376',
    kind: 'issues',
  });
});

test('resolveGithubRef : #N sans workspace -> undefined (pas de repo courant)', async () => {
  resetMock();
  vscodeMock.workspace.workspaceFolders = [];
  assert.equal(await resolveGithubRef('#317', 'pr'), undefined);
});

test('canonicalizeRef : URL conservée, #N sans repo conservé, text inchangé', async () => {
  resetMock();
  vscodeMock.workspace.workspaceFolders = [];
  const url = 'https://github.com/org/repo/pull/42';
  assert.equal(await canonicalizeRef('pr', url), url);
  assert.equal(await canonicalizeRef('pr', '#42'), '#42');
  assert.equal(await canonicalizeRef('text', 'ma note'), 'ma note');
});

test('isLinearRef / isGithubRef', () => {
  assert.equal(isLinearRef('ABC-123'), true);
  assert.equal(isLinearRef('abc-123'), false);
  assert.equal(isLinearRef('#12'), false);
  assert.equal(isGithubRef('https://github.com/o/r/issues/1'), true);
  assert.equal(isGithubRef('https://github.com/o/r/pull/1'), true);
  assert.equal(isGithubRef('ABC-1'), false);
});
