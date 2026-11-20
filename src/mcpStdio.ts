#!/usr/bin/env node
// Serveur MCP stdio pour clients externes (Vibe, Claude Code CLI, CLI Mistral).
// Expose les mêmes tools que la version in-process de l'extension VS Code
// (définitions partagées dans mcpSpecs.ts, logique dans mcpTools.ts).
//
// Racine du projet, par ordre de priorité :
//   1. argument --root <path>
//   2. variable d'environnement SMART_EXPLORER_ROOT
//   3. répertoire courant (process.cwd())
//
// Les données (workspaces, workspace actif) vivent hors du projet, dans
// $SMART_EXPLORER_HOME ou ~/.local/share/smart-explorer (voir workspaceStore).
//
// Config client (ex: .mcp.json à la racine du projet) :
//   { "mcpServers": { "smart-explorer": { "command": "node",
//       "args": ["/abs/path/smart-explorer/out/mcpStdio.js"] } } }
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as path from 'path';
import { TOOL_SPECS } from './mcp/mcpSpecs';
import { ToolEnv } from './mcp/mcpTools';

function resolveRoot(): string {
  const argIdx = process.argv.indexOf('--root');
  if (argIdx >= 0 && process.argv[argIdx + 1]) {
    return path.resolve(process.argv[argIdx + 1]);
  }
  if (process.env.SMART_EXPLORER_ROOT) {
    return path.resolve(process.env.SMART_EXPLORER_ROOT);
  }
  return process.cwd();
}

function text(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  };
}

async function main(): Promise<void> {
  const root = resolveRoot();
  // Hors VS Code : pas de hooks UI (reveal_file retourne le chemin absolu ;
  // set_active_workspace écrit le fichier lu par l'extension).
  const env: ToolEnv = { root };
  const server = new McpServer(
    { name: 'smart-explorer', version: '0.0.1' },
    {
      instructions: `Smart Explorer — workspaces à virtual tree pour ${root}.`,
    },
  );
  for (const spec of TOOL_SPECS) {
    server.registerTool(
      spec.name,
      { description: spec.description, inputSchema: spec.shape },
      async (args: any) => text(await spec.run(env, args)),
    );
  }
  await server.connect(new StdioServerTransport());
  // eslint-disable-next-line no-console
  console.error(`smart-explorer MCP stdio démarré (root=${root})`);
}

main().catch((error) => {
  console.error('smart-explorer MCP stdio: erreur fatale', error);
  process.exit(1);
});
