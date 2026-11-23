# Smart Explorer

Un explorateur de fichiers plus intelligent pour VS Code, piloté par un agent IA via MCP.

## Fonctionnalités

- Tree view custom dans l'Activity Bar VS Code
- Arbre plat des fichiers pertinents d'une issue/PR, clic pour ouvrir, bouton refresh
- **Serveur MCP intégré à l'extension** (VS Code ≥ 1.101, déclaré par l'extension et lancé par VS Code) : un agent MCP pilote les workspaces via 11 tools (`list_workspaces`, `get_workspace`, `create_workspace`, `set_links`, `set_files`, `delete_workspace`, `set_active_workspace`, `focus`, et la visite guidée : `add_step`, `get_walkthrough`, `delete_walkthrough`). L'extension reste le rendering + registry.
- **Serveur MCP stdio pour clients externes** (Claude Code, Vibe, CLI Mistral — voir ci-dessous) : bundle autonome `smart-explorer-mcp.js`, mêmes 11 tools, définitions dans `src/mcp/mcpSpecs.ts`.
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

## 2. Installation en une commande (extension + MCP + skills)

```bash
curl -fsSL https://raw.githubusercontent.com/Allan-GoldingDwyre/smart-explorer/main/install.sh | bash
```

Le script (Node.js ≥ 18) télécharge la dernière release, puis :

- installe l'**extension VS Code** (`code --install-extension`) ;
- détecte tes agents (**Claude Code**, **Vibe**) et te demande pour lesquels brancher le **serveur MCP** et les **skills** (tout en global, niveau user : `claude mcp add --scope user`, bloc `[[mcp_servers]]` dans `~/.vibe/config.toml`, skills dans `~/.claude/skills` / `~/.vibe/skills`).

Options : `--yes` (tous les agents détectés, sans question), `--agents claude,vibe`, `--uninstall` (retire extension, MCP et skills). Relancer le script met à jour sans créer de doublon. Fichiers téléchargés : `~/.local/share/smart-explorer/`.

Le serveur stdio est un binaire autonome (`smart-explorer-mcp.js`) : l'extension déclare déjà son propre serveur à VS Code, celui-ci sert aux clients externes. À la main, depuis les sources : `npm ci && npm run build:mcp`, puis déclare `node dist/smart-explorer-mcp.js` dans le `.mcp.json` de ton client (ou `out/mcpStdio.js` après `npm run compile`).

La racine du projet est résolue par ordre : `--root <path>`, variable `SMART_EXPLORER_ROOT`, sinon le répertoire courant du client. `set_active_workspace` écrit le fichier `active` du projet (dans le dossier de données, voir plus bas), lu par l'extension VS Code (la vue bascule toute seule). `focus` retourne le chemin absolu ; l'extension ouvre le fichier à la ligne demandée.

## 3. Activer le skill pour l'agent

_Fait automatiquement par `install.sh` (section 2) ; à la main :_

Le dossier `skills/` à la racine du repo est volontairement **cross-IA** (pas lié à un outil précis). Pour que ton agent le charge, copie-le dans le répertoire skills de ton agent :

```bash
# Claude Code (niveau user, dispo dans tous les projets)
cp -r skills/smart-explorer ~/.claude/skills/
# ou niveau projet : .claude/skills/

# Vibe
cp -r skills/smart-explorer ~/.vibe/skills/
```

Le skill (`skills/smart-explorer/SKILL.md`) décrit quand se charger et le workflow standard : lecture de la source par l'agent → `create_workspace` (liens issues/PR) → sélection des fichiers pertinents → `set_files` → `set_active_workspace`, plus la maintenance (`get_workspace` signale ce qui est périmé, `set_files { sync: true }` applique la partie mécanique).

Le fichier `skills/smart-explorer/walkthrough.md` (lu par l'agent à la demande, depuis le skill `smart-explorer`) décrit la **visite guidée du workspace actif, ancrée sur l'issue/PR** : une **page dans VS Code** (l'aperçu markdown natif, rien de recréé) :

- **Une page par visite** : titre, puis pour chaque étape une explication concise et des **extraits de code cliquables** (un clic ouvre le fichier à la ligne dans l'éditeur). L'extrait est figé à la création de l'étape.
- **Étapes en flux** : l'agent ajoute les étapes une à une avec `add_step` ; la page s'ouvre à la première (commande **Open Walkthrough**, ou bouton livre dans la vue) puis se met à jour toute seule pendant que tu lis. `get_walkthrough` relit l'état, `delete_walkthrough` repart de zéro.
- **Questions** : tu les poses à l'agent dans le terminal ; il te répond et met l'étape concernée à jour (`add_step` avec son `step_id`, l'étape est remplacée sur place).

Trois modes : suivre un **flow**, parcourir les **types de changements clés** d'une issue/PR, ou guider une **review** vers les endroits qui méritent l'attention.

## 4. Utilisation

**Depuis VS Code** : la vue Smart Explorer affiche les workspaces du projet ouvert, créés par l'agent. Clic sur un fichier pour l'ouvrir, `revealInExplorer` pour le retrouver dans l'explorateur classique, refresh / rename / delete via le menu contextuel ; l'icône corbeille à droite d'un workspace le supprime avec ses données (confirmation demandée). Le fichier ouvert dans l'éditeur est sélectionné automatiquement dans l'arbre s'il fait partie du workspace mis en avant (réglage `smartExplorer.followActiveEditor`, activé par défaut) ; si le fichier appartient à un seul autre workspace du projet, la vue bascule sur celui-ci. Granularité de la mise en avant : sans `line` = fichier entier (rien de sélectionné) ; `line` seule = une ligne, ou seulement le texte `match` (inline) ; `line` + `end_line` = une petite plage, plafonnée à 25 lignes (une seule zone par appel). Quand l'agent appelle `focus` (`path`, `line?`, `end_line?`, `match?`, `diff?`), le fichier s'ouvre à la ligne de début et la plage est surlignée ; c'est une demande ponctuelle, sans session à arrêter. Avec `diff: { from, to?, from_path?, side? }`, il montre le **diff unifié** (une seule vue, lignes +/−) du fichier entre deux révisions au lieu du code actuel ; il est réservé aux petits changements (≤ 60 lignes modifiées, fichier existant), sinon il est ignoré et le code actuel est montré ; `line`/`end_line` visent le nouveau côté (ou l'ancien avec `side: "old"`). La commande **Smart Explorer: Clean Orphaned Data** supprime les données des projets qui n'existent plus.

**Depuis l'agent** (via les 14 tools MCP) :

1. Lire la source (issue/PR) soi-même (`gh`, web) : le serveur ne la récupère pas.
2. `create_workspace` avec `links` : issues/PR GitHub ou Linear (URL ou forme courte `#123`, `owner/repo#123`, `ABC-123` ; issue ou PR déterminé par `gh`). Un workspace peut porter plusieurs issues puis une PR : `set_links` ajoute/retire des liens sans toucher aux autres.
3. `set_files` avec `files` (les chemins pertinents) : le serveur reprend l'arborescence réelle et la **fusionne** — les fichiers des petits dossiers (< `min_folder_files`, défaut 3) remontent au parent, jusqu'à `max_loose_files` (défaut 12) fichiers en vrac ; les dossiers intermédiaires sont absorbés : un dossier sans fichier propre et avec un seul sous-dossier le prend en charge et garde son nom (`apps/backend/src/backend/internal/…` → `src/…`, `back/a/b/c/x` → `back/x`). Les vrais fichiers ne bougent jamais. `add` / `remove` ajustent la liste ; `sync: true` suit les renommages et retire les fichiers supprimés.
4. `set_active_workspace` pour basculer la vue sur cette tâche. `focus` (`path`, `line?`, `end_line?`, `match?`, `diff?`) met aussi en avant le workspace qui contient le fichier (la PR/issue dont parle l'agent), ouvre le fichier à la bonne ligne dans VS Code et le sélectionne dans l'arbre (`match` = extrait de la ligne, utile si le code a bougé).
5. Maintenance : `get_workspace` rapporte la fraîcheur (`stale` : fichiers supprimés, renommés, modifiés ou absents depuis `base_commit`) sans rien modifier ; l'agent met à jour via `set_files` (`sync: true` pour le mécanique, puis `add` / `remove`). `delete_workspace` supprime un workspace.

## Données (YAML)

Les workspaces sont de la métadonnée utilisateur : ils ne vivent **pas** dans le projet mais dans le dossier de données de l'utilisateur :

```
~/.local/share/smart-explorer/projects/<nom>-<hash du chemin>/
├── workspaces/<id>.yaml    # un fichier par workspace
├── active                  # workspace affiché dans la vue
├── focus.json              # dernière demande `focus` de l'agent
├── walkthrough.json        # visite guidée : titre, étapes, extraits (écrit par le serveur)
└── walkthrough.md          # page de la visite, rendue depuis le JSON (aperçu markdown)
```

Dossier de base : `$SMART_EXPLORER_HOME`, sinon `$XDG_DATA_HOME/smart-explorer`, sinon `~/.local/share/smart-explorer` (`%APPDATA%` sous Windows). L'extension et le serveur stdio calculent la même clé de projet (chemin réel du dossier). Un ancien `.smart-explorer/` dans le projet est migré automatiquement au premier lancement.

Chaque YAML contient : `name`, `links` (issues/PR : `kind`, `ref`, `title?`, `url?`), `base_commit` (HEAD à la dernière validation de la liste) et la liste des fichiers pertinents (`files`, + `fusion` si les réglages diffèrent des défauts) ; l'arbre affiché n'est pas stocké, il est recalculé par la fusion à chaque rendu. Les virtual dirs héritent des icônes de dossier du thème d'icônes actif d'après leur nom. La vue se re-render automatiquement quand un agent écrit un fichier (watcher).

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
│   ├── mcpStdio.ts               # Entrée stdio pour clients externes
│   ├── core/                     # Données et logique pures
│   │   ├── workspaceStore.ts     # Store YAML hors projet, liens, fichiers
│   │   ├── types.ts
│   │   ├── focus.ts              # Zone à mettre en avant (focus)
│   │   ├── treeFusion.ts         # Fusion de dossiers (arbre affiché, recalculé)
│   │   └── treeOps.ts            # Normalisation des chemins
│   ├── mcp/
│   │   ├── mcpSpecs.ts           # Définition des tools
│   │   ├── workspaceTools.ts / focusTools.ts / walkthroughTools.ts # Logique des tools
│   │   ├── toolEnv.ts            # Contexte partagé
│   │   └── mcpServer.ts          # Déclare le serveur MCP à VS Code
│   ├── view/
│   │   ├── SmartExplorerProvider.ts  # TreeDataProvider (vue)
│   │   └── SmartExplorerNode.ts
│   └── walkthrough/
│       ├── walkthrough.ts        # Visite guidée : état JSON + page markdown
├── resources/
│   └── icon.svg                  # Activity bar icon
└── .vscode/
    └── launch.json               # Debug config
```
