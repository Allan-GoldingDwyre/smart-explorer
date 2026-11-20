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
  listWorkspacesTool,
  revealFileTool,
  setActiveWorkspaceTool,
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
      "Retourne le chemin absolu d'un fichier du projet (le client l'ouvre dans son éditeur).",
    shape: { path: z.string(), workspace_id: workspaceId.optional() },
    run: (env, args) => revealFileTool(env, args),
  },
  {
    name: 'set_active_workspace',
    description: 'Bascule le workspace affiché dans le panneau Smart Explorer.',
    shape: { workspace_id: workspaceId },
    run: (env, args) => setActiveWorkspaceTool(env, args),
  },
];
