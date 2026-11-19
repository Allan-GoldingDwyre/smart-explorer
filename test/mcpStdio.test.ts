// Test d'intégration du serveur MCP stdio : on spawne out/mcpStdio.js et on
// parle JSON-RPC (initialize → tools/list → tools/call) par stdin/stdout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SERVER = path.join(__dirname, '..', '..', 'out', 'mcpStdio.js');

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

function spawnServer(root: string): Rpc {
  const child = spawn(process.execPath, [SERVER, '--root', root], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buffer = '';
  const pending = new Map<number, (v: any) => void>();
  let nextId = 1;
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

test('serveur stdio : handshake + tools/list (11 tools) + tools/call', async () => {
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
      'fetch_source',
      'list_workspaces',
      'reveal_file',
      'set_active_workspace',
      'set_instructions',
      'sync_workspace',
    ]);

    // tools/call : create_workspace puis list_workspaces
    const created = await rpc.send('tools/call', {
      name: 'create_workspace',
      arguments: { source: 'https://github.com/o/r/pull/376', name: 'PR 376' },
    });
    const createdText = created.result.content[0].text;
    assert.ok(createdText.includes('pr-376'));
    assert.ok(
      fs.existsSync(
        path.join(root, '.smart-explorer', 'workspaces', 'pr-376.yaml'),
      ),
    );

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
        tree: { name: '.', dirs: [{ name: 'Métier', files: ['src/a.ts'] }] },
      },
    });
    const exported = await rpc.send('tools/call', {
      name: 'export_context',
      arguments: { workspace_id: 'pr-376', mode: 'primary' },
    });
    const exportedData = JSON.parse(exported.result.content[0].text);
    assert.deepEqual(exportedData.files, ['src/a.ts']);
    assert.ok(exportedData.content.includes('export const a = 1;'));

    // set_active_workspace écrit .smart-explorer/active (lu par l'extension)
    await rpc.send('tools/call', {
      name: 'set_active_workspace',
      arguments: { workspace_id: 'pr-376' },
    });
    assert.equal(
      fs.readFileSync(path.join(root, '.smart-explorer', 'active'), 'utf8'),
      'pr-376',
    );
  } finally {
    rpc.close();
  }
});
