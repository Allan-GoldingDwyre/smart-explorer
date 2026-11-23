// Visite guidée : une page markdown par visite, rendue par l'aperçu markdown
// natif de VS Code (rien à recréer côté éditeur). Module pur, sans dépendance
// à vscode.
//
//   walkthrough.json  état (écrit par le serveur MCP) : titre, étapes, extraits
//   walkthrough.md    rendu de ce JSON, régénéré à chaque modification ;
//                     l'extension l'ouvre dans l'aperçu markdown, qui se
//                     rafraîchit tout seul
//
// Les questions de l'utilisateur passent par l'agent (terminal) : il met à jour
// l'étape concernée (même `id`) en même temps qu'il répond.
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { ensureProjectDir, projectDataDir } from '../core/workspaceStore';

export type WalkMode = 'flow' | 'changes' | 'review';

// Zone de code citée par une étape. `snippet` est figé à la création : la page
// reste lisible même si le code change ensuite.
export interface WalkRef {
  path: string;
  // Première / dernière ligne de l'extrait (1-based), si une zone est visée.
  start?: number;
  end?: number;
  // Diff unifié au lieu du code (changement de petite taille).
  diff?: boolean;
  snippet?: string;
}

export interface WalkStep {
  id: string;
  title: string;
  // Explication concise (markdown).
  text: string;
  refs: WalkRef[];
  updated_at: string;
}

export interface Walkthrough {
  title: string;
  mode?: WalkMode;
  workspace_id?: string;
  steps: WalkStep[];
  created_at: string;
  updated_at: string;
}

export function walkthroughFilePath(root: string): string {
  return path.join(projectDataDir(root), 'walkthrough.json');
}

export function walkthroughMarkdownPath(root: string): string {
  return path.join(projectDataDir(root), 'walkthrough.md');
}

export function readWalkthrough(root: string): Walkthrough | undefined {
  try {
    const data = JSON.parse(fs.readFileSync(walkthroughFilePath(root), 'utf8'));
    return data && Array.isArray(data.steps) ? data : undefined;
  } catch {
    return undefined;
  }
}

// Écrit l'état puis le rendu (le markdown en dernier : c'est lui que
// l'extension surveille, l'état est donc déjà à jour quand elle réagit).
export function writeWalkthrough(root: string, wt: Walkthrough): void {
  ensureProjectDir(root);
  fs.writeFileSync(walkthroughFilePath(root), JSON.stringify(wt, null, 2));
  fs.writeFileSync(walkthroughMarkdownPath(root), renderWalkthrough(wt, root));
}

export function deleteWalkthrough(root: string): boolean {
  let removed = false;
  for (const file of [
    walkthroughFilePath(root),
    walkthroughMarkdownPath(root),
  ]) {
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
      removed = true;
    }
  }
  return removed;
}

const LANGS: Record<string, string> = {
  ts: 'ts',
  tsx: 'tsx',
  js: 'js',
  jsx: 'jsx',
  py: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  rb: 'ruby',
  sh: 'bash',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  md: 'markdown',
  css: 'css',
  html: 'html',
  sql: 'sql',
  toml: 'toml',
};

export function languageOf(file: string): string {
  return LANGS[path.extname(file).slice(1).toLowerCase()] ?? '';
}

// Un bloc de code ne doit pas pouvoir être fermé par son propre contenu.
function fence(content: string): string {
  const longest = Math.max(
    2,
    ...[...content.matchAll(/`{3,}/g)].map((m) => m[0].length),
  );
  return '`'.repeat(longest + 1);
}

function refLabel(ref: WalkRef): string {
  if (ref.start === undefined) {
    return ref.path;
  }
  return ref.end !== undefined && ref.end > ref.start
    ? `${ref.path}:${ref.start}-${ref.end}`
    : `${ref.path}:${ref.start}`;
}

// Lien cliquable : l'aperçu markdown ouvre le fichier dans l'éditeur à la
// ligne du fragment `#L<n>`.
function refLink(ref: WalkRef, root: string): string {
  const url = pathToFileURL(path.join(root, ref.path)).href;
  return `[\`${refLabel(ref)}\`](${url}${
    ref.start !== undefined ? `#L${ref.start}` : ''
  })`;
}

export function renderWalkthrough(wt: Walkthrough, root: string): string {
  const out: string[] = [`# ${wt.title}`, ''];
  const meta = [wt.mode, wt.workspace_id].filter(Boolean);
  if (meta.length) {
    out.push(`_${meta.join(' · ')}_`, '');
  }
  if (!wt.steps.length) {
    out.push('_Aucune étape pour l’instant._', '');
  }
  wt.steps.forEach((step, i) => {
    out.push(`## ${i + 1}. ${step.title}`, '', step.text.trim(), '');
    for (const ref of step.refs) {
      out.push(refLink(ref, root), '');
      if (ref.snippet) {
        const lang = ref.diff ? 'diff' : languageOf(ref.path);
        const marks = fence(ref.snippet);
        out.push(`${marks}${lang}`, ref.snippet.replace(/\n$/, ''), marks, '');
      }
    }
  });
  return out.join('\n');
}
