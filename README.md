# Smart Explorer

Un explorateur de fichiers plus intelligent pour VS Code, piloté par un agent IA via MCP.

## Fonctionnalités

- Tree view custom dans l'Activity Bar VS Code
- Arbre plat des fichiers pertinents d'une issue/PR, clic pour ouvrir, bouton refresh
- **Serveur MCP intégré à l'extension** (VS Code ≥ 1.101, déclaré par l'extension et lancé par VS Code) : un agent MCP pilote les workspaces via 18 tools (`list_workspaces`, `get_workspace`, `create_workspace`, `build_tree`, `update_files`, `set_instructions`, `sync_workspace`, `apply_sync`, `check_workspace_files`, `export_context`, `reveal_file`, `stop_following`, `set_active_workspace`, et la visite guidée : `walkthrough_start`, `walkthrough_step`, `walkthrough_reply`, `walkthrough_wait`, `walkthrough_end`). L'extension reste le rendering + registry.
- **Serveur MCP stdio pour clients externes** (Claude Code, Vibe, CLI Mistral — voir ci-dessous) : bundle autonome `smart-explorer-mcp.js`, mêmes 18 tools, logique partagée dans `src/mcp/mcpTools.ts`.
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
cp -r skills/smart-explorer skills/smart-explorer-baby-steps ~/.claude/skills/
# ou niveau projet : .claude/skills/

# Vibe
cp -r skills/smart-explorer skills/smart-explorer-baby-steps ~/.vibe/skills/
```

Le skill (`skills/smart-explorer/SKILL.md`) décrit quand se charger et le workflow standard : lecture de la source par l'agent → `create_workspace` → sélection des fichiers pertinents → `build_tree` → `set_active_workspace`, plus la maintenance (`sync_workspace`, `check_workspace_files`, `apply_sync`, `export_context`).

Le skill `skills/smart-explorer-baby-steps/SKILL.md` décrit la **visite guidée du workspace actif, ancrée sur l'issue/PR**, qui se déroule **entièrement dans VS Code** (le terminal reste quasi silencieux) :

- **Fils de commentaire** (comme Copilot) : chaque étape est un commentaire ancré juste **sous** le code visé (réglage `smartExplorer.walkthrough.commentPosition` : `above` pour le mettre au-dessus) ; l'utilisateur répond dans le fil (ou pose une question sur n'importe quelle ligne via le « + » de la marge) et l'agent répond **dans le même fil**. Boutons **Continuer**, **Précédent** et **Stop** dans l'en-tête du fil. Raccourcis pendant une visite (modifiables dans les raccourcis clavier) : **`ctrl+alt+→`** étape suivante, **`ctrl+alt+←`** étape précédente, **`ctrl+alt+⌫`** arrêter.
- **Étapes en flux** : l'agent annonce un plan (`walkthrough_start`), puis pousse les étapes une à une (`walkthrough_step`) pendant que tu lis la première ; _Continuer_ est géré par VS Code seul (étape déjà arrivée = affichage immédiat, sinon « génération… » puis affichage dès son arrivée). L'avancement (`étape 2/5 …`) est affiché sur la ligne **Following agent** du panneau.
- **Commentaires** : écrits dans un fichier d'événements ; l'agent les récupère avec `walkthrough_wait` (appel bloquant, `timeout_s` ≤ 1800 s, rappelé tant que la visite continue) et répond avec `walkthrough_reply`. Si l'agent génère encore des étapes, `pending_comments` lui signale ton commentaire sans attendre.
- **Repli** : l'extension écrit un signal de vie ; si VS Code n'est pas ouvert sur le projet, `walkthrough_start` répond `ui: false` et l'agent fait la visite dans le terminal.
- **Mode d'affichage** (réglage `smartExplorer.walkthrough.display`) : `vscode` (défaut) = tout dans VS Code ; `cli` = VS Code ne fait que le focus et la sélection (`reveal_file`), les explications sont dans le terminal et tu écris « go » pour continuer ou ta question (`walkthrough_start` répond alors `ui: false, display: "cli"`).

Trois modes : suivre un **flow**, parcourir les **types de changements clés** d'une issue/PR, ou guider une **review** vers les endroits qui méritent l'attention.

## 4. Utilisation

**Depuis VS Code** : la vue Smart Explorer affiche les workspaces du projet ouvert, créés par l'agent. Clic sur un fichier pour l'ouvrir, `revealInExplorer` pour le retrouver dans l'explorateur classique, refresh / rename / add instruction / delete via le menu contextuel ; l'icône corbeille à droite d'un workspace le supprime avec ses données (confirmation demandée). Le fichier ouvert dans l'éditeur est sélectionné automatiquement dans l'arbre s'il fait partie du workspace mis en avant (réglage `smartExplorer.followActiveEditor`, activé par défaut) ; si le fichier appartient à un seul autre workspace du projet, la vue bascule sur celui-ci. Granularité de la mise en avant : sans `line` = fichier entier (rien de sélectionné) ; `line` seule = une ligne, ou seulement le texte `match` (inline) ; `line` + `end_line` = une petite plage, plafonnée à 25 lignes (une seule zone par appel). La ligne **Following agent** et le fichier de la visite dans l'arbre sont en **orange** (couleur `smartExplorer.agentActive`), distincts du fichier sélectionné. Quand l'agent met un fichier en avant (`reveal_file`, ou `focus` de `build_tree`), c'est comme Live Share : le fichier s'ouvre à la ligne de début, la plage de lignes est surlignée avec un CodeLens **Smart Explorer** (+ « Stop following »), et une ligne **Following agent** apparaît au-dessus du workspace actif dans le panneau (clic = retour à la position de l'agent, ✕ = arrêter le suivi). Elle disparaît quand l'agent termine (`stop_following`), quand tu cliques sur Stop (le surlignage part aussi ; le prochain `reveal_file` de l'agent relance simplement le suivi) ou après 30 min d'inactivité ; la commande **Follow agent (resume)** reprend. Avec `diff: { from, to?, from_path?, side? }`, l'agent montre le **diff unifié** (une seule vue, lignes +/−) du fichier entre deux révisions au lieu du code actuel ; il est réservé aux petits changements (≤ 60 lignes modifiées, fichier existant), sinon il est ignoré et le code actuel est montré ; `line`/`end_line` visent le nouveau côté (ou l'ancien avec `side: "old"`). La commande **Smart Explorer: Clean Orphaned Data** supprime les données des projets qui n'existent plus.

**Depuis l'agent** (via les 18 tools MCP) :

1. Lire la source (issue/PR) soi-même (`gh`, web) : le serveur ne la récupère pas.
2. `create_workspace` avec l'URL/texte + `instructions` = le besoin de l'utilisateur (ex. « relire la migration serde »).
3. `build_tree` avec `files` (les chemins pertinents) : le serveur reprend l'arborescence réelle et la **fusionne** — les fichiers des petits dossiers (< `min_folder_files`, défaut 3) remontent au parent, jusqu'à `max_loose_files` (défaut 12) fichiers en vrac ; les dossiers intermédiaires sont absorbés : un dossier sans fichier propre et avec un seul sous-dossier le prend en charge et garde son nom (`apps/backend/src/backend/internal/…` → `src/…`, `back/a/b/c/x` → `back/x`). Les vrais fichiers ne bougent jamais. Alternative : `tree` pour décider soi-même des dossiers. `update_files` ajoute/retire des fichiers (la fusion est rejouée).
   `build_tree` accepte aussi `focus: { path, line?, match? }` pour mettre en avant le fichier/la ligne qui demande l'attention.
4. `set_active_workspace` pour basculer la vue sur cette tâche. `reveal_file` (`path`, `line?`, `end_line?`, `match?`, `diff?`) met aussi en avant le workspace qui contient le fichier (la PR/issue dont parle l'agent) et ouvre un fichier à la bonne ligne dans VS Code et le sélectionne dans l'arbre (`match` = extrait de la ligne, utile si le code a bougé).
5. Maintenance : `sync_workspace` (diff depuis `base_commit`) → `apply_sync` (applique le diff validé), `check_workspace_files` (fichiers introuvables + renames), `export_context` (contenu des fichiers, tronqué à `max_tokens`).

## Données (YAML)

Les workspaces sont de la métadonnée utilisateur : ils ne vivent **pas** dans le projet mais dans le dossier de données de l'utilisateur :

```
~/.local/share/smart-explorer/projects/<nom>-<hash du chemin>/
├── workspaces/<id>.yaml    # un fichier par workspace
├── active                  # workspace affiché dans la vue
├── follow.json             # suivi de l'agent : état + dernière plage mise en avant
├── walkthrough.json        # visite guidée : plan, étapes, réponses de l'agent (écrit par le serveur)
├── walkthrough-events.jsonl# commentaires/navigation de l'utilisateur (écrit par l'extension)
└── ui.json                 # signal de vie de l'extension
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
│   ├── mcpStdio.ts               # Entrée stdio pour clients externes
│   ├── core/                     # Données et logique pures
│   │   ├── workspaceStore.ts     # Store YAML hors projet, fraîcheur, migration
│   │   ├── types.ts
│   │   ├── focus.ts              # Suivi (follow.json)
│   │   ├── treeFusion.ts         # Fusion de dossiers (build_tree files)
│   │   └── treeOps.ts            # Validation/doublons d'un arbre fourni par l'agent
│   ├── mcp/
│   │   ├── mcpSpecs.ts / mcpTools.ts # Définition des 18 tools + logique partagée
│   │   └── mcpServer.ts          # Déclare le serveur MCP à VS Code
│   ├── view/
│   │   ├── SmartExplorerProvider.ts  # TreeDataProvider (vue)
│   │   └── SmartExplorerNode.ts
│   └── walkthrough/
│       ├── walkthrough.ts        # Protocole de fichiers de la visite guidée
│       └── walkthroughController.ts  # Fils de commentaire dans l'éditeur
├── resources/
│   └── icon.svg                  # Activity bar icon
└── .vscode/
    └── launch.json               # Debug config
```
