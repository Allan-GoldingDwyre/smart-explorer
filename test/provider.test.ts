import './test-home';
import './vscode-mock';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SmartExplorerProvider } from '../src/SmartExplorerProvider';
import { SmartExplorerNode } from '../src/SmartExplorerNode';
import {
  VirtualDir,
  WorkspaceFile,
  listWorkspaces,
  saveWorkspace,
  writeActive,
} from '../src/workspaceStore';
import {
  executedCommands,
  inputQueue,
  resetMock,
  vscodeMock,
  warningQueue,
} from './vscode-mock';

// Projet temporaire ouvert dans la "fenêtre" simulée.
function openProject(): string {
  resetMock();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'se-provider-'));
  vscodeMock.workspace.workspaceFolders = [{ uri: vscodeMock.Uri.file(root) }];
  return root;
}

function ws(id: string, tree?: VirtualDir): WorkspaceFile {
  return {
    version: 1,
    id,
    name: id.toUpperCase(),
    source: { type: 'pr', url: `https://github.com/o/r/pull/${id}` },
    instructions: ['relire la migration'],
    tree,
  };
}

async function rootNodes(
  provider: SmartExplorerProvider,
): Promise<SmartExplorerNode[]> {
  return provider.getChildren(undefined);
}

test('racine : le workspace du projet est un noeud déplié avec son type', async () => {
  const root = openProject();
  saveWorkspace(root, ws('a'));
  const nodes = await rootNodes(new SmartExplorerProvider());
  assert.deepEqual(
    nodes.map((n) => n.label),
    ['A'],
  );
  assert.equal(nodes[0].contextValue, 'workspace-pr');
  assert.equal(nodes[0].collapsibleState, 2);
});

test('racine : projet sans workspace -> vue vide (welcome page)', async () => {
  openProject();
  assert.deepEqual(await rootNodes(new SmartExplorerProvider()), []);
});

test('workspace sans arbre : invite à appeler build_tree', async () => {
  const root = openProject();
  saveWorkspace(root, ws('a'));
  const provider = new SmartExplorerProvider();
  const children = await provider.getChildren((await rootNodes(provider))[0]);
  assert.equal(children.length, 1);
  assert.equal(children[0].contextValue, 'info');
});

test('arbre virtuel : dossiers d’abord, puis fichiers, triés par nom, sans doublon', async () => {
  const root = openProject();
  saveWorkspace(
    root,
    ws('a', {
      name: '.',
      files: ['src/zeta.rs', 'lib/Alpha.rs', 'src/zeta.rs'],
      dirs: [
        { name: 'tests', files: ['t/b.rs', 't/a.rs'] },
        { name: 'storage', files: ['s/x.rs'] },
      ],
    }),
  );
  const provider = new SmartExplorerProvider();
  const children = await provider.getChildren((await rootNodes(provider))[0]);
  assert.deepEqual(
    children.map((c) => c.label),
    ['storage', 'tests', 'Alpha.rs', 'zeta.rs'],
  );
  assert.equal(children[0].contextValue, 'virtualFolder');
  // Le virtual dir hérite de l'icône de dossier du thème via resourceUri.
  assert.equal(path.basename(children[0].resourceUri!.fsPath), 'storage');
  const files = await provider.getChildren(children[1]);
  assert.deepEqual(
    files.map((f) => f.label),
    ['a.rs', 'b.rs'],
  );
  assert.equal(files[0].resourceUri!.fsPath, path.join(root, 't/a.rs'));
  assert.equal(files[0].command?.command, 'vscode.open');
});

test('virtual dir avec icon explicite : codicon, pas de resourceUri', async () => {
  const root = openProject();
  saveWorkspace(
    root,
    ws('a', {
      name: '.',
      dirs: [{ name: 'x', icon: 'beaker', files: ['x/a.rs'] }],
    }),
  );
  const provider = new SmartExplorerProvider();
  const [dir] = await provider.getChildren((await rootNodes(provider))[0]);
  assert.equal((dir.iconPath as any).id, 'beaker');
  assert.equal(dir.resourceUri, undefined);
});

test('renameWorkspace : met à jour le nom et persiste ; sans sélection -> no-op', async () => {
  const root = openProject();
  saveWorkspace(root, ws('a'));
  const provider = new SmartExplorerProvider();
  await provider.renameWorkspace(undefined);
  assert.equal(listWorkspaces(root)[0].name, 'A');
  inputQueue.push('Nouveau');
  await provider.renameWorkspace((await rootNodes(provider))[0]);
  assert.equal(listWorkspaces(root)[0].name, 'Nouveau');
});

test('deleteWorkspace : confirmé -> supprimé ; annulé -> conservé', async () => {
  const root = openProject();
  saveWorkspace(root, ws('a'));
  const provider = new SmartExplorerProvider();
  warningQueue.push(undefined);
  await provider.deleteWorkspace((await rootNodes(provider))[0]);
  assert.equal(listWorkspaces(root).length, 1);
  warningQueue.push('Supprimer');
  await provider.deleteWorkspace((await rootNodes(provider))[0]);
  assert.equal(listWorkspaces(root).length, 0);
  assert.deepEqual(await rootNodes(provider), []);
});

test('addInstruction : ajoute le besoin au workspace', async () => {
  const root = openProject();
  saveWorkspace(root, ws('a'));
  const provider = new SmartExplorerProvider();
  inputQueue.push('ignorer les tests');
  await provider.addInstruction((await rootNodes(provider))[0]);
  assert.deepEqual(listWorkspaces(root)[0].instructions, [
    'relire la migration',
    'ignorer les tests',
  ]);
});

test('plusieurs workspaces : le haut montre l’actif déplié, la vue du bas les autres repliés', async () => {
  const root = openProject();
  saveWorkspace(root, ws('a'));
  saveWorkspace(root, ws('b'));
  saveWorkspace(root, ws('c'));
  const main = new SmartExplorerProvider('main');
  const others = new SmartExplorerProvider('others');
  // Sans actif : le premier du projet est mis en avant.
  assert.deepEqual(
    (await rootNodes(main)).map((n) => n.label),
    ['A'],
  );
  assert.deepEqual(
    (await rootNodes(others)).map((n) => n.label),
    ['B', 'C'],
  );
  writeActive(root, 'b');
  main.reloadFromDisk();
  others.reloadFromDisk();
  const top = await rootNodes(main);
  assert.deepEqual(
    top.map((n) => n.label),
    ['B'],
  );
  assert.equal(top[0].collapsibleState, 2); // Expanded
  const bottom = await rootNodes(others);
  assert.deepEqual(
    bottom.map((n) => n.label),
    ['A', 'C'],
  );
  assert.ok(bottom.every((n) => n.collapsibleState === 1)); // Collapsed
  assert.equal(others.othersCount(), 2);
  // Actif périmé : ignoré, retour au premier workspace.
  writeActive(root, 'supprime');
  main.reloadFromDisk();
  assert.deepEqual(
    (await rootNodes(main)).map((n) => n.label),
    ['A'],
  );
});

test('activateWorkspace : un workspace du bas devient l’actif', async () => {
  const root = openProject();
  saveWorkspace(root, ws('a'));
  saveWorkspace(root, ws('b'));
  const main = new SmartExplorerProvider('main');
  const others = new SmartExplorerProvider('others');
  main.activateWorkspace((await rootNodes(others))[0]);
  others.reloadFromDisk();
  assert.deepEqual(
    (await rootNodes(main)).map((n) => n.label),
    ['B'],
  );
  assert.deepEqual(
    (await rootNodes(others)).map((n) => n.label),
    ['A'],
  );
  main.activateWorkspace(undefined); // no-op
});

test('revealInExplorer : chemin du fichier virtuel ; no-op sur un dossier', async () => {
  const root = openProject();
  saveWorkspace(
    root,
    ws('a', { name: '.', dirs: [{ name: 'd', files: ['w/b.py'] }] }),
  );
  const provider = new SmartExplorerProvider();
  const folder = (
    await provider.getChildren((await rootNodes(provider))[0])
  )[0];
  await provider.revealInExplorer(folder);
  assert.equal(executedCommands.length, 0);
  const file = (await provider.getChildren(folder))[0];
  await provider.revealInExplorer(file);
  assert.equal(executedCommands[0][0], 'revealInExplorer');
  assert.equal(executedCommands[0][1].fsPath, path.join(root, 'w/b.py'));
});

test('fichiers de même nom dans un virtual dir : le vrai dossier est affiché pour les distinguer', async () => {
  const root = openProject();
  saveWorkspace(
    root,
    ws('a', { name: '.', files: ['src/a/mod.rs', 'src/b/mod.rs', 'src/c.rs'] }),
  );
  const provider = new SmartExplorerProvider();
  const files = await provider.getChildren((await rootNodes(provider))[0]);
  assert.deepEqual(
    files.map((f) => [f.label, f.description]),
    [
      ['c.rs', undefined],
      ['mod.rs', 'src/a'],
      ['mod.rs', 'src/b'],
    ],
  );
  assert.equal(files[1].tooltip, 'src/a/mod.rs');
});
