import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  MarkRange,
  computeMarkRange,
  diffLineFor,
  workspaceForFile,
} from './core/focus';
import { registerMcpServer } from './mcp/mcpServer';
import {
  FOLLOWING_URI_SCHEME,
  SmartExplorerNode,
} from './view/SmartExplorerNode';
import { SmartExplorerProvider } from './view/SmartExplorerProvider';
import { WalkthroughController } from './walkthrough/walkthroughController';
import {
  walkthroughFilePath,
  writeUiHeartbeat,
} from './walkthrough/walkthrough';
import {
  DiffRequest,
  FOLLOW_IDLE_MS,
  FocusRequest,
  gitDiffText,
  gitShow,
  listOrphanProjects,
  migrateLegacyStore,
  projectDataDir,
  readFollow,
  removeProjectData,
  workspacesDir,
  writeActive,
  writeFollow,
} from './core/workspaceStore';

export function activate(context: vscode.ExtensionContext) {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (root) {
    // Anciennes données (dans le projet) -> dossier de données utilisateur.
    try {
      migrateLegacyStore(root);
    } catch {
      // migration best-effort : le store reste utilisable
    }
  }

  // Deux vues : le workspace actif (haut) et les autres, repliés (bas).
  const provider = new SmartExplorerProvider('main');
  const othersProvider = new SmartExplorerProvider('others');
  const treeView = vscode.window.createTreeView('smartExplorerView', {
    treeDataProvider: provider,
    showCollapseAll: true,
  });
  const othersView = vscode.window.createTreeView('smartExplorerOthers', {
    treeDataProvider: othersProvider,
  });

  // Serveur MCP déclaré à VS Code (lancé par VS Code, exposé au chat). Les
  // clients écrivent les YAML ; l'extension re-render via le watcher.
  registerMcpServer(context);

  const reload = () => {
    for (const p of [provider, othersProvider]) {
      p.reloadFromDisk();
      p.refresh();
    }
    void vscode.commands.executeCommand(
      'setContext',
      'smartExplorer.hasOthers',
      othersProvider.othersCount() > 0,
    );
    // Vraie tant que « Following agent » est affiché : bouton/raccourci Stop.
    void vscode.commands.executeCommand(
      'setContext',
      'smartExplorer.following',
      provider.isFollowing(),
    );
  };
  reload();

  // Journal de l'extension (Sortie -> « Smart Explorer ») : rend visibles les
  // échecs de la visite guidée et du suivi.
  const out = vscode.window.createOutputChannel('Smart Explorer');
  // ... et dans <dossier de données>/extension.log (lisible sans ouvrir VS Code).
  const logFile = root ? path.join(projectDataDir(root), 'extension.log') : '';
  if (logFile) {
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      if (fs.existsSync(logFile) && fs.statSync(logFile).size > 400_000) {
        fs.writeFileSync(logFile, '');
      }
    } catch {
      // journal best-effort
    }
  }
  const log = (message: string) => {
    const line = `[${new Date().toISOString()}] ${message}`;
    out.appendLine(line);
    if (logFile) {
      try {
        fs.appendFileSync(logFile, line + '\n');
      } catch {
        // journal best-effort
      }
    }
  };
  log(`API Comments : ${typeof vscode.comments?.createCommentController}`);
  log(
    `activation (version ${context.extension.packageJSON.version}, projet ${
      root ?? 'aucun'
    })`,
  );
  const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

  // --- Suivi de l'agent (à la Live Share) et de l'éditeur ---

  // Diff UNIFIÉ en une seule vue (pas de côte à côte) : document virtuel
  // smart-explorer-diff:/<chemin>.diff?{root,path,from,to,from_path}
  const DIFF_SCHEME = 'smart-explorer-diff';
  const diffUri = (gitRoot: string, relPath: string, diff: DiffRequest) =>
    vscode.Uri.from({
      scheme: DIFF_SCHEME,
      path: `/${relPath}.diff`,
      query: JSON.stringify({ root: gitRoot, path: relPath, ...diff }),
    });

  // Ce que l'agent met en avant, dans un document (fichier ou diff). `line` :
  // ancre du CodeLens ; `range` : zone surlignée (absente = fichier entier).
  interface AgentMark {
    uri: string;
    line: number;
    range?: MarkRange;
  }
  let agentMark: AgentMark | undefined;
  // Fichier du projet de la visite en cours : décoré en orange dans l'arbre
  // (indépendant du fichier sélectionné).
  let agentFileUri: string | undefined;
  const lensChanged = new vscode.EventEmitter<void>();
  const decorationsChanged = new vscode.EventEmitter<undefined>();
  const markColor = new vscode.ThemeColor(
    'smartExplorer.agentHighlightBackground',
  );
  const highlightLines = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: markColor,
    overviewRulerColor: markColor,
    overviewRulerLane: vscode.OverviewRulerLane.Right,
  });
  const highlightInline = vscode.window.createTextEditorDecorationType({
    backgroundColor: markColor,
    borderRadius: '2px',
    overviewRulerColor: markColor,
    overviewRulerLane: vscode.OverviewRulerLane.Right,
  });
  const paintHighlight = () => {
    for (const editor of vscode.window.visibleTextEditors) {
      const range =
        agentMark && editor.document.uri.toString() === agentMark.uri
          ? agentMark.range
          : undefined;
      editor.setDecorations(
        highlightLines,
        range && range.startCol === undefined
          ? [new vscode.Range(range.startLine - 1, 0, range.endLine - 1, 0)]
          : [],
      );
      editor.setDecorations(
        highlightInline,
        range && range.startCol !== undefined && range.endCol !== undefined
          ? [
              new vscode.Range(
                range.startLine - 1,
                range.startCol,
                range.endLine - 1,
                range.endCol,
              ),
            ]
          : [],
      );
    }
    lensChanged.fire();
  };
  const setAgentMark = (mark?: AgentMark, fileUri?: string) => {
    agentMark = mark;
    agentFileUri = fileUri;
    paintHighlight();
    decorationsChanged.fire(undefined);
  };

  // Décorations orange : la ligne « Following agent » du panneau (texte) et le
  // fichier de la visite dans l'arbre (texte + pastille).
  const decorations: vscode.FileDecorationProvider = {
    onDidChangeFileDecorations: decorationsChanged.event,
    provideFileDecoration: (uri) => {
      const color = new vscode.ThemeColor('smartExplorer.agentActive');
      if (uri.scheme === FOLLOWING_URI_SCHEME) {
        return new vscode.FileDecoration(undefined, undefined, color);
      }
      if (agentFileUri && uri.toString() === agentFileUri) {
        return new vscode.FileDecoration(
          '●',
          'Fichier de la visite en cours (agent)',
          color,
        );
      }
      return undefined;
    },
  };

  const lenses: vscode.CodeLensProvider = {
    onDidChangeCodeLenses: lensChanged.event,
    provideCodeLenses: (doc) => {
      if (!agentMark || doc.uri.toString() !== agentMark.uri) {
        return [];
      }
      const at = new vscode.Range(agentMark.line - 1, 0, agentMark.line - 1, 0);
      return [
        new vscode.CodeLens(at, {
          title: '$(eye) Smart Explorer',
          tooltip: "Suivi de l'agent : cliquer pour revenir ici",
          command: 'smartExplorer.followingAgent',
        }),
        new vscode.CodeLens(at, {
          title: 'Stop following',
          command: 'smartExplorer.stopFollowing',
        }),
      ];
    },
  };

  const revealInTree = async (relPath: string): Promise<boolean> => {
    let node = await provider.findFileNode(relPath);
    if (!node && root) {
      // Le fichier n'est pas dans le workspace affiché : s'il appartient à un
      // seul autre workspace, on bascule dessus pour montrer le bon arbre.
      const target = workspaceForFile(
        provider.workspacesContaining(relPath),
        provider.activeWorkspaceId(),
      );
      if (target && target !== provider.activeWorkspaceId()) {
        writeActive(root, target);
        reload();
        node = await provider.findFileNode(relPath);
      }
    }
    if (node && treeView.visible) {
      await treeView.reveal(node, { select: true, focus: false, expand: true });
    }
    return !!node;
  };

  // Document à ouvrir (fichier actuel ou diff unifié) et zone à mettre en
  // avant : rien sans `line` (fichier entier), la ligne ou seulement `match`
  // (inline), ou une petite plage. Dans un diff, les numéros de ligne du
  // fichier sont convertis en lignes du document de diff.
  const buildTarget = async (root: string, focus: FocusRequest) => {
    const abs = path.join(root, focus.path);
    const fileUri = vscode.Uri.file(abs);
    const readCurrent = () => {
      try {
        return fs.readFileSync(abs, 'utf8');
      } catch {
        return ''; // fichier illisible : pas de zone
      }
    };
    const diff = focus.diff;
    if (!diff) {
      const range = computeMarkRange(
        readCurrent(),
        focus.line,
        focus.end_line,
        focus.match,
      );
      const mark: AgentMark = {
        uri: fileUri.toString(),
        line: range?.startLine ?? 1,
        range,
      };
      return { shown: fileUri, fileUri, mark };
    }
    const shown = diffUri(root, focus.path, diff);
    const text = await gitDiffText(
      root,
      diff.from,
      diff.to,
      focus.path,
      diff.from_path,
    );
    const side = diff.side === 'old' ? 'old' : 'new';
    const sideContent =
      side === 'old'
        ? await gitShow(root, diff.from, diff.from_path ?? focus.path)
        : diff.to
          ? await gitShow(root, diff.to, focus.path)
          : readCurrent();
    const range = computeMarkRange(
      sideContent,
      focus.line,
      focus.end_line,
      focus.match,
    );
    const lines = range
      ? diffLineFor(text, side, range.startLine, range.endLine)
      : undefined;
    const inline =
      range?.startCol !== undefined &&
      range.endCol !== undefined &&
      lines !== undefined &&
      lines.first === lines.last;
    const mark: AgentMark = lines
      ? {
          uri: shown.toString(),
          line: lines.first,
          range: {
            startLine: lines.first,
            endLine: lines.last,
            // +1 : colonne du préfixe +/-/espace du diff unifié
            ...(inline &&
            range?.startCol !== undefined &&
            range.endCol !== undefined
              ? { startCol: range.startCol + 1, endCol: range.endCol + 1 }
              : {}),
          },
        }
      : { uri: shown.toString(), line: 1 };
    return { shown, fileUri, mark };
  };

  // L'agent mène : bon workspace, document ouvert à la zone, zone surlignée et
  // sélectionnée, fichier sélectionné (dossiers dépliés) dans l'arbre.
  const showFocus = async (root: string, focus: FocusRequest) => {
    log(
      `ouverture : ${focus.path}:${focus.line ?? '-'}${
        focus.diff ? ' (diff)' : ''
      }`,
    );
    const target =
      focus.workspace_id ??
      workspaceForFile(
        provider.workspacesContaining(focus.path),
        provider.activeWorkspaceId(),
      );
    if (target && target !== provider.activeWorkspaceId()) {
      writeActive(root, target);
    }
    reload();
    if (!treeView.visible) {
      await vscode.commands.executeCommand('smartExplorerView.focus');
    }
    try {
      await revealInTree(focus.path);
    } catch (e) {
      log(`sélection dans l'arbre impossible (${errText(e)})`);
    }
    const { shown, fileUri, mark } = await buildTarget(root, focus);
    setAgentMark(mark, fileUri.toString());
    const r = mark.range;
    const selection = r
      ? r.startCol !== undefined && r.endCol !== undefined
        ? new vscode.Range(r.startLine - 1, r.startCol, r.endLine - 1, r.endCol)
        : new vscode.Range(r.startLine - 1, 0, r.endLine, 0)
      : new vscode.Range(mark.line - 1, 0, mark.line - 1, 0);
    const doc = await vscode.workspace.openTextDocument(shown);
    const editor = await vscode.window.showTextDocument(doc, { selection });
    editor.revealRange(selection, vscode.TextEditorRevealType.InCenter);
    paintHighlight();
    log(`ouvert : ${shown.toString()} (ligne ${mark.line})`);
    return {
      uri: shown,
      line: mark.line,
      endLine: mark.range?.endLine ?? mark.line,
    };
  };

  // État de suivi (follow.json), partagé avec l'agent : « following » affiche
  // la ligne du panneau + le surlignage ; « ended » (l'agent a terminé, tu as
  // cliqué sur Stop, ou plus d'activité depuis 30 min) les retire.
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  const syncFollow = async (root: string, open: boolean) => {
    const state = readFollow(root);
    reload();
    if (expiryTimer) {
      clearTimeout(expiryTimer);
      expiryTimer = undefined;
    }
    if (state?.status === 'following' && state.focus) {
      expiryTimer = setTimeout(
        () => void syncFollow(root, false),
        Math.max(
          1000,
          Date.parse(state.updated_at) + FOLLOW_IDLE_MS - Date.now() + 1000,
        ),
      );
      if (open) {
        await showFocus(root, state.focus);
      } else {
        const { fileUri, mark } = await buildTarget(root, state.focus);
        setAgentMark(mark, fileUri.toString());
      }
    } else if (!walkthrough?.active) {
      // (pendant une visite guidée, le surlignage appartient à l'étape courante)
      setAgentMark(undefined);
    }
  };

  // Visite guidée dans l'éditeur : fils de commentaire par étape (voir
  // walkthroughController.ts). Chaque étape ouvre le fichier à la ligne visée.
  const walkthrough = root
    ? new WalkthroughController(root, {
        showStep: (focus) => showFocus(root, focus),
        log,
        endFollow: async () => {
          writeFollow(root, {
            status: 'ended',
            focus: readFollow(root)?.focus,
          });
          await syncFollow(root, false);
        },
        refresh: reload,
      })
    : undefined;

  // Relecture de la visite : sur changement de walkthrough.json (watcher) ET par
  // sondage (un renommage atomique peut échapper au watcher). Les erreurs sont
  // journalisées, jamais silencieuses.
  const syncWalk = () => {
    log('visite guidée : relecture');
    return walkthrough
      ?.sync()
      .then(() => log('visite guidée : relecture terminée'))
      .catch((e) => {
        log(`visite guidée : ERREUR ${errText(e)}`);
        void vscode.window.showWarningMessage(
          `Smart Explorer : visite guidée impossible (${errText(
            e,
          )}). Voir Sortie → Smart Explorer.`,
        );
      });
  };

  // Le fichier regardé (cmd+P, onglets, clic, reveal_file…) est sélectionné
  // dans l'arbre ; si le workspace affiché ne le contient pas, on bascule sur
  // celui qui le contient.
  const syncTreeToEditor = async (editor: vscode.TextEditor | undefined) => {
    const follow = vscode.workspace
      .getConfiguration('smartExplorer')
      .get<boolean>('followActiveEditor', true);
    if (!root || !follow || editor?.document.uri.scheme !== 'file') {
      return;
    }
    const rel = path
      .relative(root, editor.document.uri.fsPath)
      .split(path.sep)
      .join('/');
    if (!rel.startsWith('..')) {
      await revealInTree(rel);
    }
  };

  const disposables: vscode.Disposable[] = [
    out,
    highlightLines,
    highlightInline,
    lensChanged,
    vscode.languages.registerCodeLensProvider(
      [{ scheme: 'file' }, { scheme: DIFF_SCHEME }],
      lenses,
    ),
    vscode.window.registerFileDecorationProvider(decorations),
    decorationsChanged,
    // Contenu du diff unifié d'un fichier entre deux révisions (une seule vue).
    vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, {
      provideTextDocumentContent: async (uri) => {
        const q = JSON.parse(uri.query) as DiffRequest & {
          root: string;
          path: string;
        };
        return gitDiffText(q.root, q.from, q.to, q.path, q.from_path);
      },
    }),
    vscode.window.onDidChangeVisibleTextEditors(paintHighlight),
  ];
  if (root) {
    // Les données vivent hors du projet : on surveille leur dossier.
    const wsDir = vscode.Uri.file(workspacesDir(root));
    const projectDir = vscode.Uri.file(projectDataDir(root));
    for (const watcher of [
      vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(wsDir, '*.yaml'),
      ),
      vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(projectDir, 'active'),
      ),
    ]) {
      watcher.onDidChange(reload);
      watcher.onDidCreate(reload);
      watcher.onDidDelete(reload);
      disposables.push(watcher);
    }
    // Signal de vie : l'agent sait que VS Code est ouvert sur ce projet (il peut
    // alors faire la visite ici plutôt que dans le terminal).
    writeUiHeartbeat(root);
    const heartbeat = setInterval(() => writeUiHeartbeat(root), 20_000);
    disposables.push({ dispose: () => clearInterval(heartbeat) });
    if (walkthrough) {
      const walkWatcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(projectDir, 'walkthrough.json'),
      );
      const onWalk = () => void syncWalk();
      walkWatcher.onDidChange(onWalk);
      walkWatcher.onDidCreate(onWalk);
      walkWatcher.onDidDelete(onWalk);
      let lastStamp = '';
      const stamp = () => {
        try {
          return String(fs.statSync(walkthroughFilePath(root)).mtimeMs);
        } catch {
          return '';
        }
      };
      const poll = setInterval(() => {
        const now = stamp();
        if (now !== lastStamp) {
          lastStamp = now;
          void syncWalk();
        }
      }, 2000);
      disposables.push(walkWatcher, walkthrough, {
        dispose: () => clearInterval(poll),
      });
    }
    const followWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(projectDir, 'follow.json'),
    );
    const onFollow = () =>
      syncFollow(root, true).catch((e) =>
        vscode.window.showWarningMessage(
          `Smart Explorer : suivi impossible (${
            e instanceof Error ? e.message : e
          })`,
        ),
      );
    followWatcher.onDidChange(onFollow);
    followWatcher.onDidCreate(onFollow);
    disposables.push(
      followWatcher,
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        syncTreeToEditor(editor).catch(() => undefined);
      }),
      // La vue redevient visible : elle rattrape le fichier déjà ouvert.
      treeView.onDidChangeVisibility((e) => {
        if (e.visible) {
          syncTreeToEditor(vscode.window.activeTextEditor).catch(
            () => undefined,
          );
        }
      }),
    );
    // Session déjà en cours à l'ouverture : on remet la ligne et le surlignage.
    void syncFollow(root, false).then(() => syncWalk());
  }

  context.subscriptions.push(
    treeView,
    othersView,
    ...disposables,
    vscode.commands.registerCommand('smartExplorer.refresh', reload),
    vscode.commands.registerCommand('smartExplorer.walkthroughSync', () =>
      syncWalk(),
    ),
    vscode.commands.registerCommand('smartExplorer.walkthroughTest', () => {
      const result = walkthrough?.testThread() ?? 'visite guidée indisponible';
      log(`test : ${result}`);
      void vscode.window.showInformationMessage(`Smart Explorer : ${result}`);
    }),
    vscode.commands.registerCommand(
      'smartExplorer.walkthroughNext',
      () => walkthrough?.next(),
    ),
    vscode.commands.registerCommand(
      'smartExplorer.walkthroughBack',
      () => walkthrough?.back(),
    ),
    vscode.commands.registerCommand(
      'smartExplorer.walkthroughReply',
      (reply: vscode.CommentReply) => walkthrough?.reply(reply),
    ),
    vscode.commands.registerCommand(
      'smartExplorer.followingAgent',
      async () => {
        if (await walkthrough?.revisit()) {
          return;
        }
        const state = root ? readFollow(root) : undefined;
        if (root && state?.status === 'following' && state.focus) {
          await showFocus(root, state.focus);
        }
      },
    ),
    // L'utilisateur arrête le suivi : ligne du panneau et surlignage partent,
    // et les prochains reveal de l'agent sont ignorés (il en est informé).
    vscode.commands.registerCommand('smartExplorer.stopFollowing', async () => {
      if (!root) {
        return;
      }
      await walkthrough?.stop();
      writeFollow(root, {
        status: 'ended',
        focus: readFollow(root)?.focus,
      });
      await syncFollow(root, false);
    }),
    // Reprend le suivi après un arrêt (dernière position de l'agent).
    vscode.commands.registerCommand('smartExplorer.followAgent', async () => {
      const state = root ? readFollow(root) : undefined;
      if (!root || !state?.focus) {
        vscode.window.showInformationMessage(
          "Smart Explorer : l'agent n'a encore rien mis en avant.",
        );
        return;
      }
      writeFollow(root, { status: 'following', focus: state.focus });
      await syncFollow(root, true);
    }),
    vscode.commands.registerCommand(
      'smartExplorer.activateWorkspace',
      (node: SmartExplorerNode) => {
        provider.activateWorkspace(node);
        reload();
      },
    ),
    vscode.commands.registerCommand(
      'smartExplorer.renameWorkspace',
      async () => {
        const node = (treeView.selection[0] ?? othersView.selection[0]) as
          | SmartExplorerNode
          | undefined;
        await provider.renameWorkspace(node);
        reload();
      },
    ),
    vscode.commands.registerCommand(
      'smartExplorer.deleteWorkspace',
      async (node: SmartExplorerNode) => {
        await provider.deleteWorkspace(node);
        reload();
      },
    ),
    vscode.commands.registerCommand(
      'smartExplorer.addInstruction',
      async (node: SmartExplorerNode) => {
        await provider.addInstruction(node);
        reload();
      },
    ),
    vscode.commands.registerCommand(
      'smartExplorer.revealInExplorer',
      (node: SmartExplorerNode) => provider.revealInExplorer(node),
    ),
    vscode.commands.registerCommand('smartExplorer.cleanOrphans', async () => {
      const orphans = listOrphanProjects();
      if (orphans.length === 0) {
        vscode.window.showInformationMessage(
          'Smart Explorer : aucune donnée orpheline.',
        );
        return;
      }
      const count = orphans.reduce((n, o) => n + o.workspaces, 0);
      const confirm = await vscode.window.showWarningMessage(
        `Supprimer les données de ${orphans.length} projet(s) introuvable(s) (${count} workspace(s)) ?`,
        { modal: true, detail: orphans.map((o) => o.root ?? o.dir).join('\n') },
        'Supprimer',
      );
      if (confirm === 'Supprimer') {
        orphans.forEach((o) => removeProjectData(o.dir));
      }
    }),
  );
}

export function deactivate() {}
