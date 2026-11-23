// Définition unique des tools MCP (nom, description, schéma, exécution),
// partagée par le serveur in-process (mcpServer.ts) et le serveur stdio
// (mcpStdio.ts). Module sans dépendance à 'vscode'.
import { z } from 'zod';
import { focusTool } from './focusTools';
import type { ToolEnv } from './toolEnv';
import {
  addStepTool,
  deleteWalkthroughTool,
  getWalkthroughTool,
} from './walkthroughTools';
import {
  createWorkspaceTool,
  deleteWorkspaceTool,
  getWorkspaceTool,
  listWorkspacesTool,
  setActiveWorkspaceTool,
  setFilesTool,
  setLinksTool,
} from './workspaceTools';

export interface ToolSpec {
  name: string;
  description: string;
  shape: z.ZodRawShape;
  run: (env: ToolEnv, args: any) => Promise<unknown>;
}

const strArray = z.array(z.string());
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
      'Liste les workspaces Smart Explorer du projet (N par projet) : id, nom, liens (issues/PR), fraîcheur, nombre de fichiers.',
    shape: {},
    run: (env) => listWorkspacesTool(env),
  },
  {
    name: 'get_workspace',
    description:
      "Lit un workspace (par défaut l'actif) : liens (issues/PR), fichiers retenus, arbre compacté et fraîcheur (`stale` : fichiers supprimés, renommés, modifiés ou absents depuis base_commit). Ne modifie rien : si `stale` le demande, mets à jour avec set_files (`sync: true` pour la partie mécanique).",
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
      "Crée un workspace. `links` : issues/PR GitHub ou Linear, en URL ou en forme courte (`#123`, `owner/repo#123`, `ABC-123`) ; l'issue ou la PR est déterminée par `gh`. Lis toi-même le contenu des liens (gh, Linear…) : ce tool ne fait que les enregistrer. `name` : défaut = le premier lien. Retourne workspace_id.",
    shape: {
      name: z.string().optional(),
      links: strArray.optional(),
    },
    run: (env, args) => createWorkspaceTool(env, args),
  },
  {
    name: 'set_links',
    description:
      "Ajoute (`add`) et/ou retire (`remove`) des liens d'un workspace, sans toucher aux autres : un workspace peut porter plusieurs issues puis une PR. Formes courtes acceptées (`#123`, `owner/repo#123`, `ABC-123`) ; un lien non résolu est conservé en `unknown` avec une note.",
    shape: {
      workspace_id: workspaceId,
      add: strArray.optional(),
      remove: strArray.optional(),
    },
    run: (env, args) => setLinksTool(env, args),
  },
  {
    name: 'set_files',
    description:
      "Définit les fichiers pertinents du workspace : `files` remplace la liste ; `add` / `remove` l'ajustent (pas de `files` avec). `sync: true` applique d'abord la partie mécanique de la mise à jour (renommages suivis, fichiers supprimés retirés) et avance base_commit sur HEAD. Seuls les chemins sont stockés : l'arbre affiché dans VS Code est recalculé par FUSION à chaque rendu (les fichiers des petits dossiers remontent au parent, les dossiers intermédiaires sont absorbés : apps/backend/src/backend/internal/... -> src/...). Réglages persistants : `min_folder_files` (défaut 3) et `max_loose_files` (défaut 12) ; min_folder_files élevé = liste plate.",
    shape: {
      workspace_id: workspaceId,
      files: strArray
        .optional()
        .describe('Chemins relatifs à la racine du projet (remplace la liste)'),
      add: strArray.optional(),
      remove: strArray.optional(),
      sync: z.boolean().optional(),
      min_folder_files: z.number().int().min(1).optional(),
      max_loose_files: z.number().int().min(1).optional(),
    },
    run: (env, args) => setFilesTool(env, args),
  },
  {
    name: 'delete_workspace',
    description: 'Supprime un workspace.',
    shape: { workspace_id: workspaceId },
    run: (env, args) => deleteWorkspaceTool(env, args),
  },
  {
    name: 'focus',
    description:
      "Met un fichier/une zone en avant dans VS Code : ouvert, zone sélectionnée et surlignée, fichier sélectionné dans l'arbre. Demande ponctuelle (rien à arrêter ensuite). GRANULARITÉ — choisis la plus fine : (1) PAS de `line` = tu parles du fichier entier, rien n'est sélectionné ; (2) `line` seule = une ligne, ou avec `match` SEULEMENT ce texte dans la ligne (pour un point précis) ; (3) `line` + `end_line` = une petite plage (partie de fonction ou petite fonction), plafonnée à 25 lignes. Une seule zone continue par appel. `match` retrouve aussi la ligne si le code a bougé. `workspace_id` met aussi ce workspace en avant (sinon : celui qui contient le fichier). Option `diff` : montre le diff UNIFIÉ (une seule vue, +/−) entre deux révisions au lieu du code actuel ; réservé aux changements de petite taille (≤ 60 lignes) sur un fichier existant : sinon il est ignoré et le code actuel est montré (voir `notes`). line/end_line désignent le nouveau côté, ou l'ancien avec `side: 'old'`.",
    shape: {
      path: z.string(),
      line: z.number().int().min(1).optional(),
      end_line: z.number().int().min(1).optional(),
      match: z.string().optional(),
      diff: diffSchema,
      workspace_id: workspaceId.optional(),
    },
    run: (env, args) => focusTool(env, args),
  },
  {
    name: 'add_step',
    description:
      "Ajoute une étape à la visite guidée, affichée dans une page VS Code (aperçu markdown) : explication + extraits de code cliquables (un clic ouvre le fichier à la ligne). La première étape crée la visite (`walkthrough_title`, `mode`). Appelle-le étape après étape : la page se met à jour toute seule pendant que l'utilisateur lit. `text` = l'explication, 1 à 2 phrases (~40 mots), sans décrire ce que l'extrait montre. `refs` = les zones citées (au plus 4) : mêmes règles que focus (pas de `line` = lien vers le fichier seul ; `line` + `match` = point précis ; `line` + `end_line` = petite plage ≤ 25 lignes ; `diff` = rare, petit changement) ; l'extrait est figé à la création. L'utilisateur pose ses questions dans le terminal : réponds-lui ET mets l'étape concernée à jour en repassant son `step_id` (l'étape est remplacée sur place).",
    shape: {
      title: z.string().describe("Titre court de l'étape"),
      text: z.string().describe('Explication concise (markdown)'),
      refs: z
        .array(
          z.object({
            path: z.string(),
            line: z.number().int().min(1).optional(),
            end_line: z.number().int().min(1).optional(),
            match: z.string().optional(),
            diff: diffSchema,
          }),
        )
        .optional()
        .describe('Zones de code citées (au plus 4)'),
      step_id: z
        .string()
        .optional()
        .describe(
          'Id d’une étape existante à remplacer (voir get_walkthrough) ; absent = nouvelle étape',
        ),
      walkthrough_title: z
        .string()
        .optional()
        .describe('Titre de la visite (ex. « PR #326 : chrono → jiff »)'),
      mode: z.enum(['flow', 'changes', 'review']).optional(),
      workspace_id: workspaceId.optional(),
    },
    run: (env, args) => addStepTool(env, args),
  },
  {
    name: 'get_walkthrough',
    description:
      "Lit la visite guidée en cours : titre, mode, étapes (id, titre, texte, zones). À utiliser pour la reprendre ou pour retrouver le `step_id` à mettre à jour après une question de l'utilisateur.",
    shape: {},
    run: (env) => getWalkthroughTool(env),
  },
  {
    name: 'delete_walkthrough',
    description:
      'Supprime la visite guidée (état et page). À appeler pour repartir de zéro.',
    shape: {},
    run: (env) => deleteWalkthroughTool(env),
  },
  {
    name: 'set_active_workspace',
    description: 'Bascule le workspace affiché dans le panneau Smart Explorer.',
    shape: { workspace_id: workspaceId },
    run: (env, args) => setActiveWorkspaceTool(env, args),
  },
];
