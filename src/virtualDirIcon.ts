// Résolution d'icône (codicon) pour un virtual dir de l'arbre.
// Si le YAML fournit `icon`, il est utilisé tel quel ; sinon on déduit un
// codicon du nom du dossier. Ce résolveur vit dans l'extension, pas dans
// l'agent.

const NAME_RULES: [RegExp, string][] = [
  [/\btest|spec|qa\b/i, 'beaker'],
  [/\bfront|web|ui|client|browser|react|vue|angular\b/i, 'browser'],
  [/agent|openai|llm|mistral|gpt|\bai\b/i, 'robot'],
  [/deploy|ci|cd|docker|k8s|infra|release|ship/i, 'rocket'],
  [/back|api|server|endpoint|route/i, 'server'],
  [/util|tool|helper|lib/i, 'tools'],
  [/doc|readme|guide/i, 'book'],
  [/config|setting|env/i, 'settings-gear'],
  [/data|db|database|model|schema|store|storage/i, 'database'],
  [/auth|login|security|permission/i, 'key'],
  [/\blog\b|monitor|observ|metric/i, 'pulse'],
  [/design|style|css|theme/i, 'paintcan'],
];

export const DEFAULT_DIR_ICON = 'folder';

export function iconForVirtualDir(name: string, icon?: string): string {
  if (icon && icon.trim()) {
    return icon.trim();
  }
  for (const [pattern, codicon] of NAME_RULES) {
    if (pattern.test(name)) {
      return codicon;
    }
  }
  return DEFAULT_DIR_ICON;
}
