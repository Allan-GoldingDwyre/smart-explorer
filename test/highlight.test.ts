import assert from 'node:assert/strict';
import { test } from 'node:test';
import { highlightLines, languageOf } from '../src/walkthrough/highlight';
import {
  renderWalkthroughBody,
  renderWalkthroughPage,
  styleVars,
} from '../src/walkthrough/walkthroughHtml';

test('languageOf : d’après l’extension', () => {
  assert.equal(languageOf('a/b.py'), 'python');
  assert.equal(languageOf('x.tsx'), 'typescript');
  assert.equal(languageOf('Makefile'), undefined);
});

test('highlightLines : une chaîne par ligne, jetons multi-lignes refermés', () => {
  const lines = highlightLines(
    'def f():\n    """a\n    b"""\n    return 1',
    'a.py',
  )!;
  assert.equal(lines.length, 4);
  assert.match(lines[0], /<span class="hljs-keyword">def<\/span>/);
  for (const l of lines) {
    const open = (l.match(/<span/g) ?? []).length;
    const close = (l.match(/<\/span>/g) ?? []).length;
    assert.equal(open, close);
  }
  assert.equal(highlightLines('x', 'Makefile'), undefined);
});

test('rendu : l’extrait est coloré, pas le diff', () => {
  const wt = {
    title: 'T',
    steps: [
      {
        id: 's',
        title: 't',
        text: 'x',
        refs: [
          { path: 'a.py', start: 1, snippet: 'def f(): pass' },
          {
            path: 'a.py',
            start: 1,
            diff: true,
            snippet: '@@ -1 +1 @@\n+def g(): pass',
          },
        ],
        updated_at: '',
      },
    ],
    created_at: '',
    updated_at: '',
  };
  const html = renderWalkthroughBody(wt);
  assert.equal((html.match(/hljs-keyword/g) ?? []).length, 2);
});

test('styleVars : valeurs filtrées, vides ignorées', () => {
  const vars = styleVars({
    fontFamily: 'Georgia, serif',
    accentColor: '#e5a50a',
    codeBackground: 'red; } body { display: none',
  });
  assert.equal(vars['--se-font'], 'Georgia, serif');
  assert.equal(vars['--se-accent'], '#e5a50a');
  assert.equal(vars['--se-code-bg'], '');
  assert.equal(vars['--se-font-size'], '');
  const page = renderWalkthroughPage(
    { title: 'T', steps: [], created_at: '', updated_at: '' },
    'n',
    'csp',
    { accentColor: '#e5a50a', codeBackground: '};x' },
  );
  assert.ok(page.includes('--se-accent: #e5a50a;'));
  assert.ok(!page.includes('};x'));
});

test('preset : notion si demandé, vscode sinon', () => {
  const wt = { title: 'T', steps: [], created_at: '', updated_at: '' };
  assert.ok(
    renderWalkthroughPage(wt, 'n', 'c', { preset: 'notion' }).includes(
      '<body class="preset-notion">',
    ),
  );
  assert.ok(
    renderWalkthroughPage(wt, 'n', 'c', { preset: 'x' }).includes(
      '<body class="preset-vscode">',
    ),
  );
});
