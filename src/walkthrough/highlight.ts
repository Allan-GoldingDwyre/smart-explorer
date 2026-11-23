// Coloration syntaxique des extraits (highlight.js, côté extension : le webview
// n'a pas accès au tokenizer de VS Code). Module pur.
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import go from 'highlight.js/lib/languages/go';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

const LANGUAGES = {
  bash,
  css,
  go,
  ini,
  java,
  javascript,
  json,
  markdown,
  python,
  ruby,
  rust,
  sql,
  typescript,
  xml,
  yaml,
};
for (const [name, def] of Object.entries(LANGUAGES)) {
  hljs.registerLanguage(name, def);
}

const BY_EXT: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  rb: 'ruby',
  sh: 'bash',
  zsh: 'bash',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  md: 'markdown',
  css: 'css',
  html: 'xml',
  xml: 'xml',
  sql: 'sql',
  toml: 'ini',
  ini: 'ini',
};

export function languageOf(file: string): string | undefined {
  const dot = file.lastIndexOf('.');
  return dot < 0 ? undefined : BY_EXT[file.slice(dot + 1).toLowerCase()];
}

// Coupe le HTML coloré ligne par ligne : un jeton qui s'étend sur plusieurs
// lignes (commentaire, chaîne) est refermé en fin de ligne puis rouvert.
function splitLines(html: string): string[] {
  const lines: string[] = [];
  const open: string[] = [];
  let cur = '';
  for (const part of html.split(/(<span[^>]*>|<\/span>|\n)/)) {
    if (part === '\n') {
      lines.push(cur + '</span>'.repeat(open.length));
      cur = open.join('');
    } else {
      cur += part;
      if (part.startsWith('<span')) {
        open.push(part);
      } else if (part === '</span>') {
        open.pop();
      }
    }
  }
  lines.push(cur);
  return lines;
}

// Une chaîne HTML par ligne ; `undefined` si le langage n'est pas géré.
export function highlightLines(
  code: string,
  file: string,
): string[] | undefined {
  const language = languageOf(file);
  if (!language) {
    return undefined;
  }
  try {
    const { value } = hljs.highlight(code, { language, ignoreIllegals: true });
    return splitLines(value);
  } catch {
    return undefined;
  }
}
