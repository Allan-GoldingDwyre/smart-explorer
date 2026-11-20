---
name: smart-explorer-baby-steps
description: Load when the user asks for a guided, step-by-step walkthrough ("baby steps", "guide-moi", "explique pas à pas", "étape par étape", "explique-moi la PR/l'issue", "walkthrough", "review guidée") of the ACTIVE Smart Explorer workspace, on a repo that has the Smart Explorer MCP server connected. The walkthrough happens INSIDE VS Code (explanations as comment threads above the code, the user replies in the thread), anchored on the workspace's issue/PR. Three modes — follow a flow, walk through the key changes, or guide a reviewer to the spots that deserve attention. Steps are streamed one by one while the user reads the first.
---

# Smart Explorer — baby steps (dans VS Code)

Le but : que la personne comprenne **ce que veut l'issue/PR ET le code qui y répond**, vite.
Périmètre : **le workspace actif**. Chaque étape relie une attente de l'issue/PR à un endroit du code.

**Tout se passe dans VS Code** : chaque étape est un fil de commentaire au-dessus de la ligne
(façon Copilot), l'utilisateur clique _Continuer_ ou écrit une question **dans le fil**, et tu
réponds **dans le même fil**. Le terminal reste quasi silencieux.

## Concision (règle n°1)

**Écris le minimum.** Tu es un guide qui montre du doigt, pas un cours.

- **Une étape = 1 à 2 phrases, ~40 mots maximum.** Une seule idée.
- Pas de préambule, pas de reformulation, pas de paraphrase du code, pas de listes ni de titres
  dans le texte d'une étape.
- Dis : _ce que l'issue/PR attend ici_ → _ce que fait le code_, ou ce qui cloche.
- **Ne décris pas ce que l'écran montre déjà** : dis le _pourquoi_ et l'_impact_, pas le _quoi_.
- Réponse à une question dans un fil : 1 à 3 phrases, directes.
- Terminal : **une ligne au début, une à la fin**. Rien d'autre.

Trop long : « Pour les dates en UTC, la PR n'a pas besoin de logique particulière. Les champs
passent de DateTime<Utc> à Timestamp, Utc::now() devient Timestamp::now()… » (le code le montre).
Bien : « Dates toujours en UTC : serde par défaut de jiff, le module maison disparaît. À vérifier :
même format que l'ancien (Z, fraction sans zéros de fin). »

## Quoi sélectionner (la granularité la plus fine)

Une étape met en avant **une seule zone continue**, la plus petite qui suffit :

- **Pas de `line`** : tu parles du **fichier entier**. Rien n'est sélectionné.
- **`line` seule** : une ligne précise. Ajoute **`match`** (le texte exact) pour ne surligner
  **que ce texte** : c'est l'« inline », pour un point précis (un appel, un nom).
- **`line` + `end_line`** : **une petite plage** : une partie de fonction ou une petite
  fonction (25 lignes au maximum, le serveur plafonne). Jamais un gros bloc.

Jamais un fichier entier sélectionné, ni une plage qui **englobe deux exemples** : deux exemples
= **deux étapes**. Lis le fichier avant de donner `line`/`end_line`, et ajoute `match`.

## Code actuel ou diff ? (le diff est l'exception)

- **Code actuel** (par défaut) : quand l'explication porte sur **ce que fait le code**.
- **Diff** seulement quand le **changement lui-même** est le sujet **et qu'il est petit** (un
  remplacement net, quelques lignes supprimées, un avant/après court). Le serveur l'ignore
  (et montre le code actuel) au-delà de 60 lignes, pour un fichier nouveau ou sans changement.
  Au plus une ou deux étapes d'une visite. Il s'ouvre en **une seule vue** (+/−).
  `diff: { from, to? }` (`from` = base de la PR, `to` = tête ; absent = code actuel) ;
  `side: "old"` vise l'ancien côté, `from_path` si le fichier a été renommé.
  Révisions d'une PR : `gh pr view <n> --json baseRefOid,headRefOid`.
- En cas de doute : code actuel.

## Choisir le mode

| Mode        | Quand                               | Une étape =                                                                   |
| ----------- | ----------------------------------- | ----------------------------------------------------------------------------- |
| **flow**    | « comment ça marche »               | un maillon du flux touché par l'issue/PR, dans l'ordre d'exécution            |
| **changes** | « que demande / qu'a changé la PR » | un **type** de changement, relié à la demande (pas chaque modification)       |
| **review**  | « aide-moi à relire »               | un endroit qui **mérite** l'attention, jugé par rapport à l'objectif de la PR |

« Explique-moi la PR/l'issue » (pas à pas) sans précision = **changes**, sans poser de question.

## Déroulé

1. **Bon workspace** (silencieux) : si l'utilisateur parle d'une PR/issue précise (ex. #326,
   ARCHON-118), `list_workspaces` puis `set_active_workspace` sur celui dont `source_url`
   correspond. Puis `get_workspace` (URL, `instructions` = son besoin, `files`). **Lis
   l'issue/PR toi-même** (`gh pr view` / `gh pr diff` / `gh issue view`) et les fichiers utiles.
2. **Plan** : décide des étapes (5 à 8 titres courts), sans les rédiger.
3. **`walkthrough_start`** avec `mode`, `title` (ex. « PR #326 : chrono → jiff ») et `outline`
   (les titres). Écris **une ligne** dans le terminal : « Visite lancée dans VS Code (N étapes). »
   - Si `ui` vaut **false** : VS Code n'est pas ouvert sur ce projet → **mode terminal**
     (voir plus bas).
4. **Pousse les étapes une à une** avec `walkthrough_step` (`title`, `text`, `path`, zone, `diff`
   éventuel, `last: true` sur la dernière). **Dès que l'étape 1 est prête, envoie-la** puis
   enchaîne sur la suivante sans attendre : l'utilisateur la lit pendant que tu génères le reste.
   - Si la réponse contient `pending_comments` : l'utilisateur a écrit pendant ce temps → réponds
     avec `walkthrough_reply` (au `thread` indiqué), puis reprends.
   - Si elle contient `stopped: true` : l'utilisateur a arrêté → `walkthrough_end`, fin.
   - Si elle contient `notes` : un garde-fou a corrigé ta demande (plage plafonnée, diff
     ignoré) : tiens-en compte pour les étapes suivantes.
5. **Attends l'utilisateur** : `walkthrough_wait` (bloquant, **sans rien écrire dans le terminal**).
   - `events` avec un `comment` : réponds dans le fil avec `walkthrough_reply` (`thread` de
     l'événement), courtes phrases, puis rappelle `walkthrough_wait`. Si le commentaire est
     posé sur une ligne (`path`, `line`) hors de ta visite, réponds-y de même.
   - `idle: true` : rien de nouveau, rappelle `walkthrough_wait` (silencieusement).
   - `status: "ended"` : l'utilisateur a terminé ou arrêté → étape 6.
     _Continuer / Précédent sont gérés par VS Code seul : ils ne te réveillent pas._
6. **Fin** : `walkthrough_end`, puis **une ligne** de récap dans le terminal.

## Règles par mode

**flow** — pars du point d'entrée du flux concerné. Une étape par saut. Dis en quoi l'issue/PR
change ce maillon ou s'y appuie. Branches secondaires : une phrase, sans détail.

**changes** — regroupe par **type** (« migration chrono → jiff », « nouveau schéma », « tests
adaptés »), jamais par fichier. Par type : le lien avec la demande, un endroit représentatif,
les autres endroits en une ligne dans le texte, l'impact en une phrase.

**review** — juge le code **par rapport à l'objectif de la PR** : manque, écart. Ne retiens que
ce qui demande un regard humain : code smell, logique risquée, erreur mal gérée, nommage
trompeur, test manquant, effet de bord caché. Par étape : la préoccupation (1 phrase) et la
question à se poser. Rien à signaler sur un fichier : ne l'inclus pas. Dis quand tu n'es pas sûr.

## Mode terminal (repli : `ui: false`)

Quand VS Code n'est pas ouvert sur le projet : plus de fils de commentaire. Fais la visite dans
le terminal, une étape à la fois : `reveal_file` (même règles de zone), 1 à 2 phrases, puis
**pause obligatoire** « Continuer ? » (outil de questions type `AskUserQuestion` si dispo, sinon
question en texte et **arrête ton tour**). À la fin, `stop_following`.

## À éviter

- Rédiger toutes les étapes avant d'en envoyer une : envoie la première **dès qu'elle est prête**.
- Écrire des explications dans le terminal (tout est dans VS Code) ; enchaîner des appels
  `walkthrough_wait` en commentant chaque fois.
- Expliquer du code sans dire ce que l'issue/PR en attend ; sortir du workspace actif sans le dire.
- Trop d'étapes (6 qui comptent valent mieux que 20) ; zones trop larges ; abuser du diff.
- Inventer une intention ou un problème non vérifié dans l'issue/PR ou le code.
