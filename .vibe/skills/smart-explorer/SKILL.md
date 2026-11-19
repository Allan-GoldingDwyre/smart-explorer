---
name: smart-explorer
description: Load when working on a task in a repo that has a Smart Explorer MCP server connected (tools list_workspaces, create_workspace, fetch_source, build_tree, sync_workspace, apply_sync, check_workspace_files, export_context, reveal_file, set_active_workspace). Use it to organize the task's relevant files into a virtual workspace tree that the user sees in VS Code.
---

# Smart Explorer — workspaces à arbre virtuel

Smart Explorer garde, par tâche (issue/PR/texte), une liste de **fichiers primaires**
groupés en **virtual dirs** dans un fichier YAML par workspace
(`.smart-explorer/workspaces/<id>.yaml`). L'extension VS Code affiche cet arbre ;
toi (l'agent) tu produis le contenu via les tools MCP.

## Workflow standard d'une tâche

1. `create_workspace` avec la source (URL issue/PR GitHub ou Linear, ou texte).
   Optionnel : `instructions` (ex. "grouper par logique métier, utils, déploiement").
2. `fetch_source` sur la ref → titre, description, fichiers modifiés (PR), SHA.
3. Lis le graphe d'imports du repo (ts-morph / AST) et sélectionne **uniquement les
   fichiers primaires** de la tâche (10–20, pas les dépendances transitives).
4. Groupe-les en virtual dirs selon les instructions (logique métier / utils /
   déploiement / front / AI agents…), sous-groupes si un groupe est gros.
5. `build_tree` avec l'arbre : `{ name: ".", dirs: [{ name, icon?, files[], dirs[] }] }`.
   La vue VS Code se re-render toute seule.
6. `set_active_workspace` pour basculer la vue sur cette tâche.

## Maintenance (fraîcheur)

- `sync_workspace` → diff depuis `base_commit` (added/modified/deleted/renamed)
  - fichiers dont le hash a dérivé. Ne re-évalue **que** les fichiers changés.
- `check_workspace_files` → chemins introuvables + candidats fuzzy (renames).
- `apply_sync` avec `accepted[]` / `rejected[]` → applique le diff validé et met à
  jour `base_commit` / `file_hashes`.
- `export_context` (`primary` | `with_dependencies`, `max_tokens?`) → exporte le
  contexte pour toi-même.

## Règles du format YAML (écrit via build_tree, ne touche pas le disque à la main)

- `tree` = virtual dirs imbriqués : `name` (requis), `icon` (codicon, optionnel),
  `files` (chemins relatifs au repo), `dirs` (sous-groupes). Rien d'autre.
- Pas d'icône sur les fichiers : l'extension applique le thème d'icônes VS Code.
- Virtual dir sans `icon` : l'extension déduit un codicon du nom
  (test→beaker, front→browser, agent/llm→robot, etc.).

## Transports MCP

- **Dans VS Code ≥ 1.99** : serveur in-process (`vscode.createMcpServer`), visible
  dans Chat → MCP Servers. Rien à configurer.
- **Client externe (Vibe, Claude Code CLI, CLI Mistral, macOS/Linux)** : serveur
  stdio autonome, à installer via
  `curl -fsSL https://raw.githubusercontent.com/<owner>/smart-explorer/main/install.sh | bash`,
  puis bloc `smart-explorer` dans le `.mcp.json` du client (voir README). La racine
  du projet se résout via `--root`, `SMART_EXPLORER_ROOT`, ou le cwd du client.
