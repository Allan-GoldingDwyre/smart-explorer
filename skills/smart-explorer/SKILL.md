---
name: smart-explorer
description: Load when working on an issue or PR in a repo that has a Smart Explorer MCP server connected (tools list_workspaces, get_workspace, create_workspace, set_links, set_files, delete_workspace, set_active_workspace, focus, add_step, get_walkthrough, delete_walkthrough). Use it to select the files that matter for the user's task and show them as a flat, focused tree in VS Code, and for a guided step-by-step walkthrough ("baby steps", "guide-moi", "explique pas à pas", "explique-moi la PR/l'issue", "review guidée") shown as a page in VS Code with clickable code snippets — for the walkthrough, read walkthrough.md next to this file.
---

# Smart Explorer — focus sur une issue / PR

Smart Explorer garde, par tâche (une ou plusieurs issues, ou une PR), la liste des **fichiers
pertinents** et l'affiche dans VS Code sous forme d'un arbre **plat** : tout ce qui
compte d'un coup d'œil, sans descendre dans des chemins profonds.

**Ton rôle : choisir les bons fichiers.** Le serveur construit l'arbre en _fusionnant_ les
dossiers : il reprend l'arborescence réelle des fichiers que tu donnes, puis remonte les
fichiers des petits dossiers vers leur parent. Les vrais fichiers ne bougent jamais.

## Workflow

1. **Lis la source toi-même** (issue/PR) : `gh pr view` / `gh pr diff`, `gh issue view`,
   ou l'outil web. Le serveur ne la récupère pas.
2. `create_workspace` avec `links` : issues/PR GitHub ou Linear, en URL ou en forme courte
   (`#123`, `owner/repo#123`, `ABC-123`). Issue ou PR est déterminé par `gh` ; un lien non
   résolu est conservé (`unknown`) avec une note. Un workspace peut porter plusieurs issues,
   puis une PR : quand la PR est créée, `set_links { add: ["#456"] }` l'ajoute sans toucher
   aux issues (`remove` pour en retirer). Aucune instruction n'est stockée : le besoin de
   l'utilisateur reste dans la conversation.
3. Choisis les fichiers **pertinents pour ce besoin** : fichiers modifiés, plus ce qui
   est nécessaire pour les comprendre (appelants, types, tests concernés). Pas les
   dépendances transitives.
4. `set_files` avec `files` : la liste de chemins (relatifs à la racine du projet).
   Ne construis pas d'arbre toi-même.
5. `set_active_workspace` pour afficher le workspace dans la vue.

Le résultat indique `files_count`, `folders_count` et `missing_files` (chemins qui
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

- Réglages de `set_files` : `min_folder_files` élevé (ex. 99, avec `max_loose_files`
  élevé) = **liste plate** ; `1` = arborescence réelle simplement compactée. Ils sont
  conservés d'un appel à l'autre. Si l'utilisateur demande une liste plate ou plus de
  structure, règle ces valeurs plutôt que de réduire la liste de fichiers.
- Seuls les chemins de `files` (et les réglages) sont stockés : l'arbre n'existe pas sur
  disque, il est recalculé par la fusion à chaque affichage. Tu ne choisis donc pas les
  dossiers, seulement les fichiers.

## Évolution et maintenance

- `get_workspace` (par défaut l'actif) : liens, fichiers, arbre et fraîcheur `stale`
  (fichiers supprimés, renommés, modifiés ou absents depuis `base_commit`, avec un `hint`).
  **Il ne modifie rien** : c'est à toi de mettre à jour.
- Mise à jour, du plus mécanique au plus fin : `set_files { sync: true }` suit les
  renommages, retire les fichiers supprimés ou absents et avance `base_commit` ; puis, pour
  les fichiers `modified` (à relire) ou nouveaux, `set_files { add, remove }`. `files`
  remplace toute la liste ; `add` / `remove` l'ajustent (pas ensemble).
- `delete_workspace` supprime un workspace.
- `focus` (`path`, `line?`, `end_line?`, `match?`, `workspace_id?`) met un fichier/une plage
  en avant : VS Code l'ouvre à la ligne de début, surligne jusqu'à `end_line` et le sélectionne
  dans l'arbre. Demande ponctuelle : rien à arrêter ensuite.
- **Visite guidée** (page VS Code : intention + macro + extraits cliquables annotés par étape) : `add_step`,
  `get_walkthrough`, `delete_walkthrough`. Quand l'utilisateur demande une visite étape par
  étape (« baby steps », « explique-moi la PR »…), **lis `walkthrough.md`** (dans le même dossier
  que ce fichier) avant de commencer : la visite est un ensemble d'**intentions** de l'issue/PR/prompt
  (`walkthrough_goal`, `intent` par étape, macro + `note` par extrait), puis clarté, granularité
  des extraits, modes, déroulé.

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
