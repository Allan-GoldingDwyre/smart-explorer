import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GithubResolver,
  WorkspaceLink,
  addLinks,
  parseLinkInput,
  removeLinks,
  resolveLink,
  workspaceKind,
} from '../src/core/links';
import { parseGithubRemote } from '../src/core/github';

test('parseLinkInput : Linear, URL GitHub, formes courtes, inconnu', () => {
  assert.deepEqual(parseLinkInput('abc-123'), {
    kind: 'link',
    link: { kind: 'linear-issue', ref: 'ABC-123' },
  });
  assert.deepEqual(parseLinkInput('https://linear.app/acme/issue/ENG-42/x'), {
    kind: 'link',
    link: {
      kind: 'linear-issue',
      ref: 'ENG-42',
      url: 'https://linear.app/acme/issue/ENG-42/x',
    },
  });
  assert.deepEqual(parseLinkInput('https://github.com/o/r/pull/376'), {
    kind: 'link',
    link: {
      kind: 'github-pr',
      ref: 'o/r#376',
      url: 'https://github.com/o/r/pull/376',
    },
  });
  assert.equal(
    (parseLinkInput('https://github.com/o/r/issues/7') as any).link.kind,
    'github-issue',
  );
  assert.deepEqual(parseLinkInput('#42'), {
    kind: 'github-number',
    number: 42,
  });
  assert.deepEqual(parseLinkInput('42'), { kind: 'github-number', number: 42 });
  assert.deepEqual(parseLinkInput('o/r#42'), {
    kind: 'github-number',
    repo: 'o/r',
    number: 42,
  });
  assert.deepEqual(parseLinkInput('refactor le store'), {
    kind: 'unknown',
    raw: 'refactor le store',
  });
});

test('resolveLink : #N résolu par le résolveur GitHub (issue ou PR)', async () => {
  const calls: string[] = [];
  const github: GithubResolver = async (repo, n) => {
    calls.push(`${repo}#${n}`);
    return n === 5
      ? { kind: 'github-pr', title: 'Ma PR', url: 'https://x/pull/5' }
      : { kind: 'github-issue', title: 'Un bug' };
  };
  const ctx = { defaultRepo: 'o/r', github };
  assert.deepEqual((await resolveLink('#5', ctx)).link, {
    kind: 'github-pr',
    ref: 'o/r#5',
    title: 'Ma PR',
    url: 'https://x/pull/5',
  });
  assert.equal((await resolveLink('12', ctx)).link.kind, 'github-issue');
  assert.equal((await resolveLink('a/b#3', ctx)).link.ref, 'a/b#3');
  assert.deepEqual(calls, ['o/r#5', 'o/r#12', 'a/b#3']);
  // une URL complète se passe de `gh`
  calls.length = 0;
  await resolveLink('https://github.com/o/r/pull/5', ctx);
  assert.deepEqual(calls, []);
});

test('resolveLink : ne perd jamais la saisie (gh indisponible, dépôt inconnu, lien inconnu)', async () => {
  const none: GithubResolver = async () => undefined;
  const a = await resolveLink('#5', { defaultRepo: 'o/r', github: none });
  assert.deepEqual(a.link, { kind: 'unknown', ref: 'o/r#5' });
  assert.match(a.note!, /gh/);
  const b = await resolveLink('#5', { github: none });
  assert.deepEqual(b.link, { kind: 'unknown', ref: '#5' });
  assert.match(b.note!, /dépôt/);
  const c = await resolveLink('bla bla');
  assert.equal(c.link.kind, 'unknown');
  assert.ok(c.note);
});

test('addLinks : sans doublon, un lien précisé remplace un `unknown`', () => {
  const issue: WorkspaceLink = { kind: 'linear-issue', ref: 'ARCHON-1' };
  const unknown: WorkspaceLink = { kind: 'unknown', ref: 'o/r#5' };
  const pr: WorkspaceLink = { kind: 'github-pr', ref: 'o/r#5', title: 'P' };
  let links = addLinks([], [issue, unknown, issue]);
  assert.equal(links.length, 2);
  links = addLinks(links, [pr]);
  assert.deepEqual(links[1], pr);
  // un `unknown` n'écrase pas un lien déjà résolu
  links = addLinks(links, [unknown]);
  assert.equal(links[1].kind, 'github-pr');
});

test('removeLinks : par URL, ref courte ou #N', () => {
  const links: WorkspaceLink[] = [
    { kind: 'linear-issue', ref: 'ARCHON-1' },
    { kind: 'github-issue', ref: 'o/r#5' },
    { kind: 'github-pr', ref: 'o/r#6' },
  ];
  assert.deepEqual(
    removeLinks(links, ['archon-1']).map((l) => l.ref),
    ['o/r#5', 'o/r#6'],
  );
  assert.deepEqual(
    removeLinks(links, ['https://github.com/o/r/issues/5']).map((l) => l.ref),
    ['ARCHON-1', 'o/r#6'],
  );
  assert.deepEqual(
    removeLinks(links, ['#6']).map((l) => l.ref),
    ['ARCHON-1', 'o/r#5'],
  );
  assert.deepEqual(
    removeLinks(links, ['#6'], 'autre/depot').map((l) => l.ref),
    ['ARCHON-1', 'o/r#5', 'o/r#6'],
  );
});

test('workspaceKind : une PR l’emporte, sinon issue, sinon texte', () => {
  assert.equal(workspaceKind(undefined), 'text');
  assert.equal(workspaceKind([{ kind: 'linear-issue', ref: 'A-1' }]), 'issue');
  assert.equal(
    workspaceKind([
      { kind: 'linear-issue', ref: 'A-1' },
      { kind: 'github-pr', ref: 'o/r#2' },
    ]),
    'pr',
  );
});

test('parseGithubRemote : https et ssh', () => {
  assert.equal(parseGithubRemote('https://github.com/o/r.git\n'), 'o/r');
  assert.equal(parseGithubRemote('git@github.com:o/r.git'), 'o/r');
  assert.equal(parseGithubRemote('https://github.com/o/r'), 'o/r');
  assert.equal(parseGithubRemote('https://gitlab.com/o/r.git'), undefined);
});
