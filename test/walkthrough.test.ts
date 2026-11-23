import './test-home';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ToolEnv } from '../src/mcp/toolEnv';
import {
  addStepTool,
  deleteWalkthroughTool,
  getWalkthroughTool,
} from '../src/mcp/walkthroughTools';
import {
  Walkthrough,
  readWalkthrough,
  walkthroughFilePath,
} from '../src/walkthrough/walkthrough';
import { createWorkspaceTool } from '../src/mcp/workspaceTools';
import { renderWalkthroughBody } from '../src/walkthrough/walkthroughHtml';

function openRoot(): { root: string; env: ToolEnv } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-explorer-walk-'));
  return { root, env: { root, now: () => new Date('2026-11-19T10:00:00Z') } };
}

function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

const lines = (n: number, tag: string) =>
  Array.from({ length: n }, (_, i) => `${tag}${i + 1}`).join('\n') + '\n';

test('add_step : la première étape crée la visite, le JSON est écrit', async () => {
  const { root, env } = openRoot();
  write(root, 'src/a.ts', lines(40, 'a'));
  const first = await addStepTool(env, {
    walkthrough_goal: 'Remplacer le parseur (#326)',
    title: 'Point d’entrée',
    text: 'La PR remplace le parseur ici.',
    walkthrough_title: 'PR #326 : parseur',
    intent: '#326 : parseur unique',
    mode: 'changes',
    refs: [
      { path: './src/a.ts', line: 10, end_line: 12, note: 'Le point d’entrée' },
    ],
  });
  assert.equal(first.step_id, 'step-1');
  assert.equal(first.position, 1);
  assert.equal(first.total, 1);
  assert.equal(first.created, true);

  const wt = readWalkthrough(root);
  assert.equal(wt?.title, 'PR #326 : parseur');
  assert.equal(wt?.mode, 'changes');
  assert.deepEqual(wt?.steps[0].refs, [
    {
      path: 'src/a.ts',
      note: 'Le point d’entrée',
      start: 10,
      end: 12,
      snippet: 'a10\na11\na12',
    },
  ]);

  const page = renderWalkthroughBody(readWalkthrough(root)!);
  assert.match(page, /<h1>PR #326 : parseur<\/h1>/);
  assert.match(page, /<h2><span class="num">1<\/span>Point d’entrée<\/h2>/);
  assert.match(page, /La PR remplace le parseur ici\./);
  assert.match(page, /<p class="goal">.*Remplacer le parseur \(#326\)/);
  assert.match(page, /<p class="intent">.*#326 : parseur unique/);
  assert.match(page, /<p class="note"><em>Le point d’entrée<\/em><\/p>/);
  // zone cliquable vers la ligne de début + extrait figé numéroté
  assert.ok(page.includes('data-path="src/a.ts" data-line="10" data-end="12"'));
  assert.ok(
    page.includes('<span class="n">11</span><span class="t">a11</span>'),
  );

  const second = await addStepTool(env, {
    intent: 'I',
    walkthrough_goal: 'G',
    title: 'Suite',
    text: 'Puis ici.',
  });
  assert.equal(second.step_id, 'step-2');
  assert.equal(second.total, 2);
  assert.equal(readWalkthrough(root)?.title, 'PR #326 : parseur'); // inchangé
});

test('add_step : step_id existant = étape remplacée sur place (mise à jour après une question)', async () => {
  const { root, env } = openRoot();
  write(root, 'src/a.ts', lines(10, 'a'));
  await addStepTool(env, {
    intent: 'I',
    walkthrough_goal: 'G',
    title: 'Un',
    text: 'Texte 1',
  });
  await addStepTool(env, {
    intent: 'I',
    walkthrough_goal: 'G',
    title: 'Deux',
    text: 'Texte 2',
  });
  const updated = await addStepTool(env, {
    intent: 'I',
    walkthrough_goal: 'G',
    step_id: 'step-1',
    title: 'Un (précisé)',
    text: 'Texte 1 précisé',
    refs: [{ path: 'src/a.ts', line: 2 }],
  });
  assert.equal(updated.created, false);
  assert.equal(updated.position, 1);
  assert.equal(updated.total, 2);
  const wt = readWalkthrough(root);
  assert.deepEqual(wt?.steps.map((s) => s.title), ['Un (précisé)', 'Deux']);
  assert.equal(wt?.steps[0].refs[0].snippet, 'a2');
  // id libre fourni par l'agent
  await addStepTool(env, {
    intent: 'I',
    walkthrough_goal: 'G',
    step_id: 'conclusion',
    title: 'Fin',
    text: 'ok',
  });
  assert.equal(readWalkthrough(root)?.steps.at(-1)?.id, 'conclusion');
  const next = await addStepTool(env, {
    intent: 'I',
    walkthrough_goal: 'G',
    title: 'Après',
    text: 'x',
  });
  assert.equal(next.step_id, 'step-3');
});

test('add_step : zones (fichier entier, match, plafond), fichier introuvable, validations', async () => {
  const { root, env } = openRoot();
  write(root, 'src/a.ts', lines(100, 'a'));
  const res = await addStepTool(env, {
    intent: 'I',
    walkthrough_goal: 'G',
    title: 'Zones',
    text: 'x',
    refs: [
      { path: 'src/a.ts' }, // fichier entier : lien seul
      { path: 'src/a.ts', line: 1, end_line: 90 }, // plafonné
      { path: 'src/a.ts', line: 50, match: 'a7' }, // retrouvé par match
      { path: 'src/absent.ts', line: 3 },
    ],
  });
  const [whole, clamped, matched, absent] =
    readWalkthrough(root)!.steps[0].refs;
  assert.deepEqual(whole, { path: 'src/a.ts' });
  assert.equal(clamped.end! - clamped.start! + 1, 25);
  assert.equal(matched.start, 70); // occurrence de `a7` la plus proche de la ligne 50
  assert.equal(absent.snippet, undefined);
  assert.match(res.notes?.join('\n') ?? '', /plafonnée à 25 lignes/);
  assert.match(res.notes?.join('\n') ?? '', /introuvable/);

  await assert.rejects(
    () =>
      addStepTool(env, {
        intent: 'I',
        walkthrough_goal: 'G',
        title: '',
        text: 'x',
      }),
    /requis/,
  );
  await assert.rejects(
    () =>
      addStepTool(env, {
        intent: 'I',
        walkthrough_goal: 'G',
        title: 't',
        text: 'x',
        refs: Array.from({ length: 5 }, () => ({ path: 'src/a.ts' })),
      }),
    /au plus 4/,
  );
  await assert.rejects(
    () =>
      addStepTool(env, {
        intent: 'I',
        walkthrough_goal: 'G',
        title: 't',
        text: 'x',
        refs: [{ path: '../x' }],
      }),
    /chemin invalide/,
  );
  await assert.rejects(
    () =>
      addStepTool(env, {
        intent: 'I',
        walkthrough_goal: 'G',
        title: 't',
        text: 'x',
        workspace_id: 'nope',
      }),
    /introuvable/,
  );
});

test('add_step : diff -> extrait du diff unifié', async () => {
  const { root, env } = openRoot();
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  git('config', 'commit.gpgsign', 'false');
  write(root, 'src/a.rs', lines(10, 'a'));
  git('add', '.');
  git('commit', '-qm', 'c1');
  const base = git('rev-parse', 'HEAD');
  write(root, 'src/a.rs', lines(10, 'a').replace('a3', 'CHANGED'));
  git('commit', '-qam', 'c2');

  await addStepTool(env, {
    intent: 'I',
    walkthrough_goal: 'G',
    title: 'Avant/après',
    text: 'Remplacement.',
    refs: [{ path: 'src/a.rs', line: 3, diff: { from: base, to: 'HEAD' } }],
  });
  const ref = readWalkthrough(root)!.steps[0].refs[0];
  assert.equal(ref.diff, true);
  assert.match(ref.snippet!, /^@@ /);
  assert.match(ref.snippet!, /-a3\n\+CHANGED/);
  const page = renderWalkthroughBody(readWalkthrough(root)!);
  assert.ok(page.includes('class="l hunk"'));
});

test('add_step : workspace actif associé à la visite', async () => {
  const { root, env } = openRoot();
  const { workspace_id } = await createWorkspaceTool(env, { name: 'dispo' });
  await addStepTool(env, {
    intent: 'I',
    walkthrough_goal: 'G',
    title: 't',
    text: 'x',
    workspace_id,
  });
  assert.equal(readWalkthrough(root)?.workspace_id, workspace_id);
});

test('get_walkthrough / delete_walkthrough', async () => {
  const { root, env } = openRoot();
  assert.deepEqual(await getWalkthroughTool(env), { exists: false });
  assert.deepEqual(await deleteWalkthroughTool(env), {
    ok: true,
    deleted: false,
  });
  write(root, 'src/a.ts', lines(5, 'a'));
  await addStepTool(env, {
    intent: 'I',
    walkthrough_goal: 'G',
    title: 'Un',
    text: 'Texte',
    walkthrough_title: 'V',
    refs: [{ path: 'src/a.ts', line: 2 }],
  });
  const got = await getWalkthroughTool(env);
  assert.equal(got.exists, true);
  assert.equal(got.title, 'V');
  assert.deepEqual(got.steps, [
    {
      id: 'step-1',
      title: 'Un',
      intent: 'I',
      text: 'Texte',
      refs: [{ path: 'src/a.ts', start: 2, end: 2, note: undefined }],
    },
  ]);
  assert.deepEqual(await deleteWalkthroughTool(env), {
    ok: true,
    deleted: true,
  });
  assert.equal(fs.existsSync(walkthroughFilePath(root)), false);
  assert.equal(readWalkthrough(root), undefined);
});

test('rendu : tout est échappé (titre, texte, code), markdown minimal, page vide', () => {
  const wt: Walkthrough = {
    title: '<T>',
    steps: [
      {
        id: 'step-1',
        title: 'Doc &',
        text: 'Un `<b>` et **gras**',
        refs: [
          {
            path: 'docs/a.md',
            start: 1,
            end: 3,
            snippet: 'if (a < b) {}',
          },
        ],
        updated_at: '',
      },
    ],
    created_at: '',
    updated_at: '',
  };
  const html = renderWalkthroughBody(wt);
  assert.ok(html.includes('<h1>&lt;T&gt;</h1>'));
  assert.ok(html.includes('Doc &amp;'));
  assert.ok(html.includes('<code>&lt;b&gt;</code> et <strong>gras</strong>'));
  assert.ok(html.includes('if (a &lt; b) {}'));
  assert.ok(!html.includes('<b>'));
  assert.match(renderWalkthroughBody({ ...wt, steps: [] }), /Aucune étape/);
});

test('add_step : intent requis, goal requis sur la première étape', async () => {
  const { env } = openRoot();
  await assert.rejects(() =>
    addStepTool(env, { title: 't', text: 'x', walkthrough_goal: 'G' } as never),
  );
  await assert.rejects(() =>
    addStepTool(env, { title: 't', text: 'x', intent: 'I' }),
  );
});
