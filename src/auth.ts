import * as vscode from 'vscode';

const GITHUB_SCOPES = ['repo', 'read:user'];
const LINEAR_SECRET_KEY = 'smartExplorer.linearApiKey';

export async function getGithubSession(createIfNone = false): Promise<vscode.AuthenticationSession | undefined> {
  return vscode.authentication.getSession('github', GITHUB_SCOPES, { createIfNone });
}

export async function hasGithubSession(): Promise<boolean> {
  return !!(await getGithubSession(false));
}

export function logoutGithub(): void {
  vscode.window.showInformationMessage(
    'GitHub sign-out is managed by VS Code itself: click the Accounts icon (bottom of the Activity Bar) → Sign Out.'
  );
}

export async function loginGithub(): Promise<boolean> {
  const session = await vscode.authentication.getSession('github', GITHUB_SCOPES, { createIfNone: true });
  if (session) {
    vscode.window.showInformationMessage(`Connecté à GitHub en tant que ${session.account.label}.`);
  }
  return !!session;
}

// Pattern Docker : on demande la session au moment de l'appel API.
// Si l'utilisateur n'est pas connecté, VS Code déclenche le flow OAuth lui-même.
export async function ensureGithubSession(): Promise<vscode.AuthenticationSession> {
  const session = await vscode.authentication.getSession('github', GITHUB_SCOPES, { createIfNone: true });
  if (!session) {
    throw new Error('GitHub authentication required');
  }
  return session;
}

export function isLinearRef(ref: string): boolean {
  return /^[A-Z][A-Z0-9]+-\d+$/.test(ref.trim());
}

export function isGithubRef(ref: string): boolean {
  return /github\.com\/[^/]+\/[^/]+\/(issues|pull)\/\d+/.test(ref);
}

export async function getLinearToken(context: vscode.ExtensionContext): Promise<string | undefined> {
  const fromSecrets = await context.secrets.get(LINEAR_SECRET_KEY);
  return fromSecrets || undefined;
}

export async function setupLinear(context: vscode.ExtensionContext): Promise<void> {
  const key = await vscode.window.showInputBox({
    title: 'Setup Linear',
    prompt: 'Colle ta clé API Linear (Linear → Settings → Security & access → Personal API keys)',
    placeHolder: 'lin_api_...',
    password: true
  });
  if (key) {
    await context.secrets.store(LINEAR_SECRET_KEY, key);
    vscode.window.showInformationMessage('Clé API Linear enregistrée (stockée chiffrée).');
  }
}

export async function logoutLinear(context: vscode.ExtensionContext): Promise<void> {
  await context.secrets.delete(LINEAR_SECRET_KEY);
  vscode.window.showInformationMessage('Clé API Linear supprimée.');
}

export async function checkAuthForRef(
  context: vscode.ExtensionContext,
  type: string,
  ref: string
): Promise<void> {
  // GitHub : rien à vérifier ici, VS Code gère la session au moment de l'appel API (ensureGithubSession).
  const needsLinear = type === 'issue' || type === 'smart' ? isLinearRef(ref) : false;
  if (needsLinear) {
    const token = await getLinearToken(context);
    if (!token) {
      const action = await vscode.window.showWarningMessage(
        'Aucune clé API Linear configurée (optionnel).',
        'Setup Linear'
      );
      if (action) {
        await setupLinear(context);
      }
    }
  }
}
