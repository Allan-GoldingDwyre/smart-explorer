import './test-home';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { focusTool } from '../src/mcp/focusTools';
import type { ToolEnv } from '../src/mcp/toolEnv';
import {
  createWorkspaceTool,
  getWorkspaceTool,
  setActiveWorkspaceTool,
  setFilesTool,
} from '../src/mcp/workspaceTools';
import { readActive, readFocus } from '../src/core/workspaceStore';

function makeTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'smart-explorer-mcp-'));
}

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function makeGitRoot(): string {
  const root = makeTempRoot();
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 't@example.com']);
  git(root, ['config', 'user.name', 'T']);
  git(root, ['config', 'commit.gpgsign', 'false']); // indépendant de la config globale
  return root;
}

function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function makeEnv(root: string, extra: Partial<ToolEnv> = {}): ToolEnv {
  return { root, now: () => new Date('2026-11-19T10:00:00Z'), ...extra };
}

test('focus : écrit la demande (focus.json) (ligne, extrait, workspace) et retourne le chemin absolu', async () => {
  const root = makeTempRoot();
  write(root, 'src/a.ts', 'x');
  const env = makeEnv(root);
  const { workspace_id } = await createWorkspaceTool(env, { name: 'txt' });
  const res = await focusTool(env, {
    path: './src/a.ts',
    line: 12,
    end_line: 20,
    match: 'fn start',
    workspace_id,
  });
  assert.equal(res.absolute_path, path.join(root, 'src/a.ts'));
  assert.equal(res.exists, true);
  const focus = readFocus(root);
  assert.equal(focus?.path, 'src/a.ts');
  assert.equal(focus?.line, 12);
  assert.equal(focus?.end_line, 20);
  assert.equal(focus?.match, 'fn start');
  assert.equal(focus?.workspace_id, workspace_id);
  assert.equal(focus?.at, '2026-11-19T10:00:00.000Z');
  await assert.rejects(
    () => focusTool(env, { path: 'a', workspace_id: 'nope' }),
    /introuvable/,
  );
  assert.equal((await focusTool(env, { path: 'absent.ts' })).exists, false);
});

test('focus sans workspace_id : suit le workspace qui contient le fichier (PR 326 vs issue 118)', async () => {
  const root = makeTempRoot();
  const env = makeEnv(root);
  const issue = (await createWorkspaceTool(env, { links: ['ARCHON-118'] }))
    .workspace_id;
  const pr = (
    await createWorkspaceTool(env, {
      links: ['https://github.com/o/r/pull/326'],
    })
  ).workspace_id;
  await setFilesTool(env, {
    workspace_id: issue,
    files: ['svc/a.py', 'shared.py'],
  });
  await setFilesTool(env, {
    workspace_id: pr,
    files: ['crate/b.rs', 'shared.py'],
  });
  await setActiveWorkspaceTool(env, { workspace_id: issue });

  // fichier propre à la PR : la vue bascule sur la PR
  await focusTool(env, { path: 'crate/b.rs' });
  assert.equal(readActive(root), pr);
  assert.equal(readFocus(root)?.workspace_id, pr);

  // fichier présent dans les deux : l'actif reste en place
  await focusTool(env, { path: 'shared.py' });
  assert.equal(readActive(root), pr);
  await setActiveWorkspaceTool(env, { workspace_id: issue });
  await focusTool(env, { path: './shared.py' });
  assert.equal(readActive(root), issue);

  // fichier connu d'aucun workspace : pas de basculement
  await focusTool(env, { path: 'ailleurs.txt' });
  assert.equal(readActive(root), issue);
  assert.equal(readFocus(root)?.workspace_id, undefined);

  // workspace_id explicite : prioritaire
  await focusTool(env, { path: 'svc/a.py', workspace_id: pr });
  assert.equal(readActive(root), pr);
});

test('focus avec diff : révisions validées, demande enregistrée', async () => {
  const root = makeGitRoot();
  write(root, 'src/a.rs', 'v1\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'c1']);
  const base = git(root, ['rev-parse', 'HEAD']);
  write(root, 'src/a.rs', 'v2\n');
  git(root, ['commit', '-qam', 'c2']);
  const env = makeEnv(root);

  await focusTool(env, {
    path: 'src/a.rs',
    line: 1,
    end_line: 1,
    diff: { from: base, to: 'HEAD', side: 'old' },
  });
  const focus = readFocus(root);
  assert.deepEqual(focus?.diff, { from: base, to: 'HEAD', side: 'old' });

  // `to` absent = code actuel ; renommage via from_path
  await focusTool(env, {
    path: 'src/b.rs',
    diff: { from: 'HEAD~1', from_path: 'src/a.rs' },
  });
  assert.equal(readFocus(root)?.diff?.from_path, 'src/a.rs');

  await assert.rejects(
    () => focusTool(env, { path: 'src/a.rs', diff: { from: 'nope' } }),
    /introuvable/,
  );
  await assert.rejects(
    () => focusTool(env, { path: 'src/a.rs', diff: { from: '--output=x' } }),
    /invalide/,
  );
  await assert.rejects(
    () =>
      focusTool(env, {
        path: 'src/a.rs',
        diff: { from: 'HEAD', from_path: '../secret' },
      }),
    /chemin invalide/,
  );
  // sans diff : comportement inchangé
  await focusTool(env, { path: 'src/a.rs', line: 2 });
  assert.equal(readFocus(root)?.diff, undefined);
});

test('focus : garde-fous de granularité et de diff', async () => {
  const root = makeGitRoot();
  const lines = (n: number, tag: string) =>
    Array.from({ length: n }, (_, i) => `${tag}${i + 1}`).join('\n') + '\n';
  write(root, 'src/small.rs', lines(10, 'a'));
  write(root, 'src/big.rs', lines(200, 'b'));
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'c1']);
  const base = git(root, ['rev-parse', 'HEAD']);
  write(root, 'src/small.rs', lines(10, 'a').replace('a3', 'CHANGED')); // 1 ligne modifiée
  write(root, 'src/big.rs', lines(200, 'z')); // réécriture totale
  write(root, 'src/new.rs', lines(300, 'n')); // fichier nouveau
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'c2']);
  const env = makeEnv(root);

  // petit changement sur un fichier existant : le diff est conservé
  const ok = await focusTool(env, {
    path: 'src/small.rs',
    line: 3,
    diff: { from: base, to: 'HEAD' },
  });
  assert.equal(ok.notes, undefined);
  assert.equal(readFocus(root)?.diff?.from, base);

  // réécriture totale : diff ignoré (trop gros), code actuel affiché
  const big = await focusTool(env, {
    path: 'src/big.rs',
    line: 1,
    diff: { from: base, to: 'HEAD' },
  });
  assert.match(big.notes?.join(' ') ?? '', /diff ignoré.*lignes modifiées/);
  assert.equal(readFocus(root)?.diff, undefined);

  // fichier nouveau : pas de diff, code actuel
  const created = await focusTool(env, {
    path: 'src/new.rs',
    line: 1,
    diff: { from: base, to: 'HEAD' },
  });
  assert.match(created.notes?.join(' ') ?? '', /fichier nouveau/);
  assert.equal(readFocus(root)?.diff, undefined);

  // fichier inchangé : pas de diff vide
  write(root, 'src/same.rs', 'x\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'c3']);
  const same = await focusTool(env, {
    path: 'src/same.rs',
    diff: { from: 'HEAD~0', to: 'HEAD' },
  });
  assert.match(same.notes?.join(' ') ?? '', /aucun changement/);

  // plage énorme (« tout le fichier ») : plafonnée à 25 lignes
  const clamped = await focusTool(env, {
    path: 'src/new.rs',
    line: 1,
    end_line: 300,
  });
  assert.match(clamped.notes?.join(' ') ?? '', /plafonnée à 25 lignes/);
  assert.equal(readFocus(root)?.end_line, 25);

  // une plage normale n'est pas touchée ; sans line, end_line est ignorée
  await focusTool(env, { path: 'src/new.rs', line: 10, end_line: 20 });
  assert.equal(readFocus(root)?.end_line, 20);
  const whole = await focusTool(env, { path: 'src/new.rs', end_line: 50 });
  assert.match(whole.notes?.join(' ') ?? '', /end_line ignorée/);
  assert.equal(readFocus(root)?.end_line, undefined);
  assert.equal(readFocus(root)?.line, undefined); // fichier entier
});

test('tools : workspace inconnu -> erreur', async () => {
  const env = makeEnv(makeTempRoot());
  await assert.rejects(
    () => getWorkspaceTool(env, { workspace_id: 'nope' }),
    /introuvable/,
  );
});
