// Définition unique des tools MCP (nom, description, schéma, exécution),
// partagée par le serveur in-process (mcpServer.ts) et le serveur stdio
// (mcpStdio.ts). Module sans dépendance à 'vscode'.
import { z } from 'zod';
import {
  ToolEnv,
  applySyncTool,
  buildTreeTool,
  checkWorkspaceFilesTool,
  createWorkspaceTool,
  exportContextTool,
  getWorkspaceTool,
  listWorkspacesTool,
  revealFileTool,
  setActiveWorkspaceTool,
  stopFollowingTool,
  walkthroughEndTool,
  walkthroughReplyTool,
  walkthroughStartTool,
  walkthroughStepTool,
  walkthroughWaitTool,
  setInstructionsTool,
  syncWorkspaceTool,
  updateFilesTool,
} from './mcpTools';

export interface ToolSpec {
  name: string;
  description: string;
  shape: z.ZodRawShape;
  run: (env: ToolEnv, args: any) => Promise<unknown>;
}

const strArray = z.array(z.string());
interface TreeNodeInput {
  name?: string;
  files?: string[];
  dirs?: TreeNodeInput[];
}
const treeNode: z.ZodType<TreeNodeInput> = z.lazy(() =>
  z.object({
    name: z.string().optional(),
    files: strArray.optional(),
    dirs: z.array(treeNode).optional(),
  }),
);
const diffSchema = z
  .object({
    from: z
      .string()
      .describe('Révision de départ : SHA, branche, tag, HEAD~3…'),
    to: z
      .string()
      .optional()
      .describe(
        "Révision d'arrivée ; défaut : le code actuel (arbre de travail)",
      ),
    from_path: z
      .string()
      .optional()
      .describe('Chemin du fichier à la révision `from` s’il a été renommé'),
    side: z
      .enum(['old', 'new'])
      .optional()
      .describe('Côté désigné par line/end_line ; défaut : new'),
  })
  .optional()
  .describe(
    'Montre le diff du fichier entre deux révisions au lieu du code actuel. À utiliser quand ton explication porte sur CE QUI A CHANGÉ (remplacement, suppression, avant/après) ; sans diff quand elle porte sur ce que fait le code.',
  );
const workspaceId = z
  .string()
  .describe('Id du workspace (voir list_workspaces)');

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: 'list_workspaces',
    description:
      'Liste les workspaces Smart Explorer du projet : id, nom, type de source, fraîcheur, nombre de fichiers.',
    shape: {},
    run: (env) => listWorkspacesTool(env),
  },
  {
    name: 'get_workspace',
    description:
      "Lit un workspace (par défaut l'actif) : source (URL de l'issue/PR), besoin de l'utilisateur (`instructions`), fichiers retenus et arbre. À utiliser pour s'appuyer sur l'issue/PR et sur les fichiers du workspace actif (visite guidée, review).",
    shape: {
      workspace_id: workspaceId
        .optional()
        .describe('Par défaut : le workspace actif'),
    },
    run: (env, args) => getWorkspaceTool(env, args),
  },
  {
    name: 'create_workspace',
    description:
      "Crée un workspace pour une issue/PR (URL ou identifiant) ou un texte libre. Lis toi-même la source (gh, WebFetch…) : ce tool ne fait que l'enregistrer. `instructions` = le besoin de l'utilisateur (ex. « relire la migration serde »). Retourne workspace_id.",
    shape: {
      source: z.string().describe('URL ou identifiant de l’issue/PR, ou texte'),
      name: z.string().optional(),
      instructions: strArray.optional(),
    },
    run: (env, args) => createWorkspaceTool(env, args),
  },
  {
    name: 'build_tree',
    description:
      "Construit l'arbre du workspace. Normal : donne `files` (les chemins pertinents) ; le serveur reprend l'arborescence réelle et la FUSIONNE : les fichiers des petits dossiers remontent au dossier parent, les dossiers intermédiaires sont absorbés par le dossier du haut qui garde son nom (back/a/b/c/x -> back/x ; apps/backend/src/backend/internal/... -> src/...), conteneurs vides et préfixe commun retirés. Les vrais fichiers ne bougent jamais. Réglages : `min_folder_files` (défaut 3 : un dossier de moins de fichiers est dissous) et `max_loose_files` (défaut 12 : on arrête de fusionner au-delà) ; min_folder_files élevé = liste plate. Alternative : `tree` = { files?, dirs?: [{ name, files?, dirs? }] } si tu veux décider toi-même du rangement (seuls doublons et dossiers vides sont retirés). Donne `files` OU `tree`, pas les deux. Un fichier n'apparaît qu'une fois.",
    shape: {
      workspace_id: workspaceId,
      files: strArray
        .optional()
        .describe(
          'Chemins pertinents relatifs à la racine du projet (fusion automatique)',
        ),
      min_folder_files: z.number().int().min(1).optional(),
      max_loose_files: z.number().int().min(1).optional(),
      focus: z
        .object({
          path: z.string(),
          line: z.number().int().min(1).optional(),
          end_line: z.number().int().min(1).optional(),
          match: z.string().optional(),
          diff: diffSchema,
        })
        .optional()
        .describe(
          'Fichier/ligne qui demande l’attention : ouvert dans VS Code et sélectionné dans l’arbre une fois l’arbre construit',
        ),
      tree: treeNode
        .optional()
        .describe(
          'Arbre défini par toi : racine { files?, dirs? } ; name ignoré à la racine',
        ),
    },
    run: (env, args) => buildTreeTool(env, args),
  },
  {
    name: 'update_files',
    description:
      "Ajoute et/ou retire des fichiers d'un workspace. Arbre fusionné (files) : la fusion est rejouée sur la nouvelle liste. Arbre défini par toi (tree) : les fichiers ajoutés vont dans le dossier `into` (créé si besoin ; absent = racine), le reste est conservé.",
    shape: {
      workspace_id: workspaceId,
      add: strArray.optional(),
      remove: strArray.optional(),
      into: z
        .string()
        .optional()
        .describe(
          'Arbre `tree` uniquement : dossier cible des fichiers ajoutés (ex. "storage" ou "backend/storage")',
        ),
    },
    run: (env, args) => updateFilesTool(env, args),
  },
  {
    name: 'set_instructions',
    description:
      "Remplace les instructions du workspace : le besoin de l'utilisateur sur l'issue/PR (ce qu'il veut faire ou relire).",
    shape: { workspace_id: workspaceId, instructions: strArray },
    run: (env, args) => setInstructionsTool(env, args),
  },
  {
    name: 'sync_workspace',
    description:
      'Retourne le diff depuis base_commit (fichiers added/modified/deleted/renamed + drift de hash), sans appliquer.',
    shape: { workspace_id: workspaceId },
    run: (env, args) => syncWorkspaceTool(env, args),
  },
  {
    name: 'apply_sync',
    description:
      'Applique le diff validé par l’utilisateur : retire les fichiers supprimés/renommés acceptés, met à jour base_commit et file_hashes.',
    shape: {
      workspace_id: workspaceId,
      accepted: strArray,
      rejected: strArray,
    },
    run: (env, args) => applySyncTool(env, args),
  },
  {
    name: 'check_workspace_files',
    description:
      'Liste les chemins du workspace introuvables dans le repo + candidats de résolution (similarité).',
    shape: { workspace_id: workspaceId },
    run: (env, args) => checkWorkspaceFilesTool(env, args),
  },
  {
    name: 'export_context',
    description:
      'Exporte le contenu des fichiers du workspace, tronqué à max_tokens si fourni.',
    shape: { workspace_id: workspaceId, max_tokens: z.number().optional() },
    run: (env, args) => exportContextTool(env, args),
  },
  {
    name: 'reveal_file',
    description:
      "Met un fichier/une zone en avant, comme Live Share : VS Code l'ouvre, sélectionne et surligne la zone avec le nom « Smart Explorer », affiche « Following agent » dans la vue et sélectionne le fichier dans l'arbre. GRANULARITÉ — choisis la plus fine : (1) PAS de `line` = tu parles du fichier entier, rien n'est sélectionné ; (2) `line` seule = une ligne, ou avec `match` SEULEMENT ce texte dans la ligne (pour un point précis) ; (3) `line` + `end_line` = une petite plage (partie de fonction ou petite fonction), plafonnée à 25 lignes. Une seule zone continue par appel : pour deux exemples, fais deux appels (deux étapes), jamais une plage qui englobe les deux. Ne sélectionne jamais un fichier entier. `match` retrouve aussi la ligne si le code a bougé. `workspace_id` met aussi ce workspace en avant (sinon : celui qui contient le fichier). Option `diff` : montre le diff UNIFIÉ (une seule vue, +/−) entre deux révisions au lieu du code actuel ; réservé aux changements de petite taille (≤ 60 lignes) sur un fichier existant : sinon il est ignoré et le code actuel est montré (voir `notes`). line/end_line désignent le nouveau côté, ou l'ancien avec `side: 'old'`. Chaque appel (re)lance le suivi, même si l'utilisateur avait cliqué sur Stop dans VS Code (Stop ne fait qu'effacer l'affichage). Appelle `stop_following` à la fin de ta visite.",
    shape: {
      path: z.string(),
      line: z.number().int().min(1).optional(),
      end_line: z.number().int().min(1).optional(),
      match: z.string().optional(),
      diff: diffSchema,
      workspace_id: workspaceId.optional(),
    },
    run: (env, args) => revealFileTool(env, args),
  },
  {
    name: 'walkthrough_start',
    description:
      "Lance une visite guidée DANS VS CODE (explications en commentaires au-dessus des lignes, l'utilisateur répond dans le fil) : tout se passe dans l'éditeur, pas dans le terminal. Donne `mode` (flow | changes | review), un `title` et le plan (`outline` : titres des étapes prévues, pour afficher « étape 2/6 »). Si `ui` vaut false : soit VS Code n'est pas ouvert (fais la visite dans le terminal), soit `display` vaut « cli » (réglage de l'utilisateur) : VS Code ne sert alors qu'au focus via reveal_file, tu expliques dans le terminal et l'utilisateur écrit « go » ou une question ; la `note` détaille. Ensuite : pousse les étapes avec walkthrough_step, puis attends l'utilisateur avec walkthrough_wait.",
    shape: {
      mode: z.enum(['flow', 'changes', 'review']),
      title: z.string().optional(),
      workspace_id: workspaceId.optional(),
      outline: strArray.optional().describe('Titres des étapes prévues'),
    },
    run: (env, args) => walkthroughStartTool(env, args),
  },
  {
    name: 'walkthrough_step',
    description:
      "Pousse UNE étape de la visite : elle s'affiche dans VS Code dès l'envoi (la première s'ouvre aussitôt). Enchaîne les appels sans attendre : l'utilisateur lit l'étape 1 pendant que tu génères les suivantes ; « Continuer » est géré par VS Code. `text` = l'explication, 1 à 2 phrases (~40 mots), sans décrire ce que l'écran montre. Zone : mêmes règles que reveal_file (pas de `line` = fichier entier ; `line` + `match` = point précis ; `line` + `end_line` = petite plage ≤ 25 lignes ; `diff` = rare, petit changement). `last: true` sur la dernière étape. La réponse contient `pending_comments` : si l'utilisateur a écrit pendant ce temps, réponds-y tout de suite avec walkthrough_reply.",
    shape: {
      title: z.string().describe("Titre court de l'étape"),
      text: z.string().describe('Explication concise (markdown)'),
      path: z.string(),
      line: z.number().int().min(1).optional(),
      end_line: z.number().int().min(1).optional(),
      match: z.string().optional(),
      diff: diffSchema,
      last: z.boolean().optional().describe('Dernière étape de la visite'),
    },
    run: (env, args) => walkthroughStepTool(env, args),
  },
  {
    name: 'walkthrough_reply',
    description:
      "Répond dans un fil de commentaire de VS Code. `thread` = celui de l'événement reçu (walkthrough_wait) ou de pending_comments (ex. step-2, user-5). Réponse courte et directe.",
    shape: {
      thread: z.string().describe('Ex. step-2 ou user-5'),
      text: z.string(),
    },
    run: (env, args) => walkthroughReplyTool(env, args),
  },
  {
    name: 'walkthrough_wait',
    description:
      "Attend une action de l'utilisateur dans VS Code (appel BLOQUANT) : un commentaire (réponds avec walkthrough_reply puis rappelle walkthrough_wait) ou l'arrêt (`status: ended` : termine). Continuer/Précédent sont gérés par VS Code et ne te réveillent pas. Rend la main avec `idle: true` après `timeout_s` (défaut 300, max 1800) : rappelle-le tant que la visite continue, sans rien écrire dans le terminal.",
    shape: { timeout_s: z.number().int().min(1).max(1800).optional() },
    run: (env, args) => walkthroughWaitTool(env, args),
  },
  {
    name: 'walkthrough_end',
    description:
      'Termine la visite guidée : les fils de commentaire et la ligne « Following agent » disparaissent. À appeler à la fin (ou sur `status: ended`).',
    shape: {},
    run: (env) => walkthroughEndTool(env),
  },
  {
    name: 'stop_following',
    description:
      "Termine le suivi de l'agent : la ligne « Following agent » et le surlignage disparaissent dans VS Code. À appeler à la fin d'une visite guidée (ou si l'utilisateur dit d'arrêter).",
    shape: {},
    run: (env) => stopFollowingTool(env),
  },
  {
    name: 'set_active_workspace',
    description: 'Bascule le workspace affiché dans le panneau Smart Explorer.',
    shape: { workspace_id: workspaceId },
    run: (env, args) => setActiveWorkspaceTool(env, args),
  },
];
