import './vscode-mock';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAddWorkspaceFlow } from '../src/workspaceForm';
import {
  inputQueue,
  makeContext,
  quickPickQueue,
  resetMock,
  vscodeMock,
} from './vscode-mock';

const SMART = { label: 'Smart', type: 'smart' };
const TEXT = { label: 'Text', type: 'text' };

test('flow smart : URL PR GitHub détectée, ref canonicalisée, nom demandé', async () => {
  resetMock();
  vscodeMock.workspace.workspaceFolders = []; // pas de remote git -> pas de résolution #N
  quickPickQueue.push(SMART);
  inputQueue.push('https://github.com/org/repo/pull/42', 'Ma PR');
  const entry = await runAddWorkspaceFlow(makeContext());
  assert.deepEqual(entry, {
    name: 'Ma PR',
    type: 'pr',
    ref: 'https://github.com/org/repo/pull/42',
  });
});

test('flow smart : #376 détecté comme issue GitHub (sans repo courant, ref gardée telle quelle)', async () => {
  resetMock();
  vscodeMock.workspace.workspaceFolders = [];
  quickPickQueue.push(SMART);
  inputQueue.push('#376', 'Mon issue');
  const entry = await runAddWorkspaceFlow(makeContext());
  assert.deepEqual(entry, { name: 'Mon issue', type: 'issue', ref: '#376' });
});

test('flow smart : ID Linear détecté et normalisé', async () => {
  resetMock();
  quickPickQueue.push(SMART);
  inputQueue.push('eng-42', 'Mon ticket');
  const entry = await runAddWorkspaceFlow(makeContext());
  assert.deepEqual(entry, { name: 'Mon ticket', type: 'issue', ref: 'ENG-42' });
});

test('flow smart : texte libre -> type text', async () => {
  resetMock();
  quickPickQueue.push(SMART);
  inputQueue.push('une feature quelconque', 'Feature X');
  const entry = await runAddWorkspaceFlow(makeContext());
  assert.deepEqual(entry, {
    name: 'Feature X',
    type: 'text',
    ref: 'une feature quelconque',
  });
});

test('flow : annulation au quick pick -> undefined', async () => {
  resetMock();
  quickPickQueue.push(undefined);
  assert.equal(await runAddWorkspaceFlow(makeContext()), undefined);
});

test('flow : annulation au champ ref -> undefined', async () => {
  resetMock();
  quickPickQueue.push(SMART);
  inputQueue.push(undefined);
  assert.equal(await runAddWorkspaceFlow(makeContext()), undefined);
});

test('flow : annulation au champ nom -> undefined', async () => {
  resetMock();
  quickPickQueue.push(TEXT);
  inputQueue.push('ma description', undefined);
  assert.equal(await runAddWorkspaceFlow(makeContext()), undefined);
});

test('flow text : description devient ref et nom par défaut', async () => {
  resetMock();
  quickPickQueue.push(TEXT);
  inputQueue.push('ma description', 'Nom custom');
  const entry = await runAddWorkspaceFlow(makeContext());
  assert.deepEqual(entry, {
    name: 'Nom custom',
    type: 'text',
    ref: 'ma description',
  });
});
