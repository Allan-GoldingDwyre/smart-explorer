import { execFile } from 'child_process';
import { promisify } from 'util';
import * as vscode from 'vscode';
import { getGithubSession, getLinearToken, isLinearRef } from './auth';
import { WorkspaceType } from './types';

const execFileAsync = promisify(execFile);

export interface DetectedRef {
  type: WorkspaceType;
  ref: string;
}

// Détecte le type réel d'une saisie "smart" : ID Linear, URL Linear,
// URL GitHub (issue ou PR), raccourci #123, ou texte libre.
export function detectRef(input: string): DetectedRef {
  const value = input.trim();

  const linearId = value.match(/^([A-Za-z][A-Za-z0-9]+-\d+)$/);
  if (linearId) {
    return { type: 'issue', ref: linearId[1].toUpperCase() };
  }
  const linearUrl = value.match(
    /linear\.app\/[^/]+\/issue\/([A-Za-z][A-Za-z0-9]+-\d+)/i,
  );
  if (linearUrl) {
    return { type: 'issue', ref: linearUrl[1].toUpperCase() };
  }
  if (/github\.com\/[^/]+\/[^/]+\/pull\/\d+/i.test(value)) {
    return { type: 'pr', ref: value };
  }
  if (/github\.com\/[^/]+\/[^/]+\/issues\/\d+/i.test(value)) {
    return { type: 'issue', ref: value };
  }
  if (/^#\d+$/.test(value)) {
    return { type: 'issue', ref: value };
  }
  return { type: 'text', ref: value };
}

// Normalise une ref Linear en majuscules quand c'est un ID Linear.
export function normalizeRef(ref: string): string {
  return isLinearRef(ref.toUpperCase()) ? ref.toUpperCase() : ref;
}

interface GithubRef {
  owner: string;
  repo: string;
  num: string;
  kind: 'issues' | 'pulls';
}

function parseGithubRef(ref: string): GithubRef | undefined {
  const url = ref.match(/github\.com\/([^/]+)\/([^/]+)\/(issues|pull)\/(\d+)/i);
  if (url) {
    return {
      owner: url[1],
      repo: url[2],
      kind: url[3].toLowerCase() === 'pull' ? 'pulls' : 'issues',
      num: url[4],
    };
  }
  return undefined;
}

// Extrait owner/repo d'une URL de remote git (HTTPS ou SSH).
function parseGithubRemote(
  url: string,
): { owner: string; repo: string } | undefined {
  const m = url.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/i);
  return m ? { owner: m[1], repo: m[2] } : undefined;
}

// Repo GitHub du workspace courant, via le remote "origin" (puis le 1er remote trouvé).
async function getWorkspaceGithubRepo(): Promise<
  { owner: string; repo: string } | undefined
> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    return undefined;
  }
  const cwd = folder.uri.fsPath;
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['remote', 'get-url', 'origin'],
      { cwd },
    );
    return parseGithubRemote(stdout.trim());
  } catch {
    try {
      const { stdout: remotes } = await execFileAsync('git', ['remote'], {
        cwd,
      });
      const remote = remotes.trim().split('\n')[0];
      if (!remote) {
        return undefined;
      }
      const { stdout: url } = await execFileAsync(
        'git',
        ['remote', 'get-url', remote],
        { cwd },
      );
      return parseGithubRemote(url.trim());
    } catch {
      return undefined;
    }
  }
}

// Résout une ref GitHub : URL complète, ou #123 + repo du workspace courant.
export async function resolveGithubRef(
  ref: string,
  type: WorkspaceType,
): Promise<GithubRef | undefined> {
  const fromUrl = parseGithubRef(ref);
  if (fromUrl) {
    return fromUrl;
  }
  const short = ref.match(/^#(\d+)$/);
  if (short) {
    const repo = await getWorkspaceGithubRepo();
    if (repo) {
      return {
        ...repo,
        num: short[1],
        kind: type === 'pr' ? 'pulls' : 'issues',
      };
    }
  }
  return undefined;
}

// Canonicalise une ref : #123 devient l'URL complète du repo courant quand on la connaît.
export async function canonicalizeRef(
  type: WorkspaceType,
  ref: string,
): Promise<string> {
  if (type !== 'issue' && type !== 'pr') {
    return ref;
  }
  const gh = await resolveGithubRef(ref, type);
  if (!gh) {
    return ref;
  }
  const path = gh.kind === 'pulls' ? 'pull' : 'issues';
  return `https://github.com/${gh.owner}/${gh.repo}/${path}/${gh.num}`;
}

async function fetchGithubTitle(gh: GithubRef): Promise<string | undefined> {
  // Pas de createIfNone ici : on ne déclenche pas un flow OAuth juste pour un titre.
  const session = await getGithubSession(false);
  if (!session) {
    return undefined;
  }
  const res = await fetch(
    `https://api.github.com/repos/${gh.owner}/${gh.repo}/${gh.kind}/${gh.num}`,
    {
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'smart-explorer',
      },
    },
  );
  if (!res.ok) {
    return undefined;
  }
  const data = (await res.json()) as { title?: string };
  return data.title;
}

async function fetchLinearTitle(
  identifier: string,
  context: vscode.ExtensionContext,
): Promise<string | undefined> {
  const token = await getLinearToken(context);
  if (!token) {
    return undefined;
  }
  const res = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: { Authorization: token, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: 'query($id: String!) { issue(id: $id) { title } }',
      variables: { id: identifier },
    }),
  });
  if (!res.ok) {
    return undefined;
  }
  const data = (await res.json()) as { data?: { issue?: { title?: string } } };
  return data.data?.issue?.title;
}

// Récupère le titre de l'issue/PR pour pré-remplir le nom du workspace.
// Retourne undefined en cas d'échec : le flux retombe sur le nom par défaut.
export async function fetchRefTitle(
  type: WorkspaceType,
  ref: string,
  context: vscode.ExtensionContext,
): Promise<string | undefined> {
  try {
    if ((type === 'issue' || type === 'smart') && isLinearRef(ref)) {
      return await fetchLinearTitle(ref, context);
    }
    if (type === 'issue' || type === 'pr') {
      const gh = await resolveGithubRef(ref, type);
      if (gh) {
        return await fetchGithubTitle(gh);
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}
