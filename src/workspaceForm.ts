import * as vscode from 'vscode';
import { checkAuthForRef } from './auth';
import { canonicalizeRef, detectRef, fetchRefTitle, normalizeRef } from './refs';
import { TypePickItem, WorkspaceEntry, WorkspaceType, truncate } from './types';

export async function runAddWorkspaceFlow(context: vscode.ExtensionContext): Promise<WorkspaceEntry | undefined> {
  const typePick = await vscode.window.showQuickPick<TypePickItem>(
    [
      { label: '$(lightbulb) Smart', description: 'Auto-detect from a link or ID (e.g. #376)', type: 'smart' },
      { label: '$(issue-opened) Issue', description: 'Linear or GitHub', type: 'issue' },
      { label: '$(git-pull-request) PR', description: 'GitHub pull request', type: 'pr' },
      { label: '$(note) Text', description: 'Free-form description', type: 'text' }
    ],
    {
      title: 'Add Workspace',
      placeHolder: 'What do you want to add?'
    }
  );
  if (!typePick) {
    return undefined;
  }

  const { ref, detectedType, defaultName } = await promptForRef(typePick.type);
  if (ref === undefined) {
    return undefined;
  }

  // En mode Smart, le type réel vient de la détection sur la ref saisie.
  const type = typePick.type === 'smart' ? detectedType : typePick.type;
  // #123 est résolu en URL complète via le remote git du workspace courant.
  const normalizedRef = await canonicalizeRef(type, normalizeRef(ref));

  await checkAuthForRef(context, type, normalizedRef);

  // Essaie de récupérer le titre réel (issue/PR) pour pré-remplir le nom.
  const title = await fetchRefTitle(type, normalizedRef, context);
  const suggestedName = title ? truncate(title, 60) : defaultName;

  const name = await vscode.window.showInputBox({
    title: 'Add Workspace',
    prompt: 'Nom du workspace',
    value: suggestedName
  });
  if (!name) {
    return undefined;
  }

  return { name, type, ref: normalizedRef };
}

async function promptForRef(type: WorkspaceType): Promise<{
  ref: string | undefined;
  detectedType: WorkspaceType;
  defaultName: string;
}> {
  switch (type) {
    case 'issue':
      return { ...(await singleInput(
        'Add Issue',
        'Lien ou ID de l\'issue (Linear, GitHub : #376, lin-123, URL...)',
        'lin-123 ou #376 ou https://github.com/org/repo/issues/376'
      )), detectedType: 'issue' };
    case 'pr':
      return { ...(await singleInput(
        'Add PR',
        'Lien ou numéro de la PR GitHub (#42, URL...)',
        '#42 ou https://github.com/org/repo/pull/42'
      )), detectedType: 'pr' };
    case 'smart': {
      const input = await vscode.window.showInputBox({
        title: 'Smart Add',
        prompt: 'Colle un lien ou un ID, le type sera détecté automatiquement (#376, URL...)',
        placeHolder: 'https://github.com/org/repo/issues/376'
      });
      if (input === undefined) {
        return { ref: undefined, detectedType: 'text', defaultName: '' };
      }
      const detected = detectRef(input);
      return { ref: detected.ref, detectedType: detected.type, defaultName: defaultNameFor(detected.type, detected.ref) };
    }
    case 'text': {
      const ref = await vscode.window.showInputBox({
        title: 'Text Workspace',
        prompt: 'Description',
        placeHolder: 'Écris le contexte ici...'
      });
      return { ref, detectedType: 'text', defaultName: ref ? truncate(ref) : '' };
    }
  }
}

function defaultNameFor(type: WorkspaceType, ref: string): string {
  switch (type) {
    case 'issue':
      return `ISSUE ${truncate(ref)}`;
    case 'pr':
      return `PR ${truncate(ref)}`;
    default:
      return truncate(ref);
  }
}

async function singleInput(
  title: string,
  prompt: string,
  placeHolder: string
): Promise<{ ref: string | undefined; defaultName: string }> {
  const ref = await vscode.window.showInputBox({ title, prompt, placeHolder });
  return { ref, defaultName: ref ? `${title.replace('Add ', '').toUpperCase()} ${truncate(ref)}` : '' };
}
