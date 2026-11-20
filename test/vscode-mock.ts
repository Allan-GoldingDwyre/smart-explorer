// Mock minimal du module 'vscode' pour exécuter les tests sous plain Node.
// Installé via un patch de Module._load au chargement de ce fichier :
// l'importer en PREMIER import dans chaque fichier de test.
import Module from 'module';
import path from 'path';

class Uri {
  scheme = 'file';
  constructor(public fsPath: string) {}
  static file(p: string): Uri {
    return new Uri(p);
  }
  static parse(p: string): Uri {
    return new Uri(p.replace(/^file:\/\//, ''));
  }
  static from(c: { scheme: string; path?: string; query?: string }): Uri {
    const u = new Uri(c.path ?? '');
    u.scheme = c.scheme;
    return u;
  }
  static joinPath(base: Uri, ...segments: string[]): Uri {
    return new Uri(path.join(base.fsPath, ...segments));
  }
  toString(): string {
    return `file://${this.fsPath}`;
  }
}

// Files d'attente scriptables par les tests.
export const inputQueue: (string | undefined)[] = [];
export const quickPickQueue: any[] = [];
export const warningQueue: any[] = [];

// Commandes exécutées via vscode.commands.executeCommand : [commande, ...args].
export const executedCommands: any[][] = [];

export const vscodeMock: any = {
  Uri,
  FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  TreeItem: class {
    contextValue?: string;
    iconPath?: any;
    resourceUri?: any;
    description?: string;
    tooltip?: string;
    command?: any;
    constructor(
      public label: any,
      public collapsibleState?: any,
    ) {}
  },
  ThemeIcon: class {
    constructor(
      public id: string,
      public color?: any,
    ) {}
  },
  ThemeColor: class {
    constructor(public id: string) {}
  },
  EventEmitter: class {
    event = () => ({ dispose() {} });
    fire() {}
  },
  window: {
    showInputBox: async (_opts?: any) => inputQueue.shift(),
    showQuickPick: async (_: any, _opts?: any) => {
      const queued = quickPickQueue.shift();
      return queued === undefined ? undefined : queued;
    },
    showWarningMessage: async (..._args: any[]) => warningQueue.shift(),
    showInformationMessage: async (..._args: any[]) => undefined,
    createTreeView: () => ({ selection: [] as any[] }),
    visibleTextEditors: [] as any[],
  },
  workspace: {
    workspaceFolders: [] as any[],
    asRelativePath: (uri: any) => String(uri?.fsPath ?? uri),
    getConfiguration: () => ({ get: () => undefined }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
  },
  Range: class {
    constructor(
      public startLine: number,
      public startCharacter: number,
      public endLine: number,
      public endCharacter: number,
    ) {}
    get start() {
      return { line: this.startLine, character: this.startCharacter };
    }
    get end() {
      return { line: this.endLine, character: this.endCharacter };
    }
  },
  MarkdownString: class {
    constructor(public value: string) {}
  },
  CommentMode: { Editing: 0, Preview: 1 },
  CommentThreadCollapsibleState: { Collapsed: 0, Expanded: 1 },
  // Contrôleur de commentaires factice : enregistre les fils créés.
  comments: {
    controllers: [] as any[],
    createCommentController(id: string, label: string) {
      const controller: any = {
        id,
        label,
        threads: [] as any[],
        options: undefined,
        commentingRangeProvider: undefined,
        createCommentThread(uri: any, range: any, comments: any[]) {
          const thread: any = {
            uri,
            range,
            comments,
            canReply: false,
            disposed: false,
            dispose() {
              thread.disposed = true;
            },
          };
          controller.threads.push(thread);
          return thread;
        },
        dispose() {},
      };
      vscodeMock.comments.controllers.push(controller);
      return controller;
    },
  },
  commands: {
    registerCommand: () => ({ dispose() {} }),
    executeCommand: async (command: string, ...args: any[]) => {
      executedCommands.push([command, ...args]);
    },
  },
  authentication: {
    getSession: async () => undefined,
    onDidChangeSessions: () => ({ dispose() {} }),
  },
};

const originalLoad = (Module as any)._load;
(Module as any)._load = function (request: string, ...rest: any[]) {
  if (request === 'vscode') {
    return vscodeMock;
  }
  return originalLoad.call(this, request, ...rest);
};

export function makeContext(): any {
  const store = new Map<string, any>();
  return {
    secrets: {
      get: async (k: string) => store.get(`secret:${k}`),
      store: async (k: string, v: string) => void store.set(`secret:${k}`, v),
      delete: async (k: string) => void store.delete(`secret:${k}`),
    },
    workspaceState: {
      get: (k: string, def: any) => store.get(k) ?? def,
      update: async (k: string, v: any) => void store.set(k, v),
    },
    subscriptions: [] as any[],
  };
}

export function resetMock(): void {
  inputQueue.length = 0;
  quickPickQueue.length = 0;
  warningQueue.length = 0;
  executedCommands.length = 0;
  vscodeMock.workspace.workspaceFolders = [];
  vscodeMock.comments.controllers.length = 0;
}
