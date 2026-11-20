// Test d'intégration du serveur MCP stdio : on spawne out/mcpStdio.js et on
// parle JSON-RPC (initialize → tools/list → tools/call) par stdin/stdout.
import './test-home';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readActive, workspaceFilePath } from '../src/workspaceStore';

const SERVER = path.join(__dirname, '..', '..', 'out', 'mcpStdio.js');
const BUNDLE = path.join(
  __dirname,
  '..',
  '..',
  'dist',
  'smart-explorer-mcp.js',
);

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-explorer-stdio-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  return root;
}

interface Rpc {
  send(method: string, params?: unknown): Promise<any>;
  close(): void;
}

function spawnServer(root: string, bin: string = SERVER): Rpc {
  const child = spawn(process.execPath, [bin, '--root', root], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buffer = '';
  const pending = new Map<number, (v: any) => void>();
  let nextId = 1;
  let stderrBuf = '';
  child.stderr.on('data', (c) => {
    stderrBuf += c.toString();
  });
  child.on('exit', (code) => {
    for (const [, resolve] of pending) {
      resolve({
        error: { code: 'child-exit', exitCode: code, stderr: stderrBuf },
      });
    }
    pending.clear();
  });
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) {
        continue;
      }
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)!(msg);
        pending.delete(msg.id);
      }
    }
  });
  return {
    send(method: string, params?: unknown): Promise<any> {
      const id = nextId++;
      const promise = new Promise<any>((resolve) => pending.set(id, resolve));
      child.stdin.write(
        JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n',
      );
      return promise;
    },
    close(): void {
      child.kill();
    },
  };
}

async function handshake(rpc: Rpc): Promise<void> {
  const init = await rpc.send('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '0.0.0' },
  });
  assert.equal(init.result.serverInfo.name, 'smart-explorer');
  rpc.send('notifications/initialized');
}

test('serveur stdio : handshake + tools/list (13 tools) + tools/call', async () => {
  const root = makeTempRoot();
  const rpc = spawnServer(root);
  try {
    await handshake(rpc);

    const list = await rpc.send('tools/list');
    const names = list.result.tools.map((t: any) => t.name).sort();
    assert.deepEqual(names, [
      'apply_sync',
      'build_tree',
      'check_workspace_files',
      'create_workspace',
      'export_context',
      'get_workspace',
      'list_workspaces',
      'reveal_file',
      'set_active_workspace',
      'set_instructions',
      'stop_following',
      'sync_workspace',
      'update_files',
    ]);

    // tools/call : create_workspace puis list_workspaces
    const created = await rpc.send('tools/call', {
      name: 'create_workspace',
      arguments: { source: 'https://github.com/o/r/pull/376', name: 'PR 376' },
    });
    const createdText = created.result.content[0].text;
    assert.ok(createdText.includes('pr-376'));
    // Les données vivent hors du projet.
    assert.ok(fs.existsSync(workspaceFilePath(root, 'pr-376')));
    assert.equal(fs.existsSync(path.join(root, '.smart-explorer')), false);

    const listed = await rpc.send('tools/call', {
      name: 'list_workspaces',
      arguments: {},
    });
    const listedData = JSON.parse(listed.result.content[0].text);
    assert.equal(listedData.workspaces.length, 1);
    assert.equal(listedData.workspaces[0].id, 'pr-376');

    // build_tree puis export_context
    await rpc.send('tools/call', {
      name: 'build_tree',
      arguments: {
        workspace_id: 'pr-376',
        tree: { files: ['src/a.ts'] },
      },
    });
    const exported = await rpc.send('tools/call', {
      name: 'export_context',
      arguments: { workspace_id: 'pr-376' },
    });
    const exportedData = JSON.parse(exported.result.content[0].text);
    assert.deepEqual(exportedData.files, ['src/a.ts']);
    assert.ok(exportedData.content.includes('export const a = 1;'));

    // set_active_workspace écrit le fichier actif (lu par l'extension)
    await rpc.send('tools/call', {
      name: 'set_active_workspace',
      arguments: { workspace_id: 'pr-376' },
    });
    assert.equal(readActive(root), 'pr-376');
  } finally {
    rpc.close();
  }
});

test(
  'bundle dist/smart-explorer-mcp.js : handshake + tools/list',
  { skip: !fs.existsSync(BUNDLE) },
  async () => {
    const root = makeTempRoot();
    const rpc = spawnServer(root, BUNDLE);
    try {
      await handshake(rpc);
      const list = await rpc.send('tools/list');
      assert.equal(list.result.tools.length, 13);
    } finally {
      rpc.close();
    }
  },
);
