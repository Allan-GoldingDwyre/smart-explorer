---
name: smart-explorer
description: Load when working on an issue or PR in a repo that has a Smart Explorer MCP server connected (tools list_workspaces, get_workspace, create_workspace, build_tree, update_files, set_instructions, sync_workspace, apply_sync, check_workspace_files, export_context, reveal_file, stop_following, set_active_workspace). Use it to select the files that matter for the user's task and show them as a flat, focused tree in VS Code.
---

# Smart Explorer — focus sur une issue / PR

Smart Explorer garde, par tâche (issue, PR ou texte), la liste des **fichiers
pertinents** et l'affiche dans VS Code sous forme d'un arbre **plat** : tout ce qui
compte d'un coup d'œil, sans descendre dans des chemins profonds.

**Ton rôle : choisir les bons fichiers.** Le serveur construit l'arbre en _fusionnant_ les
dossiers : il reprend l'arborescence réelle des fichiers que tu donnes, puis remonte les
fichiers des petits dossiers vers leur parent. Les vrais fichiers ne bougent jamais.

## Workflow

1. **Lis la source toi-même** (issue/PR) : `gh pr view` / `gh pr diff`, `gh issue view`,
   ou l'outil web. Le serveur ne la récupère pas.
2. `create_workspace` avec l'URL (ou le texte) et `instructions` = **le besoin de
   l'utilisateur** sur cette issue/PR (« relire la migration serde », « corriger le bug
   d'export »…). Ce n'est pas une consigne d'organisation de dossiers.
3. Choisis les fichiers **pertinents pour ce besoin** : fichiers modifiés, plus ce qui
   est nécessaire pour les comprendre (appelants, types, tests concernés). Pas les
   dépendances transitives.
4. `build_tree` avec `files` : la liste de chemins (relatifs à la racine du projet).
   Ne construis pas d'arbre toi-même.
5. `set_active_workspace` pour afficher le workspace dans la vue.
6. Optionnel : passe `focus: { path, line?, match? }` à `build_tree` pour mettre en avant
   le fichier/la ligne qui demande l'attention : VS Code l'ouvre à cet endroit et le
   sélectionne dans l'arbre.

Le résultat indique `mode`, `files_count`, `folders_count` et `missing_files` (chemins qui
n'existent pas : corrige-les).

## Ce que fait la fusion (de bas en haut)

- Un dossier dont le sous-arbre contient **moins de `min_folder_files` fichiers** (défaut 3) est dissous : ses fichiers remontent au dossier parent.
- On **s'arrête** quand le parent dépasserait `max_loose_files` fichiers en vrac (défaut 12) : pas de longue liste plate.
- Un dossier sans fichier propre et avec un seul sous-dossier **absorbe** ce sous-dossier
  (il garde son nom) : `back/a/b/c/x` devient `back/x`,
  `apps/backend/src/backend/internal/{x, services/s/y}` devient `src/{x, services/{y}}`.
  Les dossiers « conteneurs » sans fichier disparaissent, racine comprise.
- Aucun fichier n'apparaît deux fois.

## Garder la main

- Réglages de `build_tree` : `min_folder_files` élevé (ex. 99, avec `max_loose_files`
  élevé) = **liste plate** ; `1` = arborescence réelle simplement compactée. Si
  l'utilisateur demande une liste plate ou plus de structure, règle ces valeurs plutôt que
  de réduire la liste de fichiers.
- `tree` à la place de `files` : tu décides toi-même des dossiers et de la place de chaque
  fichier (`{ files?, dirs?: [{ name, files?, dirs? }] }`). À réserver au cas où la
  structure réelle ne reflète pas la logique de la tâche. Le serveur retire seulement les
  doublons et les dossiers vides. Donne `files` OU `tree`, jamais les deux.

## Évolution et maintenance

- `update_files` (`add` / `remove`) pour ajuster sans tout renvoyer : avec un arbre
  fusionné, la fusion est rejouée sur la nouvelle liste. Avec un arbre `tree`, `into`
  désigne le dossier qui reçoit les fichiers ajoutés (créé si besoin, ex.
  `"backend/storage"`) ; le reste de l'arbre est conservé.
- `sync_workspace` → diff depuis `base_commit` (added / modified / deleted / renamed,
  fichiers dont le hash a dérivé). `apply_sync` applique ce que l'utilisateur valide
  (`accepted[]` / `rejected[]`) et remet `base_commit` à jour.
- `get_workspace` lit un workspace (par défaut l'actif) : source, besoin de l'utilisateur
  (`instructions`), fichiers et arbre.
- `reveal_file` (`path`, `line?`, `end_line?`, `match?`, `workspace_id?`) met un fichier/une plage
  en avant : VS Code l'ouvre à la ligne de début, surligne jusqu'à `end_line` et le sélectionne
  dans l'arbre ; `stop_following` termine ce suivi.
  Pour une visite guidée étape par étape, utilise le skill `smart-explorer-baby-steps`.
- `check_workspace_files` → chemins introuvables + candidats (renommages).
- `export_context` (`max_tokens?`) → contenu des fichiers du workspace.

## Règles

- Pas d'icônes à fournir : l'extension applique le thème d'icônes VS Code de
  l'utilisateur (Material, etc.), y compris aux dossiers, d'après leur nom.
- Les données (workspaces) sont stockées hors du projet, dans le dossier de données de
  l'utilisateur (`~/.local/share/smart-explorer/`). Ne touche jamais aux fichiers à la main.

## Transports MCP

- **Dans VS Code ≥ 1.101** : l'extension déclare le serveur et VS Code le lance
  (Chat → MCP Servers). Rien à configurer.
- **Client externe (Vibe, Claude Code CLI, CLI Mistral, macOS/Linux)** : serveur stdio
  autonome, à installer via
  `curl -fsSL https://raw.githubusercontent.com/Allan-GoldingDwyre/smart-explorer/main/install.sh | bash`,
  puis bloc `smart-explorer` dans le `.mcp.json` du client (voir README). La racine du
  projet se résout via `--root`, `SMART_EXPLORER_ROOT`, ou le cwd du client.
