// Accès GitHub déterministe via `git` et `gh` (si installé). Aucune dépendance
// à vscode. Tout échec renvoie undefined : l'appelant garde alors le lien en
// `unknown` plutôt que de perdre l'information.
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { GithubLookup, GithubResolver } from './links';

const execFileAsync = promisify(execFile);

// owner/repo d'un remote GitHub (https ou ssh).
export function parseGithubRemote(url: string): string | undefined {
  const m = url
    .trim()
    .match(/github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i);
  return m?.[1];
}

export async function originRepo(root: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['remote', 'get-url', 'origin'],
      { cwd: root },
    );
    return parseGithubRemote(stdout);
  } catch {
    return undefined;
  }
}

// `gh api repos/<repo>/issues/<n>` : le champ `pull_request` n'existe que pour
// une PR (les PR sont aussi des issues côté API).
export const ghResolver: GithubResolver = async (repo, number) => {
  try {
    const { stdout } = await execFileAsync(
      'gh',
      ['api', `repos/${repo}/issues/${number}`],
      { timeout: 15000 },
    );
    const data = JSON.parse(stdout);
    const found: GithubLookup = {
      kind: data.pull_request ? 'github-pr' : 'github-issue',
      title: typeof data.title === 'string' ? data.title : undefined,
      url: typeof data.html_url === 'string' ? data.html_url : undefined,
    };
    return found;
  } catch {
    return undefined;
  }
};
