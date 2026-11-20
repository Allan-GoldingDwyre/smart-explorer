import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_RANGE_LINES,
  clampEndLine,
  computeMarkRange,
  diffLineFor,
  isSafeRelPath,
  isSafeRev,
  resolveLine,
  resolveRange,
  workspaceForFile,
} from '../src/focus';

const code = ['a', 'fn start() {', 'b', 'c', 'fn start() {', 'd'].join('\n');

test('resolveLine : ligne donnée, sans extrait', () => {
  assert.equal(resolveLine(code, 3), 3);
  assert.equal(resolveLine(code), 1);
  assert.equal(resolveLine(code, 999), 6); // bornée au nombre de lignes
  assert.equal(resolveLine(code, 0), 1);
});

test('resolveLine : extrait confirmé sur la ligne, sinon occurrence la plus proche', () => {
  assert.equal(resolveLine(code, 2, 'fn start'), 2);
  assert.equal(resolveLine(code, 4, 'fn start'), 5); // le code a bougé
  assert.equal(resolveLine(code, 1, 'fn start'), 2);
  assert.equal(resolveLine(code, undefined, 'fn start'), 2); // première occurrence
  assert.equal(resolveLine(code, 3, 'introuvable'), 3); // extrait absent : on garde la ligne
});

test('workspaceForFile : l’actif s’il contient le fichier, sinon l’unique candidat, sinon rien', () => {
  assert.equal(workspaceForFile(['a', 'b'], 'b'), 'b');
  assert.equal(workspaceForFile(['b'], 'a'), 'b');
  assert.equal(workspaceForFile(['b'], undefined), 'b');
  assert.equal(workspaceForFile(['a', 'b'], 'c'), undefined); // ambigu
  assert.equal(workspaceForFile([], 'a'), undefined);
});

test('resolveRange : début/fin, décalage suivi, bornes', () => {
  const text = Array.from({ length: 10 }, (_, i) => `l${i + 1}`).join('\n');
  assert.deepEqual(resolveRange(text, 3, 6), { start: 3, end: 6 });
  assert.deepEqual(resolveRange(text, 3), { start: 3, end: 3 });
  assert.deepEqual(resolveRange(text, 3, 2), { start: 3, end: 3 }); // fin avant le début
  assert.deepEqual(resolveRange(text, 8, 99), { start: 8, end: 10 }); // bornée
  // le début est retrouvé 2 lignes plus bas grâce à `match` : la fin suit
  assert.deepEqual(resolveRange(text, 3, 5, 'l5'), { start: 5, end: 7 });
});

test('isSafeRev / isSafeRelPath : pas d’option, pas d’espace, pas de remontée', () => {
  for (const ok of [
    'HEAD',
    'HEAD~3',
    'main',
    'origin/main',
    'v1.2.3',
    'a1b2c3d4',
    'main@{1}',
  ]) {
    assert.equal(isSafeRev(ok), true, ok);
  }
  for (const bad of ['', '--output=x', '-p', 'a b', 'a;rm', 'a..b', '$(x)']) {
    assert.equal(isSafeRev(bad), false, bad);
  }
  assert.equal(isSafeRelPath('src/a.rs'), true);
  assert.equal(isSafeRelPath('../etc/passwd'), false);
  assert.equal(isSafeRelPath('/etc/passwd'), false);
  assert.equal(isSafeRelPath('a/../../b'), false);
  assert.equal(isSafeRelPath(''), false);
});

test('clampEndLine : sans line rien, jamais avant le début, plafonnée', () => {
  assert.deepEqual(clampEndLine(undefined, 50), {
    end: undefined,
    clamped: false,
  });
  assert.deepEqual(clampEndLine(10, undefined), {
    end: undefined,
    clamped: false,
  });
  assert.deepEqual(clampEndLine(10, 5), { end: 10, clamped: false });
  assert.deepEqual(clampEndLine(10, 20), { end: 20, clamped: false });
  assert.deepEqual(clampEndLine(10, 10 + MAX_RANGE_LINES - 1), {
    end: 10 + MAX_RANGE_LINES - 1,
    clamped: false,
  });
  assert.deepEqual(clampEndLine(10, 5000), {
    end: 10 + MAX_RANGE_LINES - 1,
    clamped: true,
  }); // « sélectionner tout le fichier » est refusé
});

test('computeMarkRange : fichier entier, une ligne, inline (match), petite plage', () => {
  const text = [
    'fn a() {',
    '  let x = 1;',
    '  call(x);',
    '}',
    'fn b() {}',
  ].join('\n');
  // pas de line : on parle du fichier entier -> aucune zone
  assert.equal(computeMarkRange(text), undefined);
  assert.equal(computeMarkRange(text, undefined, 30), undefined);
  // une ligne : la ligne entière
  assert.deepEqual(computeMarkRange(text, 2), { startLine: 2, endLine: 2 });
  // une ligne + match : seulement ce texte (inline)
  assert.deepEqual(computeMarkRange(text, 3, undefined, 'call(x)'), {
    startLine: 3,
    endLine: 3,
    startCol: 2,
    endCol: 9,
  });
  // match seul (sans line) : retrouve la ligne, inline
  assert.deepEqual(computeMarkRange(text, undefined, undefined, 'fn b'), {
    startLine: 5,
    endLine: 5,
    startCol: 0,
    endCol: 4,
  });
  // plage : lignes entières
  assert.deepEqual(computeMarkRange(text, 1, 4), { startLine: 1, endLine: 4 });
  // plage plafonnée
  const big = Array.from({ length: 200 }, (_, i) => `l${i + 1}`).join('\n');
  const r = computeMarkRange(big, 1, 200);
  assert.equal((r?.endLine ?? 0) - (r?.startLine ?? 0) + 1, MAX_RANGE_LINES);
});

test('diffLineFor : lignes du fichier -> lignes du document de diff unifié', () => {
  const diff = [
    'diff --git a/x.rs b/x.rs',
    'index 111..222 100644',
    '--- a/x.rs',
    '+++ b/x.rs',
    '@@ -10,4 +10,4 @@ fn f() {',
    ' ctx1', // old 10 / new 10   -> doc ligne 6
    '-old11', // old 11             -> doc ligne 7
    '+new11', // new 11             -> doc ligne 8
    ' ctx12', // old 12 / new 12   -> doc ligne 9
    '@@ -30,2 +30,3 @@',
    ' c30', // doc 11
    '+n31', // new 31 -> doc 12
    ' c32', // doc 13
  ].join('\n');
  assert.deepEqual(diffLineFor(diff, 'new', 11, 11), { first: 8, last: 8 });
  assert.deepEqual(diffLineFor(diff, 'old', 11, 11), { first: 7, last: 7 });
  assert.deepEqual(diffLineFor(diff, 'new', 10, 12), { first: 6, last: 9 });
  assert.deepEqual(diffLineFor(diff, 'new', 31, 31), { first: 12, last: 12 });
  assert.equal(diffLineFor(diff, 'new', 20, 25), undefined); // hors hunk
  // la ligne ajoutée (+n31) ne consomme pas de numéro ancien : l'ancienne ligne 31 est c32
  assert.deepEqual(diffLineFor(diff, 'old', 31, 31), { first: 13, last: 13 });
  assert.equal(diffLineFor(diff, 'old', 40, 40), undefined);
});
