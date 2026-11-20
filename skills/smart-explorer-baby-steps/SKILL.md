---
name: smart-explorer-baby-steps
description: Load when the user asks for a guided, step-by-step walkthrough ("baby steps", "guide-moi", "explique pas à pas", "étape par étape", "explique-moi la PR/l'issue", "walkthrough", "review guidée") of the ACTIVE Smart Explorer workspace, on a repo that has the Smart Explorer MCP server connected. The walkthrough is anchored on the workspace's issue/PR — what it asks for — and shows the code that answers it. Three modes — follow a flow, walk through the key changes, or guide a reviewer to the spots that deserve attention. One very short step at a time, with a pause after each, while VS Code highlights the right lines.
---

# Smart Explorer — baby steps

Le but : que la personne comprenne **ce que veut l'issue/PR ET le code qui y répond**, vite.
Périmètre : **le workspace actif**. Chaque étape relie une attente de l'issue/PR à un endroit du code.

## Concision (règle n°1)

**Écris le minimum.** Tu es un guide qui montre du doigt, pas un cours.

- **Une étape = 1 à 2 phrases, ~40 mots maximum.** Une seule idée.
- Pas de préambule (« Voyons… », « Ici on a… »), pas de reformulation de la question, pas de
  paraphrase du code, pas de liste à puces ni de titres dans une étape.
- Dis seulement : _ce que l'issue/PR attend ici_ → _ce que fait le code_, ou ce qui cloche.
- Cadre initial : **1 à 2 lignes**. Récap final : **2 lignes**.
- Réponse à une question : courte, directe, sans réintroduire le contexte.
- Si tu peux le dire en moins de mots, fais-le.
- **Ne décris pas ce que l'écran montre déjà** : le diff ou le code est sous les yeux. Dis le
  _pourquoi_ et l'_impact_, pas le _quoi_.

Trop long : « Pour les dates en UTC, la PR n'a pas besoin de logique particulière. Les champs
passent de DateTime<Utc> à Timestamp, Utc::now() devient Timestamp::now(), cela touche
builder.rs, contracts.rs… le module maison est supprimé avec ses attributs… » (le diff le montre).
Bien : « Dates toujours en UTC : serde par défaut de jiff, le module maison disparaît. À vérifier :
même format que l'ancien (Z, fraction sans zéros de fin). »

## Quoi sélectionner (la granularité la plus fine)

Une étape met en avant **une seule zone continue**, la plus petite qui suffit :

- **Pas de `line`** : tu parles du **fichier entier** (son rôle, sa place). Rien n'est sélectionné.
- **`line` seule** : une ligne précise. Ajoute **`match`** (le texte exact) pour ne surligner
  **que ce texte** dans la ligne : c'est l'« inline », pour un point précis (un appel, un nom).
- **`line` + `end_line`** : **une petite plage** : une partie de fonction, ou une petite
  fonction (25 lignes au maximum, le serveur plafonne). Jamais un gros bloc.

À ne jamais faire : sélectionner un fichier entier (surtout un fichier nouveau), ou une plage
qui **englobe deux exemples**. Deux exemples = **deux étapes** (ou : montre le premier et cite
le second en `fichier:ligne` dans la phrase). Un seul appel `reveal_file` = une seule zone.

## Code actuel ou diff ? (le diff est l'exception)

- **Code actuel** (par défaut, sans `diff`) : presque toujours. Quand l'explication porte sur
  **ce que fait le code** : le cœur d'une fonction, un type et ses limites, un contournement.
- **Diff** seulement quand le **changement lui-même** est le sujet **et qu'il est petit** :
  un remplacement net, une suppression de quelques lignes, un avant/après court. Le serveur
  **ignore** le diff (et montre le code actuel) au-delà de 60 lignes modifiées, pour un fichier
  nouveau ou sans changement : n'insiste pas. Au plus une ou deux étapes d'une visite.
- Le diff s'ouvre en **une seule vue** unifiée (lignes `+`/`-`), pas côte à côte.
  `reveal_file` avec `diff: { from, to? }` : `from` = révision de départ, `to` = arrivée
  (absent = le code actuel). `line`/`end_line` visent le nouveau côté ; `side: "old"` vise
  l'ancien (code supprimé), `from_path` si le fichier a été renommé.
- Pour une PR, repère une fois les révisions : `gh pr view <n> --json baseRefOid,headRefOid`
  (ou `git merge-base`). Base = `from`, tête = `to`.
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
   Pas de workspace actif : dis-le en une ligne et propose d'en créer un (skill `smart-explorer`).
2. **Cadre** en 1-2 lignes : ce que l'issue/PR demande, et le besoin de l'utilisateur.
3. **Étapes** : liste de 5 à 8 lignes `n. titre — fichier:ligne`, sans commentaire.
4. **Chaque étape** :
   - `reveal_file` avec `path` et la zone la plus fine (voir **Quoi sélectionner** : pas de
     `line` pour le fichier entier ; `line` + `match` pour un point précis ; `end_line` seulement
     pour une petite plage). `diff` seulement dans les rares cas décrits plus haut. VS Code
     ouvre le fichier, surligne la zone (« Smart Explorer »), affiche « Following agent » (en
     orange) et marque le fichier en orange dans l'arbre. Si la réponse contient `notes`, un
     garde-fou a corrigé ta demande (plage plafonnée, diff ignoré) : tiens-en compte.
   - 1 à 2 phrases (voir Concision).
   - **Pause obligatoire** : « Continuer ? ». Avec un outil de questions (ex. `AskUserQuestion`) :
     _Continuer_ / _Poser une question_ / _Arrêter_. Sinon pose la question en texte et
     **arrête ton tour** : n'enchaîne jamais seul.
5. **Question** : réponds en une ou deux phrases, remets la plage en avant si besoin, repose
   « Continuer ? ».
6. **Fin** : récap en 2 lignes, puis **`stop_following`** (la ligne « Following agent » et le
   surlignage disparaissent). Appelle-le aussi si l'utilisateur dit d'arrêter.

Si l'utilisateur clique sur **Stop** dans VS Code, le surlignage s'efface mais ça ne change rien
pour toi : continue normalement, ton prochain `reveal_file` relance le suivi.

## Règles par mode

**flow** — pars du point d'entrée du flux concerné. Une étape par saut. Dis en quoi l'issue/PR
change ce maillon ou s'y appuie. Branches secondaires : une phrase, sans détail.

**changes** — regroupe par **type** (« migration chrono → jiff », « nouveau schéma », « tests
adaptés »), jamais par fichier. Par type : le lien avec la demande, un endroit représentatif
(`reveal_file`, en général avec `diff` puisque l'étape parle du changement), les autres
endroits en une ligne, l'impact en une phrase.

**review** — juge le code **par rapport à l'objectif de la PR** : manque, écart. Ne retiens que
ce qui demande un regard humain : code smell, logique risquée, erreur mal gérée, nommage
trompeur, test manquant, effet de bord caché. Par étape : la préoccupation (1 phrase) et la
question à se poser. Rien à signaler sur un fichier : ne l'inclus pas. Dis quand tu n'es pas sûr.

## À éviter

- Enchaîner sans pause ; expliquer deux fichiers à la fois ; délayer.
- Une zone sélectionnée trop large, ou qui couvre deux exemples d'un coup.
- Abuser du diff : il sert à montrer un petit changement, pas à tout raconter.
- Expliquer du code sans dire ce que l'issue/PR en attend.
- Sortir du workspace actif sans le dire.
- Trop d'étapes : 6 qui comptent valent mieux que 20.
- Lignes approximatives : lis le fichier avant de donner `line`/`end_line`, et ajoute `match`.
- Inventer une intention ou un problème non vérifié dans l'issue/PR ou le code.
