# Smart Explorer — visite guidée (page VS Code)

Le but : que la personne comprenne **l'intention de la demande (issue, PR ou prompt) et comment le
code y répond**. La visite est un **ensemble d'intentions clés**, chacune appuyée par du code.
On n'explique pas chaque ligne ni chaque fichier : on explique **pourquoi** ce code existe.
Périmètre : **le workspace actif**.

**La visite est une page dans VS Code** (onglet pleine largeur). Tu ajoutes les étapes une à une
avec `add_step`, la page se met à jour toute seule. **L'utilisateur te pose ses questions dans le
terminal** : tu réponds, et tu mets l'étape concernée à jour en même temps.

## Structure de la page

```
Besoin (walkthrough_goal)        ← le besoin de départ + sa source
└─ Étape = une intention
   ├─ Intention (intent)         ← l'attente de la source servie ici, citée
   ├─ Macro (text)               ← pourquoi ces extraits, ENSEMBLE, la réalisent
   └─ Extraits (refs[])          ← un extrait = un texte (note) juste après lui
```

**Un extrait = un texte.** Dès qu'une étape montre plusieurs extraits, chacun porte sa `note` :
ce que _cet_ endroit apporte à l'intention (« Existant : … », « Manque : … », « Garde-fou : … »).
Le macro ne répète pas les notes : il dit seulement pourquoi les extraits vont **ensemble**.

- **`walkthrough_goal`** (1re étape, obligatoire) : le besoin en 1 à 2 phrases, avec sa source.
  Issue/PR : « #326 : migrer de chrono vers jiff pour gérer les fuseaux ». Sans issue ni PR, la
  source est **le prompt** : reformule ce que l'utilisateur veut (« Demande : … »).
- **`intent`** (chaque étape, obligatoire) : l'attente que l'étape sert, avec sa source (« #326,
  critère 2 : les dates restent en UTC »). Si tu n'en trouves pas, l'étape n'a pas sa place.
- **`text`** = le **macro**. Avec plusieurs extraits : _pourquoi ces extraits, pris ensemble, sont
  ce qui réalise l'intention_ (le trio entrée → traitement → garde-fou, l'avant/après, etc.).
  Avec un seul extrait : pourquoi il répond à l'intention.
- **`refs[].note`** (**obligatoire dès qu'il y a 2 extraits ou plus**, le serveur refuse sinon) :
  1 à 2 phrases, **~30 mots maximum**, affichées en italique sous l'extrait. Le **rôle** de
  l'extrait dans l'intention et ce qu'il y a à en retenir (existant, manque, risque), pas ce que
  fait chaque ligne. Étape à un seul extrait : la note est facultative, le macro suffit.

## Écrire clair (règle n°1)

L'intention doit être **compréhensible seule** par quelqu'un qui n'a pas lu l'issue/PR.

- **Test de clarté**, pour chaque étape : le lecteur sait-il (1) quelle attente est servie,
  (2) pourquoi ce code la sert ? Sinon, réécris.
- Dis le **pourquoi** et l'**impact**, pas le _quoi_ : l'extrait montre déjà le code.
- Macro : 1 à 3 phrases, **~80 mots maximum** ; **~60 mots (3/4)** quand les extraits portent
  leurs notes (2 extraits ou plus), puisque le détail est dans les notes. Note : ~30 mots. Réponse à
  une question : 1 à 3 phrases.
- **Une étape = une seule idée** : un point secondaire (autre sujet repéré en chemin) va dans
  l'étape « Couverture », pas dans le macro.
- **`intent` = une attente**, formulée comme telle (« les dates restent en UTC »), **courte** (une
  citation de la source, sans commentaire de ta part), jamais un titre de section de l'issue. **Le titre de l'étape = l'intention reformulée**, jamais un état du code
  (« save_cell : où brancher… »).
- Pas de préambule, de paraphrase du code, de titres ni de longues listes dans une étape.
- Vocabulaire du besoin, pas du code : « les dates restent en UTC », pas « `Timestamp` remplace
  `DateTime<Utc>` ».
- Terminal : **une ligne au début, une à la fin**, sauf pour répondre aux questions.

Mal : « Les champs passent de `DateTime<Utc>` à `Timestamp`, `Utc::now()` devient
`Timestamp::now()`… » (le code le montre, et rien ne dit pourquoi).
Bien — intention : « #326 : les dates restent en UTC ». Macro : « Trois endroits fixent ensemble
le format : le défaut de jiff remplace le module maison. » Notes : « Le type : `Timestamp` est
toujours en UTC, plus de conversion à faire. », « Le format écrit : défaut de jiff. À vérifier :
même rendu que l'ancien (Z, fraction sans zéros de fin). », « Là où on relit : accepte encore
l'ancien format, donc rien à migrer. »

## Quoi citer (la granularité la plus fine)

Chaque `refs[]` d'une étape cite **une seule zone continue** (au plus 4 par étape), la plus
petite qui suffit :

- **Pas de `line`** : tu parles du **fichier entier**. Lien seul, pas d'extrait.
- **`line` seule** : une ligne précise. Ajoute **`match`** (le texte exact) : le serveur retrouve
  la ligne même si le code a bougé.
- **`line` + `end_line`** : **une petite plage** : une partie de fonction ou une petite
  fonction (25 lignes au maximum, le serveur plafonne). Jamais un gros bloc.

Une zone ne doit pas **englober deux exemples** : deux exemples = **deux refs** de la même étape
si c'est la même intention (le macro dit pourquoi ils vont ensemble), sinon deux étapes.
Choisis les extraits qui **portent l'intention**, pas tous ceux qui existent. Lis le fichier avant
de donner `line`/`end_line`. L'extrait est **figé à la création** de l'étape.

## Code actuel ou diff ? (le diff est l'exception)

- **Code actuel** (par défaut) : quand l'explication porte sur **ce que fait le code**.
- **Diff** seulement quand le **changement lui-même** est le sujet **et qu'il est petit** (un
  remplacement net, quelques lignes supprimées, un avant/après court). Le serveur l'ignore
  (et cite le code actuel) au-delà de 60 lignes, pour un fichier nouveau ou sans changement.
  Au plus une ou deux étapes d'une visite. L'extrait est le diff unifié (+/−).
  `diff: { from, to? }` (`from` = base de la PR, `to` = tête ; absent = code actuel) ;
  `side: "old"` vise l'ancien côté, `from_path` si le fichier a été renommé.
  Révisions d'une PR : `gh pr view <n> --json baseRefOid,headRefOid`.
- En cas de doute : code actuel.

## Choisir le mode

Dans tous les modes, **une étape = une intention**, jamais un fichier.

| Mode        | Quand                                                              | Une étape =                                                                         |
| ----------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| **flow**    | « comment ça marche »                                              | l'intention qu'un maillon du flux sert, dans l'ordre d'exécution                    |
| **changes** | « que demande / qu'a changé la PR »                                | une **intention** de la demande, avec les endroits du code qui la réalisent         |
| **review**  | « aide-moi à relire »                                              | une intention, **jugée** : remplie, partielle ou absente, et pourquoi               |
| **gap**     | source **sans code encore écrit** (« par où commencer », « plan ») | une intention, avec l'**écart** : ce qui existe déjà, ce qui manque, où le brancher |

« Explique-moi la PR/l'issue » (pas à pas) sans précision = **changes**, sans poser de question.

## Déroulé

1. **Bon workspace** (silencieux) : si l'utilisateur parle d'une PR/issue précise (ex. #326,
   ARCHON-118), `list_workspaces` puis `set_active_workspace` sur celui dont `links`
   correspond. Puis `get_workspace` (liens, `files`). **Lis la source toi-même**
   (`gh pr view` / `gh pr diff` / `gh issue view`, ou le prompt) et les fichiers utiles.
2. **Extrais les intentions** : de la source (description, critères, commentaires) ou du prompt,
   dégage **les intentions clés** (en général 3 à 7 ; **si l'utilisateur demande un nombre d'étapes
   précis, suis-le**), formulées comme des attentes. **Fusionne** celles qui visent la même attente. Pour chacune, repère le
   code qui la réalise (ou qui manque). Une intention sans code : dis-le (surtout en review).
   Décide des étapes (une par intention), sans les rédiger.
3. **Une visite précédente ?** `get_walkthrough` : si elle existe et que l'utilisateur veut
   repartir de zéro, `delete_walkthrough`.
4. **Ajoute les étapes une à une** avec `add_step` (`title`, `intent`, `text`, `refs` avec `note`).
   La **première** porte aussi `walkthrough_title` (ex. « PR #326 : chrono → jiff »),
   `walkthrough_goal` et `mode` : elle crée la visite et **la page s'ouvre dans VS Code**. Écris
   **une ligne** dans le terminal : « Visite ouverte dans VS Code. » **Dès que l'étape 1 est
   prête, envoie-la** puis enchaîne : l'utilisateur la lit pendant que tu génères le reste.
   - Si la réponse contient `notes` : un garde-fou a corrigé ta demande (plage plafonnée,
     diff ignoré, fichier introuvable) : tiens-en compte pour les étapes suivantes.
5. **Questions** : l'utilisateur écrit dans le terminal. Réponds brièvement **et** mets
   l'étape concernée à jour : `add_step` avec son `step_id` (la réponse de `add_step` le
   donne, `get_walkthrough` liste les étapes) remplace l'étape sur place. Ajoute une étape
   seulement si la question ouvre une nouvelle intention.
6. **Clôture (obligatoire)** : parcours la source section par section et vérifie que **chaque
   intention est couverte**. Termine par une étape **« Couverture »** (son `intent` : « Ce que
   la source demande, couvert ou non ») qui liste **en liste à puces** (`- `), une ligne chacune,
   les intentions **non traitées** dans la visite (et pourquoi : hors périmètre, reportée, oubliée) et les points
   à trancher. Rien à signaler : dis-le en une phrase. Une ligne de récap dans le terminal. La page reste ouverte ;
   `delete_walkthrough` seulement pour repartir de zéro.

`focus` (mêmes règles de zone que `refs`) ouvre et surligne un fichier/une plage dans l'éditeur ;
utile pour amener l'utilisateur quelque part pendant une réponse, pas pour chaque étape.

## Règles par mode

**flow** — pars du point d'entrée du flux concerné. Une étape par intention du flux (pas par
saut technique) : les extraits de l'étape sont les maillons qui la servent, dans l'ordre. Dis en
quoi l'issue/PR change ce maillon ou s'y appuie. Branches secondaires : une phrase.

**changes** — une étape par **intention de la demande**, jamais par fichier ni par type technique.
Macro : pourquoi les extraits retenus, ensemble, y répondent ; `note` : ce que chacun apporte à l'intention.
Les autres endroits touchés, en une ligne dans le macro. Impact en une phrase.

**gap** — la source existe, le code n'est pas (ou pas tout à fait) écrit : la visite sert de plan.
Une étape par intention ; pour chacune dis **ce qui existe déjà** (« déjà fait » si c'est le cas),
**ce qui manque** et **où le brancher**. Étiquette le mode `gap` (pas `flow`) : on ne suit pas un
flux d'exécution. Extraits : l'existant sur lequel s'appuyer, pas un code à venir.

**review** — pars de l'**objectif**, juge chaque intention : remplie, partielle, absente. Ne retiens
que ce qui demande un regard humain : code smell, logique risquée, erreur mal gérée, nommage
trompeur, test manquant, effet de bord caché. Macro : la préoccupation (1 phrase) et la question
à se poser ; `note` : où ça se voit. Rien à signaler : n'inclus pas. Dis quand tu n'es pas sûr.

## À éviter

- Une étape sans lien explicite avec la source : pas d'`intent` citable = pas d'étape.
- Empiler des extraits sans macro ni notes : le lecteur ne sait pas pourquoi ils sont là.
- Expliquer le code ligne par ligne : on explique l'intention, le code l'appuie.
- Rédiger toutes les étapes avant d'en envoyer une : envoie la première **dès qu'elle est prête**.
- Répéter la visite dans le terminal : tout est dans la page.
- Sortir du workspace actif sans le dire.
- Trop d'étapes sans nécessité (sauf nombre demandé) : fusionne celles de même intention ; zones trop larges ; abuser du diff.
- Répondre à une question sans mettre l'étape à jour : la page doit refléter ce que tu as dit.
- Un `intent` qui est un titre de section, ou un titre d'étape qui décrit l'état du code.
- Oublier la clôture : une source lue en entier mais couverte à moitié, sans le dire.
- Inventer une intention ou un problème non vérifié dans l'issue/PR/prompt ou le code.
