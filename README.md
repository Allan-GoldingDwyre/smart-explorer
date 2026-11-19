# Smart Explorer

Un explorateur de fichiers plus intelligent pour VS Code, piloté par un agent IA via MCP.

## Fonctionnalités

- Tree view custom dans l'Activity Bar VS Code
- Parcours des fichiers/dossiers du workspace, clic pour ouvrir, bouton refresh
- **Serveur MCP hébergé par l'extension** (VS Code ≥ 1.99, `vscode.createMcpServer`, démarré à l'activation) : un agent MCP pilote les workspaces via 11 tools (`list_workspaces`, `create_workspace`, `fetch_source`, `build_tree`, `set_instructions`, `sync_workspace`, `apply_sync`, `check_workspace_files`, `export_context`, `reveal_file`, `set_active_workspace`). L'extension reste le rendering + registry.
- **Serveur MCP stdio pour clients externes** (Claude Code, Vibe, CLI Mistral — voir ci-dessous) : bundle autonome `smart-explorer-mcp.js`, mêmes 11 tools, logique partagée dans `src/mcpTools.ts`.
- **Skill agent** cross-IA dans `skills/smart-explorer/SKILL.md` : documente le workflow complet pour n'importe quel agent MCP.

## 1. Installer l'extension dans VS Code

Depuis une release (recommandé) :

```bash
# Télécharger smart-explorer-<version>.vsix depuis la dernière GitHub Release
# puis dans VS Code : Extensions (Ctrl+Shift+X) → "..." → "Install from VSIX..."
```

Depuis les sources :

```bash
git clone https://github.com/Allan-GoldingDwyre/smart-explorer.git
cd smart-explorer
npm ci
npx vsce package        # produit smart-explorer-<version>.vsix
# puis "Install from VSIX..." comme ci-dessus
```

L'icône **Smart Explorer** apparaît dans l'Activity Bar. Le serveur MCP in-process démarre automatiquement à l'activation (visible dans Chat → MCP Servers, rien à configurer).

## 2. Connecter un agent externe (Claude Code, Vibe, CLI Mistral)

Le serveur in-process de VS Code n'est pas spawné par un client externe ; on passe par le binaire stdio autonome (Node.js ≥ 18, aucun build nécessaire) :

```bash
curl -fsSL https://raw.githubusercontent.com/Allan-GoldingDwyre/smart-explorer/main/install.sh | bash
# installe ~/.local/share/smart-explorer/smart-explorer-mcp.js
```

Puis ajoute dans le `.mcp.json` à la racine du projet client (lu par Claude Code, Vibe, etc.) :

```json
{
  "mcpServers": {
    "smart-explorer": {
      "command": "node",
      "args": ["/Users/<toi>/.local/share/smart-explorer/smart-explorer-mcp.js"]
    }
  }
}
```

Depuis les sources sans install.sh : `npm ci && npm run build:mcp`, puis pointe `args` vers `dist/smart-explorer-mcp.js` (ou `out/mcpStdio.js` après `npm run compile`).

La racine du projet est résolue par ordre : `--root <path>`, variable `SMART_EXPLORER_ROOT`, sinon le répertoire courant du client. `set_active_workspace` écrit `.smart-explorer/active`, lu par l'extension VS Code (la vue bascule toute seule). `reveal_file` retourne le chemin absolu — c'est le client qui ouvre le fichier.

## 3. Activer le skill pour l'agent

Le dossier `skills/` à la racine du repo est volontairement **cross-IA** (pas lié à un outil précis). Pour que ton agent le charge, copie-le dans le répertoire skills de ton agent :

```bash
# Claude Code (niveau user, dispo dans tous les projets)
cp -r skills/smart-explorer ~/.claude/skills/
# ou niveau projet : .claude/skills/smart-explorer/

# Vibe
cp -r skills/smart-explorer ~/.vibe/skills/
```

Le skill (`skills/smart-explorer/SKILL.md`) décrit quand se charger et le workflow standard : `create_workspace` → `fetch_source` → sélection des fichiers primaires → `build_tree` → `set_active_workspace`, plus la maintenance (`sync_workspace`, `check_workspace_files`, `apply_sync`, `export_context`).

## 4. Utilisation

**Depuis VS Code** : clic sur **+** (Add Workspace) dans la vue Smart Explorer, saisis une issue/PR GitHub ou Linear (ou du texte), l'arbre virtuel se construit et s'affiche. Clic sur un fichier pour l'ouvrir, `revealInExplorer` pour le retrouver dans l'explorateur classique, refresh/rename/delete via les icônes.

**Depuis l'agent** (via les 11 tools MCP) :

1. `create_workspace` avec la source + `instructions` optionnelles (ex. "grouper par logique métier, utils, déploiement").
2. `fetch_source` → titre, description, fichiers modifiés (PR), SHA.
3. `build_tree` avec l'arbre de virtual dirs (`{ name: ".", dirs: [{ name, icon?, files[], dirs[] }] }`) → la vue VS Code se re-render toute seule.
4. `set_active_workspace` pour basculer la vue sur cette tâche.
5. Maintenance : `sync_workspace` (diff depuis `base_commit`) → `apply_sync` (applique le diff validé), `check_workspace_files` (fichiers introuvables + renames), `export_context` (exporte le contexte pour l'agent).

## État partagé (YAML)

Un fichier par workspace dans `.smart-explorer/workspaces/<id>.yaml` (à ignorer par git si voulu), lu par l'extension et par les tools : source (issue/PR/texte), lifecycle, instructions, fraîcheur (`base_commit`, `synced_at`, `file_hashes`) et arbre virtuel (`tree` : virtual dirs imbriqués, `icon` optionnel — sinon codicon déduit du nom). La vue re-render automatiquement quand un agent écrit le YAML (watcher). `sync_workspace` retourne le diff depuis `base_commit` sans appliquer ; `apply_sync` applique le diff validé et met à jour `base_commit`/`file_hashes`.

Chaque tag `v*.*.*` publie une GitHub Release (`.github/workflows/release.yml`) avec le `.vsix` de l'extension, le bundle `smart-explorer-mcp.js` et `install.sh`.

## Backlog — issues ouvertes (à traiter plus tard)

- **Conflit à l'ajout d'un workspace** : un même sujet peut exister à la fois dans Linear et dans GitHub (ex : une issue GitHub suivie d'un ticket Linear). Aujourd'hui l'anti-doublon ne compare que `type + ref` ; il faudrait détecter les doublons cross-source (même titre / lien croisé) et proposer de fusionner ou de garder les deux.
- **Meilleure explication du mode Smart** : la détection auto (Linear vs GitHub issue vs PR vs texte) n'est documentée nulle part pour l'utilisateur. Ajouter une description claire dans le quick pick / le README du fonctionnement de la détection.

## Development

```bash
npm install
npm run watch
```

Press `F5` in VS Code to launch the Extension Development Host.

```bash
npm test          # compile + tests unitaires (node --test)
npm run lint
```

## Structure

```
smart-explorer/
├── package.json                  # Extension manifest & contributions
├── tsconfig.json                 # TypeScript config
├── install.sh                    # Installe le serveur MCP stdio (curl | bash)
├── skills/
│   └── smart-explorer/
│       └── SKILL.md              # Skill cross-IA pour agents MCP externes
├── src/
│   ├── extension.ts              # Entry point (activate/deactivate)
│   ├── SmartExplorerProvider.ts  # TreeDataProvider implementation
│   ├── mcpServer.ts / mcpTools.ts# Serveur MCP in-process + logique partagée (11 tools)
│   └── mcpStdio.ts               # Entrée stdio pour clients externes
├── resources/
│   └── icon.svg                  # Activity bar icon
└── .vscode/
    └── launch.json               # Debug config
```
