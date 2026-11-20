// Visite guidée dans VS Code : protocole de fichiers entre le serveur MCP (stdio,
// côté agent) et l'extension (côté éditeur). Module pur, sans dépendance à vscode.
//
//   walkthrough.json         écrit par le SERVEUR : plan, étapes (poussées une à
//                            une par l'agent), réponses de l'agent dans les fils
//   walkthrough-events.jsonl écrit par l'EXTENSION : commentaires de l'utilisateur,
//                            navigation (continuer/précédent), arrêt
//   ui.json                  signal de vie de l'extension (VS Code est-il ouvert ?)
//
// Deux fichiers, deux écrivains : aucun n'écrase le travail de l'autre.
import * as fs from 'fs';
import * as path from 'path';
import {
  DiffRequest,
  ensureProjectDir,
  projectDataDir,
} from '../core/workspaceStore';

export type WalkMode = 'flow' | 'changes' | 'review';

interface WalkStep {
  n: number;
  title: string;
  // Explication concise (markdown) affichée dans le fil de commentaire.
  text: string;
  path: string;
  line?: number;
  end_line?: number;
  match?: string;
  diff?: DiffRequest;
  at: string;
}

// Réponse de l'agent dans un fil (`step-<n>` ou `user-<seq>`).
interface WalkMessage {
  thread: string;
  text: string;
  at: string;
}

export interface WalkSession {
  id: string;
  mode: WalkMode;
  title?: string;
  workspace_id?: string;
  // Titres prévus (plan) : permet d'afficher « étape 2/6 » avant leur arrivée.
  outline: string[];
  steps: WalkStep[];
  // L'agent a poussé toutes les étapes.
  complete: boolean;
  messages: WalkMessage[];
  status: 'active' | 'ended';
  updated_at: string;
}

type WalkEventType = 'comment' | 'continue' | 'back' | 'stop';

export interface WalkEvent {
  seq: number;
  session: string;
  type: WalkEventType;
  // Étape courante au moment de l'événement.
  step: number;
  // Fil concerné par un commentaire.
  thread?: string;
  text?: string;
  // Où le commentaire a été posé (fil créé par l'utilisateur sur une ligne).
  path?: string;
  line?: number;
  at: string;
}

export function walkthroughFilePath(root: string): string {
  return path.join(projectDataDir(root), 'walkthrough.json');
}

export function eventsFilePath(root: string): string {
  return path.join(projectDataDir(root), 'walkthrough-events.jsonl');
}

function uiFilePath(root: string): string {
  return path.join(projectDataDir(root), 'ui.json');
}

export function readWalkthrough(root: string): WalkSession | undefined {
  try {
    const data = JSON.parse(fs.readFileSync(walkthroughFilePath(root), 'utf8'));
    return data && typeof data.id === 'string' ? data : undefined;
  } catch {
    return undefined;
  }
}

// Écriture atomique : l'extension ne lit jamais un fichier à moitié écrit.
export function writeWalkthrough(root: string, session: WalkSession): void {
  ensureProjectDir(root);
  const file = walkthroughFilePath(root);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(session));
  fs.renameSync(tmp, file);
}

export function resetEvents(root: string): void {
  ensureProjectDir(root);
  fs.writeFileSync(eventsFilePath(root), '');
}

export function readEvents(root: string, afterSeq = 0): WalkEvent[] {
  let raw = '';
  try {
    raw = fs.readFileSync(eventsFilePath(root), 'utf8');
  } catch {
    return [];
  }
  const events: WalkEvent[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    try {
      const ev = JSON.parse(line) as WalkEvent;
      if (ev.seq > afterSeq) {
        events.push(ev);
      }
    } catch {
      // ligne partielle (écriture en cours) : ignorée, relue au prochain tour
    }
  }
  return events;
}

// Ajoute un événement utilisateur (numéro de séquence croissant).
export function appendEvent(
  root: string,
  event: Omit<WalkEvent, 'seq' | 'at'>,
  now: Date = new Date(),
): WalkEvent {
  ensureProjectDir(root);
  const all = readEvents(root);
  const seq = (all[all.length - 1]?.seq ?? 0) + 1;
  const full: WalkEvent = { ...event, seq, at: now.toISOString() };
  fs.appendFileSync(eventsFilePath(root), JSON.stringify(full) + '\n');
  return full;
}

// --- Fils de commentaire -----------------------------------------------------

export const stepThread = (n: number) => `step-${n}`;

export interface ThreadMessage {
  author: 'agent' | 'user';
  text: string;
  at: string;
}

// Messages d'un fil, dans l'ordre : explication de l'étape (pour `step-n`),
// puis réponses de l'agent et commentaires de l'utilisateur triés par date.
export function threadMessages(
  session: WalkSession,
  events: WalkEvent[],
  thread: string,
): ThreadMessage[] {
  const out: ThreadMessage[] = [];
  const m = thread.match(/^step-(\d+)$/);
  if (m) {
    const step = session.steps.find((s) => s.n === Number(m[1]));
    if (step) {
      out.push({ author: 'agent', text: step.text, at: step.at });
    }
  }
  const rest: ThreadMessage[] = [
    ...session.messages
      .filter((x) => x.thread === thread)
      .map((x) => ({ author: 'agent' as const, text: x.text, at: x.at })),
    ...events
      .filter(
        (e) =>
          e.type === 'comment' &&
          e.session === session.id &&
          e.thread === thread &&
          e.text,
      )
      .map((e) => ({ author: 'user' as const, text: e.text ?? '', at: e.at })),
  ];
  rest.sort((a, b) => a.at.localeCompare(b.at));
  return [...out, ...rest];
}

// Avancement : étapes prêtes / total prévu (plan, sinon nombre d'étapes reçues).
export function walkProgress(session: WalkSession): {
  ready: number;
  total: number;
  generating: boolean;
} {
  const ready = session.steps.length;
  const total = session.complete
    ? ready
    : Math.max(ready, session.outline.length);
  return { ready, total, generating: !session.complete };
}

// --- Signal de vie de l'extension ---------------------------------------------

// VS Code est ouvert sur ce projet tant que l'extension rafraîchit ce fichier.
export const UI_ALIVE_MS = 60_000;

// Où se déroule la visite : « vscode » = tout dans l'éditeur (fils de
// commentaire) ; « cli » = VS Code ne fait que le focus/la sélection, les
// explications et le « continuer / question » passent par le terminal.
export type WalkDisplay = 'vscode' | 'cli';

export function writeUiHeartbeat(
  root: string,
  now: Date = new Date(),
  display: WalkDisplay = 'vscode',
): void {
  ensureProjectDir(root);
  fs.writeFileSync(
    uiFilePath(root),
    JSON.stringify({ at: now.toISOString(), display }),
  );
}

export function readUiDisplay(root: string): WalkDisplay {
  try {
    const { display } = JSON.parse(fs.readFileSync(uiFilePath(root), 'utf8'));
    return display === 'cli' ? 'cli' : 'vscode';
  } catch {
    return 'vscode';
  }
}

export function isUiAlive(root: string, now: Date = new Date()): boolean {
  try {
    const { at } = JSON.parse(fs.readFileSync(uiFilePath(root), 'utf8'));
    return now.getTime() - Date.parse(at) <= UI_ALIVE_MS;
  } catch {
    return false;
  }
}

// Une visite sans aucune écriture du serveur depuis ce délai (agent disparu :
// Échap dans le terminal, fenêtre fermée…) est considérée terminée. Le serveur
// rafraîchit `updated_at` pendant walkthrough_wait.
export const WALK_STALE_MS = 45 * 60 * 1000;

// La visite est-elle vraiment en cours ? Pas terminée, pas périmée, et pas
// arrêtée par l'utilisateur (événement stop) même si l'agent ne l'a pas encore
// traité : l'interface ne dépend jamais du bon vouloir de l'agent pour s'arrêter.
export function isLiveSession(
  root: string,
  session: WalkSession,
  now: Date = new Date(),
): boolean {
  if (session.status !== 'active') {
    return false;
  }
  if (now.getTime() - Date.parse(session.updated_at) > WALK_STALE_MS) {
    return false;
  }
  return !readEvents(root).some(
    (e) => e.session === session.id && e.type === 'stop',
  );
}
