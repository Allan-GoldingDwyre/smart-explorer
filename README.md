# Smart Explorer

Un explorateur de fichiers plus intelligent pour VS Code, piloté par un agent IA via MCP.

## Fonctionnalités

- Tree view custom dans l'Activity Bar VS Code
- Arbre plat des fichiers pertinents d'une issue/PR, clic pour ouvrir, bouton refresh
- **Serveur MCP intégré à l'extension** (VS Code ≥ 1.101, déclaré par l'extension et lancé par VS Code) : un agent MCP pilote les workspaces via 11 tools (`list_workspaces`, `create_workspace`, `build_tree`, `update_files`, `set_instructions`, `sync_workspace`, `apply_sync`, `check_workspace_files`, `export_context`, `reveal_file`, `set_active_workspace`). L'extension reste le rendering + registry.
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

L'icône **Smart Explorer** apparaît dans l'Activity Bar. L'extension déclare le serveur MCP à VS Code (≥ 1.101, `registerMcpServerDefinitionProvider`) : il est visible dans Chat → MCP Servers, rien à configurer.

## 2. Connecter un agent externe (Claude Code, Vibe, CLI Mistral)

Le serveur intégré à VS Code n'est pas utilisable par un client externe ; on passe par le binaire stdio autonome (le même que celui lancé par l'extension) (Node.js ≥ 18, aucun build nécessaire) :

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

La racine du projet est résolue par ordre : `--root <path>`, variable `SMART_EXPLORER_ROOT`, sinon le répertoire courant du client. `set_active_workspace` écrit le fichier `active` du projet (dans le dossier de données, voir plus bas), lu par l'extension VS Code (la vue bascule toute seule). `reveal_file` retourne le chemin absolu — c'est le client qui ouvre le fichier.

## 3. Activer le skill pour l'agent

Le dossier `skills/` à la racine du repo est volontairement **cross-IA** (pas lié à un outil précis). Pour que ton agent le charge, copie-le dans le répertoire skills de ton agent :

```bash
# Claude Code (niveau user, dispo dans tous les projets)
cp -r skills/smart-explorer ~/.claude/skills/
# ou niveau projet : .claude/skills/smart-explorer/

# Vibe
cp -r skills/smart-explorer ~/.vibe/skills/
```

Le skill (`skills/smart-explorer/SKILL.md`) décrit quand se charger et le workflow standard : lecture de la source par l'agent → `create_workspace` → sélection des fichiers pertinents → `build_tree` → `set_active_workspace`, plus la maintenance (`sync_workspace`, `check_workspace_files`, `apply_sync`, `export_context`).

## 4. Utilisation

**Depuis VS Code** : la vue Smart Explorer affiche les workspaces du projet ouvert, créés par l'agent. Clic sur un fichier pour l'ouvrir, `revealInExplorer` pour le retrouver dans l'explorateur classique, refresh / rename / add instruction / delete via le menu contextuel ; l'icône corbeille à droite d'un workspace le supprime avec ses données (confirmation demandée). La commande **Smart Explorer: Clean Orphaned Data** supprime les données des projets qui n'existent plus.

**Depuis l'agent** (via les 11 tools MCP) :

1. Lire la source (issue/PR) soi-même (`gh`, web) : le serveur ne la récupère pas.
2. `create_workspace` avec l'URL/texte + `instructions` = le besoin de l'utilisateur (ex. « relire la migration serde »).
3. `build_tree` avec `files` (les chemins pertinents) : le serveur reprend l'arborescence réelle et la **fusionne** — les fichiers des petits dossiers (< `min_folder_files`, défaut 3) remontent au parent, jusqu'à `max_loose_files` (défaut 12) fichiers en vrac ; les dossiers intermédiaires sont absorbés : un dossier sans fichier propre et avec un seul sous-dossier le prend en charge et garde son nom (`apps/backend/src/backend/internal/…` → `src/…`, `back/a/b/c/x` → `back/x`). Les vrais fichiers ne bougent jamais. Alternative : `tree` pour décider soi-même des dossiers. `update_files` ajoute/retire des fichiers (la fusion est rejouée).
4. `set_active_workspace` pour basculer la vue sur cette tâche.
5. Maintenance : `sync_workspace` (diff depuis `base_commit`) → `apply_sync` (applique le diff validé), `check_workspace_files` (fichiers introuvables + renames), `export_context` (contenu des fichiers, tronqué à `max_tokens`).

## Données (YAML)

Les workspaces sont de la métadonnée utilisateur : ils ne vivent **pas** dans le projet mais dans le dossier de données de l'utilisateur :

```
~/.local/share/smart-explorer/projects/<nom>-<hash du chemin>/
├── workspaces/<id>.yaml    # un fichier par workspace
└── active                  # workspace affiché dans la vue
```

Dossier de base : `$SMART_EXPLORER_HOME`, sinon `$XDG_DATA_HOME/smart-explorer`, sinon `~/.local/share/smart-explorer` (`%APPDATA%` sous Windows). L'extension et le serveur stdio calculent la même clé de projet (chemin réel du dossier). Un ancien `.smart-explorer/` dans le projet est migré automatiquement au premier lancement.

Chaque YAML contient : source (issue/PR/texte), lifecycle, instructions, fraîcheur (`base_commit`, `synced_at`, `file_hashes`) et arbre virtuel (`tree`). Les virtual dirs héritent des icônes de dossier du thème d'icônes actif d'après leur nom ; `icon` (codicon) n'est qu'un override optionnel. La vue se re-render automatiquement quand un agent écrit un fichier (watcher).

Chaque tag `v*.*.*` publie une GitHub Release (`.github/workflows/release.yml`) avec le `.vsix` de l'extension, le bundle `smart-explorer-mcp.js` et `install.sh`.

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
│   ├── SmartExplorerProvider.ts  # TreeDataProvider (vue)
│   ├── workspaceStore.ts         # Store YAML hors projet, fraîcheur, migration
│   ├── treeFusion.ts             # Fusion de dossiers (build_tree files)
│   ├── treeOps.ts                # Validation/doublons d'un arbre fourni par l'agent
│   ├── mcpSpecs.ts / mcpTools.ts # Définition des 11 tools + logique partagée
│   ├── mcpServer.ts              # Déclare le serveur MCP à VS Code
│   └── mcpStdio.ts               # Entrée stdio pour clients externes
├── resources/
│   └── icon.svg                  # Activity bar icon
└── .vscode/
    └── launch.json               # Debug config
```
