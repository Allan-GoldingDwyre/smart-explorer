// Visite guidée dans VS Code, façon Copilot : un fil de commentaire par étape,
// ancré juste au-dessus de la ligne mise en avant ; l'utilisateur répond dans
// le fil (l'agent lui répond dans le même fil) et navigue avec Continuer /
// Précédent / Stop. Les étapes arrivent au fil de l'eau (l'agent les pousse
// pendant que l'utilisateur lit la première). Le protocole de fichiers vit dans
// walkthrough.ts ; ici : seulement l'interface VS Code.
import * as path from 'path';
import * as vscode from 'vscode';
import {
  ThreadMessage,
  WalkEvent,
  WalkSession,
  appendEvent,
  isLiveSession,
  readEvents,
  readWalkthrough,
  stepThread,
  threadMessages,
  walkProgress,
} from './walkthrough';
import { FocusRequest } from './workspaceStore';

export interface WalkthroughHooks {
  // Ouvre le fichier/diff de l'étape (surlignage, sélection dans l'arbre) et
  // retourne l'ancre du fil : le document et la ligne (1-based) mise en avant.
  showStep(
    focus: FocusRequest,
  ): Promise<{ uri: vscode.Uri; line: number } | undefined>;
  // La visite se termine côté éditeur : retire « Following agent » et le surlignage.
  endFollow(): void | Promise<void>;
  // Rafraîchit le panneau (avancement de la visite).
  refresh(): void;
  // Journal de l'extension.
  log(message: string): void;
}

const AGENT_NAME = 'Smart Explorer';
const USER_NAME = 'Vous';

export class WalkthroughController implements vscode.Disposable {
  private readonly controller: vscode.CommentController;
  private readonly threads = new Map<string, vscode.CommentThread>();
  private readonly ids = new WeakMap<vscode.CommentThread, string>();
  // Visites arrêtées par l'utilisateur : leurs étapes ne ressuscitent pas.
  private readonly stopped = new Set<string>();
  private sessionId?: string;
  private current = 0;
  // Étape demandée par « Continuer » mais pas encore générée par l'agent.
  private waitingFor?: number;
  // Dernière valeur de la clé de contexte « smartExplorer.walkthrough » (raccourcis).
  private contextOn?: boolean;

  constructor(
    private readonly root: string,
    private readonly hooks: WalkthroughHooks,
  ) {
    this.controller = vscode.comments.createCommentController(
      'smartExplorer',
      'Smart Explorer',
    );
    this.controller.options = {
      placeHolder: "Pose une question à l'agent…",
      prompt: 'Répondre',
    };
    // L'utilisateur peut aussi poser une question sur n'importe quelle ligne
    // pendant une visite (bouton + dans la marge).
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: (doc) =>
        this.sessionId &&
        (doc.uri.scheme === 'file' || doc.uri.scheme === 'smart-explorer-diff')
          ? [new vscode.Range(0, 0, Math.max(doc.lineCount - 1, 0), 0)]
          : [],
    };
  }

  // Diagnostic : un fil de test sur la ligne courante de l'éditeur actif, pour
  // vérifier que l'API Comments s'affiche dans cette fenêtre.
  testThread(): string {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return 'aucun éditeur actif';
    }
    const line = editor.selection.active.line;
    const thread = this.controller.createCommentThread(
      editor.document.uri,
      new vscode.Range(line, 0, line, 1),
      [
        {
          body: new vscode.MarkdownString('Fil de test **Smart Explorer**.'),
          mode: vscode.CommentMode.Preview,
          author: { name: AGENT_NAME },
        },
      ],
    );
    thread.canReply = true;
    thread.label = 'Test';
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    this.register(`test-${Date.now()}`, thread);
    return `fil de test créé sur ${editor.document.uri.toString()} ligne ${
      line + 1
    }`;
  }

  get active(): boolean {
    return !!this.sessionId;
  }

  // Relit la visite (walkthrough.json a changé) : affiche la première étape dès
  // son arrivée, la suivante si l'utilisateur l'attendait, et met à jour les
  // réponses de l'agent dans les fils.
  async sync(): Promise<void> {
    const session = readWalkthrough(this.root);
    this.hooks.log(
      `sync : visite ${session?.id ?? 'aucune'} (${session?.status ?? '-'}), ${
        session?.steps.length ?? 0
      } étape(s), courante ${this.current}`,
    );
    if (
      !session ||
      !isLiveSession(this.root, session) ||
      this.stopped.has(session.id)
    ) {
      this.clear();
      this.hooks.refresh();
      return;
    }
    if (session.id !== this.sessionId) {
      this.clear();
      this.sessionId = session.id;
    }
    this.setContext(true);
    const events = this.eventsOf(session);
    if (this.current === 0 && session.steps.length > 0) {
      // Première étape (ou reprise après rechargement de la fenêtre).
      const last = events[events.length - 1]?.step ?? 1;
      await this.goTo(
        Math.min(Math.max(last, 1), session.steps.length),
        session,
      );
    } else if (this.waitingFor && session.steps.length >= this.waitingFor) {
      const n = this.waitingFor;
      this.waitingFor = undefined;
      await this.goTo(n, session);
    } else {
      this.render(session, events);
    }
    this.hooks.refresh();
  }

  private eventsOf(session: WalkSession): WalkEvent[] {
    return readEvents(this.root).filter((e) => e.session === session.id);
  }

  private async goTo(n: number, session: WalkSession): Promise<void> {
    const step = session.steps[n - 1];
    if (!step) {
      return;
    }
    this.current = n;
    let anchor: { uri: vscode.Uri; line: number } | undefined;
    try {
      anchor = await this.hooks.showStep({
        path: step.path,
        line: step.line,
        end_line: step.end_line,
        match: step.match,
        diff: step.diff,
        workspace_id: session.workspace_id,
        at: step.at,
      });
    } catch (e) {
      this.hooks.log(
        `étape ${n} : ouverture impossible (${
          e instanceof Error ? e.message : e
        })`,
      );
    }
    // Même si l'ouverture a échoué, le fil s'affiche (sur le fichier de l'étape).
    anchor ??= {
      uri: vscode.Uri.file(path.join(this.root, step.path)),
      line: step.line ?? 1,
    };
    // L'ancien fil d'étape disparaît (l'historique reste dans les fichiers).
    for (const [id, thread] of [...this.threads]) {
      if (id.startsWith('step-')) {
        thread.dispose();
        this.threads.delete(id);
      }
    }
    {
      // Un fil s'affiche SOUS sa ligne : ancré sur la ligne précédente, il
      // apparaît juste au-dessus de la ligne mise en avant.
      const above = Math.max(anchor.line - 2, 0);
      // Le fil est créé AVEC son premier commentaire (créé vide puis rempli, il
      // peut ne jamais s'afficher) et sur une plage non vide.
      const initial = threadMessages(
        session,
        this.eventsOf(session),
        stepThread(n),
      ).map((m) => this.toComment(m));
      const thread = this.controller.createCommentThread(
        anchor.uri,
        new vscode.Range(above, 0, above, 1),
        initial,
      );
      thread.canReply = true;
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
      thread.contextValue = 'smartExplorer.step';
      this.register(stepThread(n), thread);
      this.hooks.log(
        `fil créé : étape ${n} sur ${anchor.uri.toString()} (ligne ${
          anchor.line
        }), ${initial.length} commentaire(s), éditeurs visibles : ${
          vscode.window.visibleTextEditors
            .map((e) => e.document.uri.toString())
            .join(', ') || 'aucun'
        }`,
      );
    }
    this.render(session, this.eventsOf(session));
  }

  private register(id: string, thread: vscode.CommentThread): void {
    this.threads.set(id, thread);
    this.ids.set(thread, id);
  }

  private toComment(m: ThreadMessage): vscode.Comment {
    const body = new vscode.MarkdownString(m.text);
    return {
      body,
      mode: vscode.CommentMode.Preview,
      author: { name: m.author === 'agent' ? AGENT_NAME : USER_NAME },
      timestamp: new Date(m.at),
    };
  }

  // Met à jour le contenu et le titre de tous les fils suivis.
  private render(session: WalkSession, events: WalkEvent[]): void {
    const progress = walkProgress(session);
    for (const [id, thread] of this.threads) {
      const comments = threadMessages(session, events, id).map((m) =>
        this.toComment(m),
      );
      if (id === stepThread(this.current) && this.waitingFor) {
        comments.push({
          body: new vscode.MarkdownString(
            `⏳ _Génération de l'étape ${this.waitingFor}…_`,
          ),
          mode: vscode.CommentMode.Preview,
          author: { name: AGENT_NAME },
        });
      }
      thread.comments = comments;
      const step = id.startsWith('step-')
        ? session.steps[Number(id.slice(5)) - 1]
        : undefined;
      thread.label = step
        ? `Étape ${step.n}/${progress.total}${
            progress.generating ? ' …' : ''
          } — ${step.title}`
        : 'Question';
    }
  }

  // --- Actions de l'utilisateur ------------------------------------------------

  // Bouton Continuer : étape suivante si elle est arrivée, sinon on l'attend ;
  // sur la dernière étape, la visite est terminée.
  async next(): Promise<void> {
    const session = this.session();
    if (!session) {
      return;
    }
    if (this.current < session.steps.length) {
      appendEvent(this.root, {
        session: session.id,
        type: 'continue',
        step: this.current + 1,
      });
      await this.goTo(this.current + 1, session);
    } else if (session.complete) {
      appendEvent(this.root, {
        session: session.id,
        type: 'stop',
        step: this.current,
        text: 'visite terminée',
      });
      this.stopped.add(session.id);
      this.clear();
      await this.hooks.endFollow();
      void vscode.window.showInformationMessage(
        'Smart Explorer : visite terminée.',
      );
    } else {
      // L'agent génère encore la suite : on l'affichera dès son arrivée.
      this.waitingFor = this.current + 1;
      appendEvent(this.root, {
        session: session.id,
        type: 'continue',
        step: this.current,
      });
      this.render(session, this.eventsOf(session));
    }
    this.hooks.refresh();
  }

  async back(): Promise<void> {
    const session = this.session();
    if (!session || this.current <= 1) {
      return;
    }
    this.waitingFor = undefined;
    appendEvent(this.root, {
      session: session.id,
      type: 'back',
      step: this.current - 1,
    });
    await this.goTo(this.current - 1, session);
    this.hooks.refresh();
  }

  // Stop (bouton du fil, ligne « Following agent », CodeLens) : l'agent est
  // prévenu (événement stop), les fils disparaissent. Retourne true s'il y
  // avait une visite.
  async stop(): Promise<boolean> {
    // On lit la visite sur disque : l'arrêt marche même si ce contrôleur ne la
    // suivait pas (fenêtre rechargée, synchronisation échouée…).
    const session = readWalkthrough(this.root);
    const live = !!session && isLiveSession(this.root, session);
    if (session && live) {
      appendEvent(this.root, {
        session: session.id,
        type: 'stop',
        step: this.current,
        text: "arrêtée par l'utilisateur",
      });
      this.stopped.add(session.id);
    }
    this.clear();
    await this.hooks.endFollow();
    this.hooks.refresh();
    return live;
  }

  // Revient à l'étape courante (clic sur « Following agent » / CodeLens).
  async revisit(): Promise<boolean> {
    const session = this.session();
    if (!session || this.current === 0) {
      return false;
    }
    await this.goTo(this.current, session);
    return true;
  }

  // Un commentaire de l'utilisateur dans un fil (réponse ou nouvelle question
  // posée sur une ligne) : écrit pour l'agent, affiché tout de suite.
  async reply(reply: vscode.CommentReply): Promise<void> {
    const session = this.session();
    const text = reply.text.trim();
    if (!session || !text) {
      return;
    }
    let id = this.ids.get(reply.thread);
    let where: { path?: string; line?: number } = {};
    if (!id) {
      // Fil créé par l'utilisateur sur une ligne : nouveau fil de question.
      const seq = (readEvents(this.root).at(-1)?.seq ?? 0) + 1;
      id = `user-${seq}`;
      this.register(id, reply.thread);
      reply.thread.canReply = true;
      reply.thread.contextValue = 'smartExplorer.question';
      const rel = vscode.workspace.asRelativePath(reply.thread.uri, false);
      where = { path: rel, line: (reply.thread.range?.start.line ?? 0) + 1 };
    }
    appendEvent(this.root, {
      session: session.id,
      type: 'comment',
      step: this.current,
      thread: id,
      text,
      ...where,
    });
    this.render(session, this.eventsOf(session));
  }

  private session(): WalkSession | undefined {
    const session = readWalkthrough(this.root);
    return session &&
      isLiveSession(this.root, session) &&
      session.id === this.sessionId &&
      !this.stopped.has(session.id)
      ? session
      : undefined;
  }

  // Clé de contexte pour les raccourcis clavier : vraie tant qu'une visite est
  // en cours (les raccourcis n'existent pas en dehors).
  private setContext(on: boolean): void {
    if (this.contextOn !== on) {
      this.contextOn = on;
      void vscode.commands.executeCommand(
        'setContext',
        'smartExplorer.walkthrough',
        on,
      );
    }
  }

  private clear(): void {
    for (const thread of this.threads.values()) {
      thread.dispose();
    }
    this.threads.clear();
    this.sessionId = undefined;
    this.current = 0;
    this.waitingFor = undefined;
    this.setContext(false);
  }

  dispose(): void {
    this.clear();
    this.controller.dispose();
  }
}
