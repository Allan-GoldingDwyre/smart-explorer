import './test-home';
import './vscode-mock';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WalkthroughController } from '../src/walkthroughController';
import {
  ToolEnv,
  walkthroughReplyTool,
  walkthroughStartTool,
  walkthroughStepTool,
  walkthroughWaitTool,
} from '../src/mcpTools';
import {
  readEvents,
  readWalkthrough,
  writeUiHeartbeat,
} from '../src/walkthrough';
import { executedCommands, resetMock, vscodeMock } from './vscode-mock';

function setup() {
  resetMock();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'se-walkctl-'));
  const now = new Date();
  writeUiHeartbeat(root, now);
  const env: ToolEnv = { root, sleep: async () => undefined };
  const shown: any[] = [];
  const logs: string[] = [];
  let ended = 0;
  const controller = new WalkthroughController(root, {
    showStep: async (focus) => {
      shown.push(focus);
      return {
        uri: vscodeMock.Uri.file(path.join(root, focus.path)),
        line: focus.line ?? 1,
      };
    },
    endFollow: () => {
      ended++;
    },
    refresh: () => undefined,
    log: (m) => logs.push(m),
  });
  const ctl = () => vscodeMock.comments.controllers[0];
  const live = () => ctl().threads.filter((t: any) => !t.disposed);
  return { root, env, controller, shown, logs, ctl, live, ended: () => ended };
}

test('contrôleur : la première étape ouvre le fichier et crée le fil au-dessus de la ligne', async () => {
  const { env, controller, shown, live, logs } = setup();
  await controller.sync(); // pas de visite : rien
  assert.equal(live().length, 0);

  await walkthroughStartTool(env, {
    mode: 'changes',
    title: 'PR',
    outline: ['A', 'B', 'C'],
  });
  await walkthroughStepTool(env, {
    title: 'Dépendances',
    text: 'chrono retiré.',
    path: 'Cargo.toml',
    line: 39,
  });
  await controller.sync();

  assert.equal(shown.length, 1);
  assert.equal(shown[0].path, 'Cargo.toml');
  assert.equal(live().length, 1);
  const thread = live()[0];
  assert.equal(thread.range.startLine, 37); // 0-based : ligne 39 -> ancré sur la ligne 38
  assert.equal(thread.canReply, true);
  assert.equal(thread.comments.length, 1);
  assert.equal(thread.comments[0].body.value, 'chrono retiré.');
  assert.equal(thread.comments[0].author.name, 'Smart Explorer');
  assert.match(thread.label, /Étape 1\/3 … — Dépendances/);
  assert.ok(logs.some((l) => l.includes('fil créé')));
  assert.equal(controller.active, true);
});

test('contrôleur : étapes en flux, Continuer attend la génération puis affiche', async () => {
  const { env, root, controller, shown, live } = setup();
  await walkthroughStartTool(env, { mode: 'flow', outline: ['A', 'B'] });
  await walkthroughStepTool(env, {
    title: 'A',
    text: 'a',
    path: 'a.rs',
    line: 5,
  });
  await controller.sync();
  assert.equal(shown.length, 1);

  // Continuer alors que l'étape 2 n'existe pas encore : indicateur de génération
  await controller.next();
  assert.equal(shown.length, 1);
  assert.match(live()[0].comments.at(-1).body.value, /Génération de l'étape 2/);
  assert.equal(readEvents(root).at(-1)?.type, 'continue');

  // l'agent pousse l'étape 2 : elle s'affiche seule
  await walkthroughStepTool(env, {
    title: 'B',
    text: 'b',
    path: 'b.rs',
    line: 9,
    last: true,
  });
  await controller.sync();
  assert.equal(shown.length, 2);
  assert.equal(shown[1].path, 'b.rs');
  assert.equal(live().length, 1); // l'ancien fil d'étape a disparu
  assert.equal(live()[0].comments[0].body.value, 'b');

  // Précédent
  await controller.back();
  assert.equal(shown[2].path, 'a.rs');
  assert.equal(readEvents(root).at(-1)?.type, 'back');
});

test('contrôleur : commentaire de l’utilisateur -> événement ; réponse de l’agent dans le fil', async () => {
  const { env, root, controller, live } = setup();
  const { session } = await walkthroughStartTool(env, { mode: 'review' });
  assert.ok(session);
  await walkthroughStepTool(env, {
    title: 'A',
    text: 'Explication.',
    path: 'a.rs',
    line: 3,
  });
  await controller.sync();
  const thread = live()[0];

  await controller.reply({ thread, text: '  Pourquoi ? ' } as any);
  const ev = readEvents(root).at(-1)!;
  assert.equal(ev.type, 'comment');
  assert.equal(ev.thread, 'step-1');
  assert.equal(ev.text, 'Pourquoi ?');
  assert.equal(thread.comments.length, 2); // affiché tout de suite
  assert.equal(thread.comments[1].author.name, 'Vous');

  // l'agent reçoit le commentaire et répond dans le même fil
  const got = await walkthroughWaitTool(env, { timeout_s: 1 });
  assert.equal(got.events[0].text, 'Pourquoi ?');
  await walkthroughReplyTool(env, {
    thread: got.events[0].thread!,
    text: 'Parce que.',
  });
  await controller.sync();
  assert.deepEqual(
    thread.comments.map((c: any) => c.body.value),
    ['Explication.', 'Pourquoi ?', 'Parce que.'],
  );
});

test('contrôleur : fil de question posé sur une ligne (user-N)', async () => {
  const { env, root, controller, live } = setup();
  await walkthroughStartTool(env, { mode: 'flow' });
  await walkthroughStepTool(env, {
    title: 'A',
    text: 'a',
    path: 'a.rs',
    line: 3,
  });
  await controller.sync();
  const userThread: any = {
    uri: { fsPath: path.join(root, 'x.rs') },
    range: { start: { line: 6 } },
    comments: [],
    canReply: false,
    dispose() {},
  };
  await controller.reply({ thread: userThread, text: 'Et ici ?' } as any);
  const ev = readEvents(root).at(-1)!;
  assert.match(ev.thread ?? '', /^user-\d+$/);
  assert.equal(ev.line, 7);
  assert.equal(userThread.comments.length, 1);
  assert.equal(live().length, 1); // le fil d'étape est toujours là
});

test('contrôleur : Stop prévient l’agent, ferme les fils et clôt le suivi ; dernière étape = fin', async () => {
  const s1 = setup();
  await walkthroughStartTool(s1.env, { mode: 'flow' });
  await walkthroughStepTool(s1.env, {
    title: 'A',
    text: 'a',
    path: 'a.rs',
    line: 2,
  });
  await s1.controller.sync();
  assert.equal(await s1.controller.stop(), true);
  assert.equal(s1.live().length, 0);
  assert.equal(s1.ended(), 1);
  assert.equal(readEvents(s1.root).at(-1)?.type, 'stop');
  assert.equal(s1.controller.active, false);
  // l'agent voit l'arrêt
  const got = await walkthroughWaitTool(s1.env, { timeout_s: 1 });
  assert.equal(got.status, 'ended');
  // une visite arrêtée ne ressuscite pas, même si walkthrough.json change encore
  await walkthroughStepTool(s1.env, {
    title: 'B',
    text: 'b',
    path: 'b.rs',
  }).catch(() => undefined);
  await s1.controller.sync();
  assert.equal(s1.live().length, 0);

  const s2 = setup();
  await walkthroughStartTool(s2.env, { mode: 'flow' });
  await walkthroughStepTool(s2.env, {
    title: 'A',
    text: 'a',
    path: 'a.rs',
    last: true,
  });
  await s2.controller.sync();
  await s2.controller.next(); // dernière étape + complete -> fin de visite
  assert.equal(readEvents(s2.root).at(-1)?.type, 'stop');
  assert.equal(s2.live().length, 0);
  assert.equal(readWalkthrough(s2.root)?.status, 'active'); // l'agent la clôt (walkthrough_end)
});

test('contrôleur : un échec d’ouverture n’empêche pas le fil (journalisé)', async () => {
  resetMock();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'se-walkctl-'));
  writeUiHeartbeat(root, new Date());
  const logs: string[] = [];
  const controller = new WalkthroughController(root, {
    showStep: async () => {
      throw new Error('boom');
    },
    endFollow: () => undefined,
    refresh: () => undefined,
    log: (m) => logs.push(m),
  });
  const env: ToolEnv = { root };
  await walkthroughStartTool(env, { mode: 'flow' });
  await walkthroughStepTool(env, {
    title: 'A',
    text: 'a',
    path: 'src/a.rs',
    line: 4,
  });
  await controller.sync();
  const threads = vscodeMock.comments.controllers[0].threads;
  assert.equal(threads.length, 1);
  assert.equal(threads[0].range.startLine, 2); // ligne 4 -> ancre ligne 3 (0-based 2)
  assert.ok(
    logs.some((l) => l.includes('ouverture impossible') && l.includes('boom')),
  );
});

test('contrôleur : la clé de contexte des raccourcis suit la visite', async () => {
  const { env, controller } = setup();
  const contexts = () =>
    executedCommands
      .filter(
        (c) => c[0] === 'setContext' && c[1] === 'smartExplorer.walkthrough',
      )
      .map((c) => c[2]);
  await controller.sync(); // pas de visite : rien d'actif
  assert.equal(contexts().at(-1), false);

  await walkthroughStartTool(env, { mode: 'flow' });
  await walkthroughStepTool(env, { title: 'A', text: 'a', path: 'a.rs' });
  await controller.sync();
  assert.equal(contexts().at(-1), true); // raccourcis actifs

  await controller.stop();
  assert.equal(contexts().at(-1), false); // visite finie : raccourcis retirés
});

test('contrôleur : Stop marche même si la visite n’est pas suivie par ce contrôleur', async () => {
  const { env, root, controller, ended } = setup();
  await walkthroughStartTool(env, { mode: 'flow' });
  await walkthroughStepTool(env, { title: 'A', text: 'a', path: 'a.rs' });
  // pas de sync() : le contrôleur ne connaît pas la visite (ex. synchro échouée)
  assert.equal(controller.active, false);
  assert.equal(await controller.stop(), true);
  assert.equal(readEvents(root).at(-1)?.type, 'stop');
  assert.equal(ended(), 1); // l'affichage de suivi est retiré quand même

  // rien à arrêter : pas d'erreur, l'affichage est tout de même nettoyé
  const empty = setup();
  assert.equal(await empty.controller.stop(), false);
  assert.equal(empty.ended(), 1);
});
