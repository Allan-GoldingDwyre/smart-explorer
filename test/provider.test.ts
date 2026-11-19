import './vscode-mock';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SmartExplorerProvider } from '../src/SmartExplorerProvider';
import { SmartExplorerNode } from '../src/SmartExplorerNode';
import { FileTreeNode, WorkspaceEntry } from '../src/types';
import {
  fakeFs,
  inputQueue,
  makeContext,
  quickPickQueue,
  resetMock,
  vscodeMock,
} from './vscode-mock';

function makeProvider(): { provider: SmartExplorerProvider; context: any } {
  const context = makeContext();
  return { provider: new SmartExplorerProvider(context), context };
}

function workspacesOf(provider: SmartExplorerProvider): WorkspaceEntry[] {
  return (provider as any).workspaces;
}

async function rootNodes(
  provider: SmartExplorerProvider,
): Promise<SmartExplorerNode[]> {
  return provider.getChildren(undefined);
}

async function addViaFlow(
  provider: SmartExplorerProvider,
  ref: string,
  name: string,
): Promise<void> {
  quickPickQueue.push({ label: 'Smart', type: 'smart' });
  inputQueue.push(ref, name);
  await provider.addWorkspace();
}

test('addWorkspace : ajoute et persiste dans workspaceState', async () => {
  resetMock();
  const { provider, context } = makeProvider();
  await addViaFlow(provider, 'ABC-1', 'Mon WS');
  assert.equal(workspacesOf(provider).length, 1);
  assert.deepEqual(workspacesOf(provider)[0], {
    name: 'Mon WS',
    type: 'issue',
    ref: 'ABC-1',
  });
  const stored = context.workspaceState.get('smartExplorer.workspaces', []);
  assert.equal(stored.length, 1);
});

test('addWorkspace : doublon (même type + ref) refusé avec warning', async () => {
  resetMock();
  const { provider } = makeProvider();
  await addViaFlow(provider, 'ABC-1', 'Un');
  await addViaFlow(provider, 'abc-1', 'Deux'); // normalisé en ABC-1 -> doublon
  assert.equal(workspacesOf(provider).length, 1);
  assert.equal(workspacesOf(provider)[0].name, 'Un');
});

test('addWorkspace : annulé par l’utilisateur -> rien ajouté', async () => {
  resetMock();
  const { provider } = makeProvider();
  quickPickQueue.push(undefined);
  await provider.addWorkspace();
  assert.equal(workspacesOf(provider).length, 0);
});

test('renameWorkspace : met à jour le nom et persiste', async () => {
  resetMock();
  const { provider } = makeProvider();
  await addViaFlow(provider, 'ABC-1', 'Ancien');
  const node = (await rootNodes(provider)).find((n) => n.entry);
  inputQueue.push('Nouveau');
  await provider.renameWorkspace(node);
  assert.equal(workspacesOf(provider)[0].name, 'Nouveau');
});

test('renameWorkspace : sans sélection -> no-op', async () => {
  resetMock();
  const { provider } = makeProvider();
  await addViaFlow(provider, 'ABC-1', 'Ancien');
  await provider.renameWorkspace(undefined);
  assert.equal(workspacesOf(provider)[0].name, 'Ancien');
});

test('deleteWorkspace : confirmé -> supprimé ; annulé -> conservé', async () => {
  resetMock();
  const { provider } = makeProvider();
  await addViaFlow(provider, 'ABC-1', 'WS');
  const node = (await rootNodes(provider)).find((n) => n.entry)!;
  const { warningQueue } = await import('./vscode-mock');
  warningQueue.push(undefined); // annulation
  await provider.deleteWorkspace(node);
  assert.equal(workspacesOf(provider).length, 1);
  warningQueue.push('Supprimer'); // confirmation
  await provider.deleteWorkspace(node);
  assert.equal(workspacesOf(provider).length, 0);
});

test('addInstruction : ajoute une instruction au workspace', async () => {
  resetMock();
  const { provider } = makeProvider();
  await addViaFlow(provider, 'ABC-1', 'WS');
  const node = (await rootNodes(provider)).find((n) => n.entry)!;
  inputQueue.push('focus logique métier');
  await provider.addInstruction(node);
  assert.deepEqual(workspacesOf(provider)[0].instructions, [
    'focus logique métier',
  ]);
});

test('getChildren racine : nœud Setup Linear quand pas de clé, puis workspaces repliables', async () => {
  resetMock();
  const { provider } = makeProvider();
  await addViaFlow(provider, 'ABC-1', 'WS');
  const roots = await rootNodes(provider);
  assert.equal(roots[0].label, 'Setup Linear');
  const ws = roots.find((n) => n.entry)!;
  assert.equal(ws.label, 'WS');
  assert.equal(
    ws.collapsibleState,
    vscodeMock.TreeItemCollapsibleState.Collapsed,
  );
  assert.equal(ws.contextValue, 'workspace-issue');
});

test('getChildren workspace : arbre physique du projet, dossiers d’abord, node_modules ignoré, fichiers ouvrables', async () => {
  resetMock();
  vscodeMock.workspace.workspaceFolders = [
    { uri: vscodeMock.Uri.file('/proj') },
  ];
  const D = vscodeMock.FileType.Directory;
  const F = vscodeMock.FileType.File;
  fakeFs.set('/proj', [
    ['src', D],
    ['README.md', F],
    ['node_modules', D],
  ]);
  fakeFs.set('/proj/src', [['index.ts', F]]);
  const { provider } = makeProvider();
  await addViaFlow(provider, 'ABC-1', 'WS');
  const ws = (await rootNodes(provider)).find((n) => n.entry)!;
  const children = await provider.getChildren(ws);
  assert.deepEqual(
    children.map((c) => c.label),
    ['src', 'README.md'],
  );
  assert.equal(children[0].contextValue, 'folder');
  assert.equal(children[1].contextValue, 'file');
  assert.equal(children[1].command?.command, 'vscode.open');
  assert.equal(children[1].resourceUri!.fsPath, '/proj/README.md');
  const srcChildren = await provider.getChildren(children[0]);
  assert.deepEqual(
    srcChildren.map((c) => c.label),
    ['index.ts'],
  );
  assert.equal(srcChildren[0].resourceUri!.fsPath, '/proj/src/index.ts');
});

test('getChildren workspace : arbre virtuel (entry.tree) prioritaire, virtual folders supportés', async () => {
  resetMock();
  vscodeMock.workspace.workspaceFolders = [
    { uri: vscodeMock.Uri.file('/proj') },
  ];
  const { provider } = makeProvider();
  await addViaFlow(provider, 'ABC-1', 'WS');
  const virtualTree: FileTreeNode[] = [
    {
      name: 'Logique métier',
      path: '',
      type: 'virtualFolder',
      children: [
        { name: 'a.ts', path: 'src/a.ts', type: 'file' },
        { name: 'b.py', path: 'workflows/b.py', type: 'file' },
      ],
    },
  ];
  workspacesOf(provider)[0].tree = virtualTree;
  const ws = (await rootNodes(provider)).find((n) => n.entry)!;
  const children = await provider.getChildren(ws);
  assert.equal(children.length, 1);
  assert.equal(children[0].label, 'Logique métier');
  assert.equal(children[0].contextValue, 'folder');
  const files = await provider.getChildren(children[0]);
  assert.deepEqual(
    files.map((f) => f.label),
    ['a.ts', 'b.py'],
  );
  assert.equal(files[0].resourceUri!.fsPath, '/proj/src/a.ts');
  assert.equal(files[1].resourceUri!.fsPath, '/proj/workflows/b.py');
  assert.equal(files[1].command?.command, 'vscode.open');
});

test('refreshWorkspace : sans clé API, le nom est conservé et rien ne plante', async () => {
  resetMock();
  const { provider } = makeProvider();
  await addViaFlow(provider, 'ABC-1', 'WS');
  const node = (await rootNodes(provider)).find((n) => n.entry)!;
  await provider.refreshWorkspace(node);
  assert.equal(workspacesOf(provider)[0].name, 'WS');
});
