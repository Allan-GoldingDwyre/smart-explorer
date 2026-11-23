// Rendu HTML de la visite guidée (page webview). Module pur, sans dépendance à
// vscode : l'extension y injecte le résultat, et les clics sur un extrait
// remontent à l'extension (data-path / data-line / data-end).
import { highlightLines } from './highlight';
import { WalkRef, WalkStep, Walkthrough } from './walkthrough';

// Réglages d'apparence de la page (smartExplorer.walkthrough.*) ; une valeur
// vide laisse le thème VS Code décider. Posés comme variables CSS --se-*.
export interface WalkStyle {
  fontFamily?: string;
  fontSize?: string;
  codeFontFamily?: string;
  codeFontSize?: string;
  maxWidth?: string;
  accentColor?: string;
  codeBackground?: string;
  // Look de la page : « vscode » (thème de l'éditeur, défaut) ou « notion ».
  preset?: string;
}

export function presetOf(style: WalkStyle): 'vscode' | 'notion' {
  return style.preset === 'notion' ? 'notion' : 'vscode';
}

const STYLE_VARS: Record<Exclude<keyof WalkStyle, 'preset'>, string> = {
  fontFamily: '--se-font',
  fontSize: '--se-font-size',
  codeFontFamily: '--se-code-font',
  codeFontSize: '--se-code-size',
  maxWidth: '--se-max-width',
  accentColor: '--se-accent',
  codeBackground: '--se-code-bg',
};

// Variables CSS d'un réglage. Les valeurs sont filtrées : elles finissent dans
// du CSS, aucun caractère permettant d'en sortir n'est accepté.
export function styleVars(style: WalkStyle): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const key of Object.keys(STYLE_VARS) as (keyof typeof STYLE_VARS)[]) {
    const value = (style[key] ?? '').trim();
    vars[STYLE_VARS[key]] = /^[\w\s,.'"#%()-]+$/.test(value) ? value : '';
  }
  return vars;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Markdown minimal et sûr (tout est échappé d'abord) : `code`, **gras**,
// paragraphes, listes « - ».
function inline(s: string): string {
  return escapeHtml(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

export function renderText(text: string): string {
  return text
    .trim()
    .split(/\n{2,}/)
    .map((block) => {
      const lines = block.split('\n');
      if (lines.every((l) => /^\s*[-*] /.test(l))) {
        const items = lines.map(
          (l) => `<li>${inline(l.replace(/^\s*[-*] /, ''))}</li>`,
        );
        return `<ul>${items.join('')}</ul>`;
      }
      return `<p>${inline(lines.join('\n')).replace(/\n/g, '<br>')}</p>`;
    })
    .join('');
}

function refLabel(ref: WalkRef): string {
  if (ref.start === undefined) {
    return ref.path;
  }
  return ref.end !== undefined && ref.end > ref.start
    ? `${ref.path}:${ref.start}-${ref.end}`
    : `${ref.path}:${ref.start}`;
}

function renderCode(ref: WalkRef): string {
  const code = (ref.snippet ?? '').replace(/\n$/, '');
  const lines = code.split('\n');
  const colored = ref.diff ? undefined : highlightLines(code, ref.path);
  const rows = lines.map((line, i) => {
    if (ref.diff) {
      const kind =
        line.startsWith('+') && !line.startsWith('+++')
          ? 'add'
          : line.startsWith('-') && !line.startsWith('---')
            ? 'del'
            : line.startsWith('@@')
              ? 'hunk'
              : '';
      return `<div class="l ${kind}"><span class="n"></span><span class="t">${escapeHtml(
        line,
      )}</span></div>`;
    }
    const n = ref.start !== undefined ? ref.start + i : '';
    const text =
      colored && colored.length === lines.length
        ? colored[i]
        : escapeHtml(line);
    return `<div class="l"><span class="n">${n}</span><span class="t">${text}</span></div>`;
  });
  return `<pre>${rows.join('')}</pre>`;
}

function renderRef(ref: WalkRef): string {
  const attrs =
    `data-path="${escapeHtml(ref.path)}"` +
    (ref.start !== undefined ? ` data-line="${ref.start}"` : '') +
    (ref.end !== undefined ? ` data-end="${ref.end}"` : '');
  return (
    `<div class="ref"><a class="open" href="#" ${attrs}>${escapeHtml(
      refLabel(ref),
    )}${ref.diff ? ' <span class="tag">diff</span>' : ''}</a>` +
    (ref.snippet ? `<div class="code" ${attrs}>${renderCode(ref)}</div>` : '') +
    '</div>'
  );
}

function renderStep(step: WalkStep, i: number): string {
  return (
    `<section id="step-${i + 1}"><h2><span class="num">${
      i + 1
    }</span>${escapeHtml(step.title)}</h2>` +
    renderText(step.text) +
    step.refs.map(renderRef).join('') +
    '</section>'
  );
}

// Contenu de la page (remplacé à chaque mise à jour de la visite).
export function renderWalkthroughBody(wt: Walkthrough): string {
  const meta = [wt.mode, wt.workspace_id].filter(Boolean).join(' · ');
  const head =
    `<h1>${escapeHtml(wt.title)}</h1>` +
    (meta ? `<p class="meta">${escapeHtml(meta)}</p>` : '');
  if (!wt.steps.length) {
    return `${head}<p class="meta">Aucune étape pour l’instant.</p>`;
  }
  const toc = wt.steps
    .map(
      (s, i) =>
        `<li><a href="#step-${i + 1}" class="toc">${escapeHtml(
          s.title,
        )}</a></li>`,
    )
    .join('');
  return `${head}<ol class="toc">${toc}</ol>${wt.steps
    .map(renderStep)
    .join('')}`;
}

export function renderWalkthroughPage(
  wt: Walkthrough,
  nonce: string,
  cspSource: string,
  style: WalkStyle = {},
): string {
  return `<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}' ${cspSource}; script-src 'nonce-${nonce}';">
<title>Visite guidée</title>
<style nonce="${nonce}">
  body { font-family: var(--se-font, var(--vscode-font-family)); font-size: var(--se-font-size, var(--vscode-font-size)); color: var(--vscode-foreground); padding: 16px 32px 64px; line-height: 1.6; }
  main { max-width: var(--se-max-width, 960px); margin: 0 auto; }
  h1 { font-weight: 600; margin-bottom: 4px; }
  h2 { margin-top: 40px; padding-top: 16px; border-top: 1px solid var(--vscode-panel-border); display: flex; gap: 10px; align-items: baseline; }
  .num { color: var(--se-accent, var(--vscode-textLink-foreground)); font-variant-numeric: tabular-nums; }
  .meta { color: var(--vscode-descriptionForeground); margin-top: 0; }
  ol.toc { padding-left: 20px; color: var(--vscode-descriptionForeground); }
  a { color: var(--se-accent, var(--vscode-textLink-foreground)); text-decoration: none; }
  a:hover { text-decoration: underline; }
  code { font-family: var(--se-code-font, var(--vscode-editor-font-family)); background: var(--vscode-textCodeBlock-background); padding: 1px 5px; border-radius: 3px; }
  .ref { margin: 12px 0 20px; border: 1px solid var(--vscode-panel-border); border-radius: 6px; overflow: hidden; }
  .ref > a.open { display: block; padding: 6px 12px; font-family: var(--se-code-font, var(--vscode-editor-font-family)); font-size: 0.9em; background: var(--vscode-editorGroupHeader-tabsBackground); }
  .tag { font-size: 0.8em; color: var(--vscode-descriptionForeground); border: 1px solid var(--vscode-panel-border); border-radius: 3px; padding: 0 4px; }
  .code { cursor: pointer; background: var(--se-code-bg, var(--vscode-editor-background)); }
  .code:hover { outline: 1px solid var(--se-accent, var(--vscode-textLink-foreground)); outline-offset: -1px; }
  pre { margin: 0; padding: 8px 0; overflow-x: auto; font-family: var(--se-code-font, var(--vscode-editor-font-family)); font-size: var(--se-code-size, var(--vscode-editor-font-size)); line-height: 1.5; }
  .l { display: flex; white-space: pre; }
  .n { flex: 0 0 56px; text-align: right; padding-right: 14px; color: var(--vscode-editorLineNumber-foreground); user-select: none; }
  .l.add { background: var(--vscode-diffEditor-insertedLineBackground, rgba(46,160,67,.15)); }
  .l.del { background: var(--vscode-diffEditor-removedLineBackground, rgba(248,81,73,.15)); }
  .l.hunk { color: var(--vscode-descriptionForeground); }
  /* Coloration : palette sombre par défaut, claire selon le thème de VS Code. */
  body { --tk-keyword: #569cd6; --tk-string: #ce9178; --tk-number: #b5cea8; --tk-comment: #6a9955; --tk-title: #dcdcaa; --tk-type: #4ec9b0; --tk-attr: #9cdcfe; --tk-meta: #c586c0; }
  body.vscode-light { --tk-keyword: #0000ff; --tk-string: #a31515; --tk-number: #098658; --tk-comment: #008000; --tk-title: #795e26; --tk-type: #267f99; --tk-attr: #001080; --tk-meta: #af00db; }
  .hljs-keyword, .hljs-literal, .hljs-built_in, .hljs-selector-tag, .hljs-doctag { color: var(--tk-keyword); }
  .hljs-string, .hljs-regexp, .hljs-symbol, .hljs-template-variable, .hljs-addition { color: var(--tk-string); }
  .hljs-number, .hljs-bullet { color: var(--tk-number); }
  .hljs-comment, .hljs-quote, .hljs-deletion { color: var(--tk-comment); font-style: italic; }
  .hljs-title, .hljs-section, .hljs-function { color: var(--tk-title); }
  .hljs-type, .hljs-class .hljs-title, .hljs-title.class_ { color: var(--tk-type); }
  .hljs-attr, .hljs-attribute, .hljs-variable, .hljs-params, .hljs-property, .hljs-name, .hljs-selector-class, .hljs-selector-id { color: var(--tk-attr); }
  .hljs-meta, .hljs-subst { color: var(--tk-meta); }
  .hljs-emphasis { font-style: italic; }
  .hljs-strong { font-weight: bold; }
  /* Preset « notion » : page claire/sombre façon Notion (les réglages --se-* l'emportent). */
  body.preset-notion { --n-text: rgb(55, 53, 47); --n-muted: rgba(55, 53, 47, 0.65); --n-line: rgba(55, 53, 47, 0.09); --n-soft: rgb(247, 246, 243); --n-chip: rgba(135, 131, 120, 0.15); --n-red: #eb5757; --n-bg: #ffffff; --n-link: rgba(55, 53, 47, 0.4);
    --tk-keyword: #07a; --tk-string: #690; --tk-number: #905; --tk-comment: #999; --tk-title: #dd4a68; --tk-type: #905; --tk-attr: #690; --tk-meta: #999;
    background: var(--n-bg); color: var(--n-text); font-family: var(--se-font, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, "Apple Color Emoji", Arial, sans-serif); font-size: var(--se-font-size, 16px); line-height: 1.5; padding-top: 56px; }
  body.preset-notion:not(.vscode-light) { --n-text: rgba(255, 255, 255, 0.81); --n-muted: rgba(255, 255, 255, 0.46); --n-line: rgba(255, 255, 255, 0.094); --n-soft: rgb(37, 37, 37); --n-chip: rgba(135, 131, 120, 0.3); --n-red: #ff7369; --n-bg: #191919; --n-link: rgba(255, 255, 255, 0.4);
    --tk-keyword: #7ab7ff; --tk-string: #9bd47a; --tk-number: #ff9eb5; --tk-comment: #7d7d7d; --tk-title: #ffb86b; --tk-type: #ff9eb5; --tk-attr: #9bd47a; --tk-meta: #7d7d7d; }
  body.preset-notion main { max-width: var(--se-max-width, 720px); }
  body.preset-notion h1 { font-size: 2.5em; font-weight: 700; line-height: 1.2; margin: 0 0 8px; }
  body.preset-notion h2 { font-size: 1.5em; font-weight: 600; line-height: 1.3; border-top: 0; margin: 2em 0 4px; padding-top: 0; }
  body.preset-notion .num { color: var(--n-muted); font-weight: 500; }
  body.preset-notion .meta, body.preset-notion ol.toc { color: var(--n-muted); }
  body.preset-notion ol.toc { padding: 12px 16px 12px 32px; margin: 16px 0 0; background: var(--n-soft); border-radius: 4px; }
  body.preset-notion a { color: inherit; text-decoration: underline; text-decoration-color: var(--n-link); text-underline-offset: 2px; }
  body.preset-notion a:hover { text-decoration-color: currentColor; }
  body.preset-notion p { margin: 4px 0; padding: 3px 2px; }
  body.preset-notion ul { margin: 4px 0; }
  body.preset-notion code { font-family: var(--se-code-font, "SFMono-Regular", Menlo, Consolas, "PT Mono", "Liberation Mono", Courier, monospace); background: var(--n-chip); color: var(--n-red); font-size: 85%; padding: 0.2em 0.4em; border-radius: 4px; }
  body.preset-notion .ref { border: 0; border-radius: 4px; background: var(--se-code-bg, var(--n-soft)); margin: 8px 0 16px; }
  body.preset-notion .ref > a.open { background: transparent; color: var(--n-muted); text-decoration: none; font-family: var(--se-code-font, "SFMono-Regular", Menlo, Consolas, monospace); font-size: 12px; padding: 8px 16px 0; }
  body.preset-notion .ref > a.open:hover { color: var(--n-text); }
  body.preset-notion .tag { color: var(--n-muted); border-color: var(--n-line); }
  body.preset-notion .code { background: transparent; }
  body.preset-notion .code:hover { outline: 0; background: var(--n-chip); }
  body.preset-notion pre { padding: 8px 0 12px; font-family: var(--se-code-font, "SFMono-Regular", Menlo, Consolas, monospace); font-size: var(--se-code-size, 85%); line-height: 1.5; }
  body.preset-notion .n { color: var(--n-muted); opacity: 0.6; flex-basis: 48px; }
  body.preset-notion .hljs-comment, body.preset-notion .hljs-quote { font-style: normal; }
  body.preset-notion .l.hunk { color: var(--n-muted); }
</style>
<style id="custom" nonce="${nonce}">:root { ${Object.entries(styleVars(style))
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${v};`)
    .join(' ')} }</style></head>
<body class="preset-${presetOf(style)}"><main id="root">${renderWalkthroughBody(
    wt,
  )}</main>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const root = document.getElementById('root');
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-path]');
    if (el) {
      e.preventDefault();
      const num = (v) => (v === undefined ? undefined : Number(v));
      vscode.postMessage({ type: 'open', path: el.dataset.path, line: num(el.dataset.line), end_line: num(el.dataset.end) });
    }
  });
  window.addEventListener('message', (e) => {
    if (e.data.vars) {
      for (const [k, v] of Object.entries(e.data.vars)) {
        if (v) document.documentElement.style.setProperty(k, v);
        else document.documentElement.style.removeProperty(k);
      }
    }
    if (e.data.preset) {
      document.body.classList.remove('preset-vscode', 'preset-notion');
      document.body.classList.add('preset-' + e.data.preset);
    }
    if (typeof e.data.html === 'string') {
      const y = window.scrollY;
      root.innerHTML = e.data.html;
      window.scrollTo(0, y);
    }
  });
</script></body></html>`;
}
