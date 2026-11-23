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
import { SmartExplorerNode } from './view/SmartExplorerNode';
import { SmartExplorerProvider } from './view/SmartExplorerProvider';
import { walkthroughMarkdownPath } from './walkthrough/walkthrough';
import {
  DiffRequest,
  FocusRequest,
  focusFilePath,
  gitDiffText,
  gitShow,
  listOrphanProjects,
  projectDataDir,
  readFocus,
  removeProjectData,
  workspacesDir,
  writeActive,
} from './core/workspaceStore';

export function activate(context: vscode.ExtensionContext) {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
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

  const walkPage = root ? walkthroughMarkdownPath(root) : undefined;
  const setHasWalkthrough = () =>
    vscode.commands.executeCommand(
      'setContext',
      'smartExplorer.hasWalkthrough',
      !!walkPage && fs.existsSync(walkPage),
    );

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
  };
  reload();
  void setHasWalkthrough();

  // Journal de l'extension (Sortie -> « Smart Explorer »).
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
  log(
    `activation (version ${context.extension.packageJSON.version}, projet ${
      root ?? 'aucun'
    })`,
  );
  const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

  // --- Mise en avant demandée par l'agent (tool `focus`) ---

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
  // première ligne ; `range` : zone surlignée (absente = fichier entier).
  interface AgentMark {
    uri: string;
    line: number;
    range?: MarkRange;
  }
  let agentMark: AgentMark | undefined;
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
      return { shown: fileUri, mark };
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
    return { shown, mark };
  };

  // Bon workspace, document ouvert à la zone, zone surlignée et sélectionnée,
  // fichier sélectionné (dossiers dépliés) dans l'arbre.
  const showFocus = async (root: string, focus: FocusRequest) => {
    log(
      `focus : ${focus.path}:${focus.line ?? '-'}${
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
    const { shown, mark } = await buildTarget(root, focus);
    agentMark = mark;
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
  };

  const onFocus = () => {
    const focus = root ? readFocus(root) : undefined;
    if (root && focus) {
      showFocus(root, focus).catch((e) => {
        log(`focus impossible : ${errText(e)}`);
        void vscode.window.showWarningMessage(
          `Smart Explorer : impossible d'ouvrir ${focus.path} (${errText(e)})`,
        );
      });
    }
  };

  // --- Page de la visite guidée (aperçu markdown natif) ---

  // La page (walkthrough.md) est régénérée à chaque étape par le serveur ; à
  // sa création on ouvre l'aperçu, qui se rafraîchit ensuite tout seul.
  const openWalkthrough = async () => {
    if (!walkPage || !fs.existsSync(walkPage)) {
      void vscode.window.showInformationMessage(
        "Smart Explorer : aucune visite guidée en cours (demande à l'agent de la lancer).",
      );
      return;
    }
    await vscode.commands.executeCommand(
      'markdown.showPreviewToSide',
      vscode.Uri.file(walkPage),
    );
  };

  // Le fichier regardé (cmd+P, onglets, clic, focus…) est sélectionné dans
  // l'arbre ; si le workspace affiché ne le contient pas, on bascule sur celui
  // qui le contient.
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
    const watch = (
      base: vscode.Uri,
      pattern: string,
      handlers: { change?: () => void; create?: () => void; del?: () => void },
    ) => {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(base, pattern),
      );
      if (handlers.change) watcher.onDidChange(handlers.change);
      if (handlers.create) watcher.onDidCreate(handlers.create);
      if (handlers.del) watcher.onDidDelete(handlers.del);
      disposables.push(watcher);
    };
    watch(wsDir, '*.yaml', { change: reload, create: reload, del: reload });
    watch(projectDir, 'active', {
      change: reload,
      create: reload,
      del: reload,
    });
    watch(projectDir, path.basename(focusFilePath(root)), {
      change: onFocus,
      create: onFocus,
    });
    watch(projectDir, path.basename(walkthroughMarkdownPath(root)), {
      create: () => {
        void setHasWalkthrough();
        void openWalkthrough();
      },
      del: () => void setHasWalkthrough(),
    });
    disposables.push(
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
  }

  context.subscriptions.push(
    treeView,
    othersView,
    ...disposables,
    vscode.commands.registerCommand('smartExplorer.refresh', reload),
    vscode.commands.registerCommand(
      'smartExplorer.openWalkthrough',
      openWalkthrough,
    ),
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
