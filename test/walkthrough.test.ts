import './test-home';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ToolEnv,
  createWorkspaceTool,
  stopFollowingTool,
  walkthroughEndTool,
  walkthroughReplyTool,
  walkthroughStartTool,
  walkthroughStepTool,
  walkthroughWaitTool,
} from '../src/mcp/mcpTools';
import {
  UI_ALIVE_MS,
  WALK_STALE_MS,
  isLiveSession,
  appendEvent,
  eventsFilePath,
  isUiAlive,
  readEvents,
  readWalkthrough,
  threadMessages,
  walkProgress,
  writeUiHeartbeat,
} from '../src/walkthrough/walkthrough';
import { readFollow } from '../src/core/workspaceStore';

const NOW = new Date('2026-11-20T10:00:00Z');

function makeRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'smart-explorer-walk-'));
}

function makeEnv(root: string): ToolEnv {
  return { root, now: () => NOW, sleep: async () => undefined };
}

// Projet avec VS Code « ouvert » (signal de vie de l'extension).
function openRoot(): { root: string; env: ToolEnv } {
  const root = makeRoot();
  writeUiHeartbeat(root, NOW);
  return { root, env: makeEnv(root) };
}

test('signal de vie : VS Code est considéré ouvert pendant 60 s', () => {
  const root = makeRoot();
  assert.equal(isUiAlive(root, NOW), false);
  writeUiHeartbeat(root, NOW);
  assert.equal(isUiAlive(root, NOW), true);
  assert.equal(
    isUiAlive(root, new Date(NOW.getTime() + UI_ALIVE_MS + 1000)),
    false,
  );
});

test('walkthrough_start : sans VS Code ouvert, ui:false et aucune visite créée', async () => {
  const root = makeRoot();
  const res = await walkthroughStartTool(makeEnv(root), { mode: 'changes' });
  assert.equal(res.ok, false);
  assert.equal(res.ui, false);
  assert.match(res.note ?? '', /terminal/);
  assert.equal(readWalkthrough(root), undefined);
});

test('walkthrough_start / step / end : étapes poussées une à une, plan et avancement', async () => {
  const { root, env } = openRoot();
  const start = await walkthroughStartTool(env, {
    mode: 'changes',
    title: 'PR 326',
    outline: ['Dépendances', ' ', 'Serde', 'Tests'],
  });
  assert.equal(start.ok, true);
  assert.equal(start.ui, true);
  assert.equal(readWalkthrough(root)?.outline.length, 3); // titres vides ignorés
  assert.deepEqual(walkProgress(readWalkthrough(root)!), {
    ready: 0,
    total: 3,
    generating: true,
  });

  const s1 = await walkthroughStepTool(env, {
    title: 'Dépendances',
    text: 'chrono retiré, jiff ajouté.',
    path: './Cargo.toml',
    line: 39,
  });
  assert.equal(s1.n, 1);
  assert.deepEqual(s1.pending_comments, []);
  const s2 = await walkthroughStepTool(env, {
    title: 'Serde',
    text: 'Module sur mesure.',
    path: 'src/a.rs',
    line: 10,
    end_line: 500, // plage énorme : plafonnée par le garde-fou
  });
  assert.equal(s2.n, 2);
  assert.match(s2.notes?.join(' ') ?? '', /plafonnée/);
  let session = readWalkthrough(root)!;
  assert.equal(session.steps[0].path, 'Cargo.toml'); // ./ retiré
  assert.equal(session.steps[1].end_line, 10 + 25 - 1);
  assert.deepEqual(walkProgress(session), {
    ready: 2,
    total: 3,
    generating: true,
  });

  await walkthroughStepTool(env, {
    title: 'Tests',
    text: 'Tests adaptés.',
    path: 'tests/a.rs',
    last: true,
  });
  session = readWalkthrough(root)!;
  assert.equal(session.complete, true);
  assert.deepEqual(walkProgress(session), {
    ready: 3,
    total: 3,
    generating: false,
  });

  assert.equal((await walkthroughEndTool(env)).was, 'active');
  assert.equal(readWalkthrough(root)?.status, 'ended');
  assert.equal(readFollow(root, NOW)?.status, 'ended');
  await assert.rejects(
    () => walkthroughStepTool(env, { title: 't', text: 'x', path: 'a' }),
    /aucune visite en cours/,
  );
});

test('walkthrough_step : champs requis', async () => {
  const { env } = openRoot();
  await walkthroughStartTool(env, { mode: 'flow' });
  await assert.rejects(
    () => walkthroughStepTool(env, { title: 'a', text: ' ', path: 'x' }),
    /title et text/,
  );
  await assert.rejects(
    () => walkthroughStepTool(env, { title: 'a', text: 'b', path: '' }),
    /path requis/,
  );
});

test('commentaires : pending_comments, reply dans le fil, messages ordonnés', async () => {
  const { root, env } = openRoot();
  const { session } = await walkthroughStartTool(env, { mode: 'review' });
  assert.ok(session);
  await walkthroughStepTool(env, {
    title: 'A',
    text: 'Explication A.',
    path: 'a.rs',
    line: 3,
  });

  // l'utilisateur écrit dans le fil de l'étape 1 (côté extension)
  const t1 = new Date('2026-11-20T10:01:00Z');
  appendEvent(
    root,
    {
      session,
      type: 'comment',
      step: 1,
      thread: 'step-1',
      text: 'Pourquoi un Option ?',
    },
    t1,
  );
  // l'agent, en train de générer l'étape suivante, voit le commentaire en attente
  const s2 = await walkthroughStepTool(env, {
    title: 'B',
    text: 'Explication B.',
    path: 'b.rs',
  });
  assert.equal(s2.pending_comments.length, 1);
  assert.equal(s2.pending_comments[0].thread, 'step-1');
  assert.equal(s2.pending_comments[0].text, 'Pourquoi un Option ?');

  await assert.rejects(
    () => walkthroughReplyTool(env, { thread: 'nimporte', text: 'x' }),
    /thread invalide/,
  );
  await assert.rejects(
    () => walkthroughReplyTool(env, { thread: 'step-1', text: ' ' }),
    /text requis/,
  );
  // la réponse de l'agent est postérieure au commentaire de l'utilisateur
  const later = { ...env, now: () => new Date('2026-11-20T10:02:00Z') };
  await walkthroughReplyTool(later, {
    thread: 'step-1',
    text: 'Car le champ est facultatif.',
  });

  const msgs = threadMessages(
    readWalkthrough(root)!,
    readEvents(root),
    'step-1',
  );
  assert.deepEqual(
    msgs.map((m) => [m.author, m.text]),
    [
      ['agent', 'Explication A.'],
      ['user', 'Pourquoi un Option ?'],
      ['agent', 'Car le champ est facultatif.'],
    ],
  );
  // un autre fil ne contient que son explication
  assert.deepEqual(
    threadMessages(readWalkthrough(root)!, readEvents(root), 'step-2').map(
      (m) => m.text,
    ),
    ['Explication B.'],
  );
});

test('walkthrough_wait : rend les commentaires, ignore la navigation, consomme une seule fois', async () => {
  const { root, env } = openRoot();
  const { session } = await walkthroughStartTool(env, { mode: 'flow' });
  assert.ok(session);
  await walkthroughStepTool(env, { title: 'A', text: 'a', path: 'a.rs' });

  // navigation seule (continuer/précédent) : ne réveille pas l'agent
  appendEvent(root, { session, type: 'continue', step: 2 }, NOW);
  appendEvent(root, { session, type: 'back', step: 1 }, NOW);
  const idle = await walkthroughWaitTool(env, { timeout_s: 1 });
  assert.equal(idle.idle, true);
  assert.deepEqual(idle.events, []);
  assert.equal(idle.current_step, 1); // l'étape courante de l'utilisateur est connue
  assert.equal(idle.steps_ready, 1);

  // un commentaire réveille l'agent
  appendEvent(
    root,
    {
      session,
      type: 'comment',
      step: 1,
      thread: 'step-1',
      text: 'Et si c’est vide ?',
    },
    NOW,
  );
  const got = await walkthroughWaitTool(env, { timeout_s: 5 });
  assert.equal(got.status, 'active');
  assert.equal(got.idle, undefined);
  assert.equal(got.events.length, 1);
  assert.equal(got.events[0].text, 'Et si c’est vide ?');

  // consommé : le prochain wait ne le rend plus
  assert.equal((await walkthroughWaitTool(env, { timeout_s: 1 })).idle, true);

  // l'utilisateur arrête : status ended, visite terminée
  appendEvent(root, { session, type: 'stop', step: 1 }, NOW);
  const stopped = await walkthroughWaitTool(env, { timeout_s: 5 });
  assert.equal(stopped.status, 'ended');
  assert.equal(stopped.events[0].type, 'stop');
  assert.equal(readWalkthrough(root)?.status, 'ended');
});

test('walkthrough_wait : un commentaire posé pendant l’attente est vu au tour suivant', async () => {
  const { root, env } = openRoot();
  const { session } = await walkthroughStartTool(env, { mode: 'flow' });
  assert.ok(session);
  let calls = 0;
  env.sleep = async () => {
    calls++;
    if (calls === 2) {
      appendEvent(
        root,
        {
          session,
          type: 'comment',
          step: 1,
          thread: 'user-1',
          text: 'Question',
          path: 'x.rs',
          line: 4,
        },
        NOW,
      );
    }
  };
  const res = await walkthroughWaitTool(env, { timeout_s: 30 });
  assert.equal(res.events.length, 1);
  assert.equal(res.events[0].thread, 'user-1');
  assert.equal(res.events[0].path, 'x.rs');
  assert.equal(res.events[0].line, 4);
  assert.ok(calls >= 2 && calls < 10);
});

test('events : numéros de séquence croissants, lignes partielles ignorées', () => {
  const root = makeRoot();
  const a = appendEvent(root, { session: 's', type: 'continue', step: 2 }, NOW);
  const b = appendEvent(root, { session: 's', type: 'continue', step: 3 }, NOW);
  assert.deepEqual([a.seq, b.seq], [1, 2]);
  fs.appendFileSync(eventsFilePath(root), '{"seq":3,"sess'); // écriture en cours
  assert.equal(readEvents(root).length, 2);
  assert.deepEqual(
    readEvents(root, 1).map((e) => e.seq),
    [2],
  );
});

test('stop_following termine aussi la visite en cours', async () => {
  const { root, env } = openRoot();
  await createWorkspaceTool(env, { source: 'txt' });
  await walkthroughStartTool(env, { mode: 'flow' });
  await stopFollowingTool(env);
  assert.equal(readWalkthrough(root)?.status, 'ended');
});

test('walkthrough_wait : visite terminée -> status ended sans bloquer', async () => {
  const { env } = openRoot();
  await walkthroughStartTool(env, { mode: 'flow' });
  await walkthroughEndTool(env);
  const res = await walkthroughWaitTool(env, { timeout_s: 30 });
  assert.equal(res.status, 'ended');
  assert.equal(res.idle, undefined);
});

test('arrêt par l’utilisateur pendant la génération : step et reply le signalent', async () => {
  const { root, env } = openRoot();
  const { session } = await walkthroughStartTool(env, { mode: 'flow' });
  assert.ok(session);
  await walkthroughStepTool(env, { title: 'A', text: 'a', path: 'a.rs' });
  appendEvent(root, { session, type: 'stop', step: 1, text: 'arrêtée' }, NOW);
  const next = await walkthroughStepTool(env, {
    title: 'B',
    text: 'b',
    path: 'b.rs',
  });
  assert.equal(next.stopped, true);
  assert.match(next.note ?? '', /walkthrough_end/);
  const rep = await walkthroughReplyTool(env, { thread: 'step-1', text: 'ok' });
  assert.equal(rep.stopped, true);
  // le wait rend l'arrêt puis la visite est terminée
  const got = await walkthroughWaitTool(env, { timeout_s: 1 });
  assert.equal(got.status, 'ended');
});

test('isLiveSession : active, ni périmée ni arrêtée par l’utilisateur', async () => {
  const { root, env } = openRoot();
  const { session } = await walkthroughStartTool(env, { mode: 'flow' });
  assert.ok(session);
  const s = readWalkthrough(root)!;
  assert.equal(isLiveSession(root, s, NOW), true);
  // périmée : l'agent a disparu (aucune écriture depuis 45 min)
  const later = new Date(NOW.getTime() + WALK_STALE_MS + 1000);
  assert.equal(isLiveSession(root, s, later), false);
  // terminée
  assert.equal(isLiveSession(root, { ...s, status: 'ended' }, NOW), false);
  // arrêtée par l'utilisateur : n'attend pas que l'agent traite l'événement
  appendEvent(root, { session, type: 'stop', step: 1 }, NOW);
  assert.equal(isLiveSession(root, s, NOW), false);
  // le stop d'une AUTRE visite ne compte pas
  const other = { ...s, id: 'wt-autre' };
  assert.equal(isLiveSession(root, other, NOW), true);
});

test('walkthrough_wait : prouve que l’agent est vivant en rafraîchissant updated_at', async () => {
  const { root } = openRoot();
  let tick = 0;
  const env: ToolEnv = {
    root,
    // horloge qui avance à chaque lecture : chaque écriture a un horodatage différent
    now: () => new Date(NOW.getTime() + tick++ * 1000),
    sleep: async () => undefined,
  };
  await walkthroughStartTool(env, { mode: 'flow' });
  const before = readWalkthrough(root)!.updated_at;
  await walkthroughWaitTool(env, { timeout_s: 200 }); // plusieurs minutes simulées
  assert.notEqual(readWalkthrough(root)!.updated_at, before);
});

test('walkthrough_start : réglage display=cli → pas de session, VS Code sert au focus', async () => {
  const root = makeRoot();
  writeUiHeartbeat(root, NOW, 'cli');
  const res = await walkthroughStartTool(makeEnv(root), { mode: 'changes' });
  assert.equal(res.ok, true);
  assert.equal(res.ui, false);
  assert.equal(res.display, 'cli');
  assert.equal(readWalkthrough(root), undefined);
});
