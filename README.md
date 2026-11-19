# Smart Explorer

A smarter file explorer panel for VS Code.

## Features

- Custom tree view in the Activity Bar
- Browse workspace files and folders
- Click a file to open it
- Refresh button to reload the tree
- **MCP server hébergé par l'extension** (VS Code ≥ 1.99, `vscode.createMcpServer`, démarré à l'activation) : un agent MCP (Vibe, Claude Code, CLI Mistral) pilote les workspaces via 11 tools (`list_workspaces`, `create_workspace`, `fetch_source`, `build_tree`, `set_instructions`, `sync_workspace`, `apply_sync`, `check_workspace_files`, `export_context`, `reveal_file`, `set_active_workspace`). L'extension reste le rendering + registry.
- **Serveur MCP stdio pour clients externes** (`out/mcpStdio.js`, mêmes 11 tools, logique partagée dans `mcpTools.ts`) : voir ci-dessous.

## Client externe (Vibe, Claude Code CLI, CLI Mistral)

Le serveur in-process de VS Code n'est pas spawné par un client externe ; on passe par le binaire stdio :

```bash
npm run compile   # produit out/mcpStdio.js
```

Config client — `.mcp.json` à la racine du projet (lu par Claude Code, Vibe, etc.) :

```json
{
  "mcpServers": {
    "smart-explorer": {
      "command": "node",
      "args": ["/chemin/absolu/vers/smart-explorer/out/mcpStdio.js"]
    }
  }
}
```

La racine du projet est résolue par ordre : `--root <path>`, variable `SMART_EXPLORER_ROOT`, sinon le répertoire courant du client. `set_active_workspace` écrit `.smart-explorer/active`, lu par l'extension VS Code (la vue bascule toute seule). `reveal_file` retourne le chemin absolu — c'est le client qui ouvre le fichier.

## État partagé (YAML)

Un fichier par workspace dans `.smart-explorer/workspaces/<id>.yaml` (à ignorer par git si voulu), lu par l'extension et par les tools : source (issue/PR/texte), lifecycle, instructions, fraîcheur (`base_commit`, `synced_at`, `file_hashes`) et arbre virtuel (`tree` : virtual dirs imbriqués, `icon` optionnel — sinon codicon déduit du nom). La vue re-render automatiquement quand un agent écrit le YAML (watcher). `sync_workspace` retourne le diff depuis `base_commit` sans appliquer ; `apply_sync` applique le diff validé et met à jour `base_commit`/`file_hashes`.

## Backlog — issues ouvertes (à traiter plus tard)

- **Conflit à l'ajout d'un workspace** : un même sujet peut exister à la fois dans Linear et dans GitHub (ex : une issue GitHub suivie d'un ticket Linear). Aujourd'hui l'anti-doublon ne compare que `type + ref` ; il faudrait détecter les doublons cross-source (même titre / lien croisé) et proposer de fusionner ou de garder les deux.
- **Meilleure explication du mode Smart** : la détection auto (Linear vs GitHub issue vs PR vs texte) n'est documentée nulle part pour l'utilisateur. Ajouter une description claire dans le quick pick / le README du fonctionnement de la détection.

## Development

```bash
npm install
npm run watch
```

Press `F5` in VS Code to launch the Extension Development Host.

## Structure

```
smart-explorer/
├── package.json                  # Extension manifest & contributions
├── tsconfig.json                 # TypeScript config
├── src/
│   ├── extension.ts              # Entry point (activate/deactivate)
│   └── SmartExplorerProvider.ts  # TreeDataProvider implementation
├── resources/
│   └── icon.svg                  # Activity bar icon
└── .vscode/
    └── launch.json               # Debug config
```
