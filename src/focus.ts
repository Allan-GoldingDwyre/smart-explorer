// Résolution de la ligne à mettre en avant dans un fichier. Module pur.
//
// Les numéros de ligne dérivent quand le code change : l'agent peut donc
// donner en plus un extrait de texte (`match`). Si la ligne indiquée ne le
// contient plus, on prend l'occurrence de l'extrait la plus proche.
export function resolveLine(
  content: string,
  line?: number,
  match?: string,
): number {
  const lines = content.split('\n');
  const wanted =
    line && line >= 1 ? Math.min(Math.floor(line), lines.length) : 1;
  if (!match) {
    return wanted;
  }
  if (lines[wanted - 1]?.includes(match)) {
    return wanted;
  }
  let best: number | undefined;
  lines.forEach((text, i) => {
    if (
      text.includes(match) &&
      (best === undefined || Math.abs(i + 1 - wanted) < Math.abs(best - wanted))
    ) {
      best = i + 1;
    }
  });
  return best ?? wanted;
}

// Quel workspace montrer pour un fichier ? Parmi ceux qui le contiennent
// (`holders`) : l'actif s'il en fait partie, sinon l'unique candidat. Plusieurs
// candidats sans l'actif : pas de basculement (ambigu).
export function workspaceForFile(
  holders: string[],
  active?: string,
): string | undefined {
  if (active && holders.includes(active)) {
    return active;
  }
  return holders.length === 1 ? holders[0] : undefined;
}

// Plage à surligner : `line` (début) et `end_line` (fin, incluse). Si le début
// a été retrouvé ailleurs grâce à `match`, la fin suit le même décalage. La fin
// est bornée au fichier et jamais avant le début.
export function resolveRange(
  content: string,
  line?: number,
  endLine?: number,
  match?: string,
): { start: number; end: number } {
  const total = content.split('\n').length;
  const start = resolveLine(content, line, match);
  if (!endLine || endLine < 1) {
    return { start, end: start };
  }
  const shift = start - Math.min(Math.max(line ?? 1, 1), total);
  const end = Math.min(Math.max(Math.floor(endLine) + shift, start), total);
  return { start, end };
}

// Une révision passée à git ne doit pas pouvoir être prise pour une option ni
// contenir d'espaces/métacaractères : SHA, branche, tag, HEAD~3, main@{1}…
export function isSafeRev(rev: string): boolean {
  return (
    /^[A-Za-z0-9_./~^@{}][A-Za-z0-9_./~^@{}-]*$/.test(rev) &&
    !rev.includes('..')
  );
}

// Chemin relatif au projet, sans remonter au-dessus de la racine.
export function isSafeRelPath(relPath: string): boolean {
  return (
    !!relPath &&
    !relPath.startsWith('/') &&
    !relPath.split('/').includes('..') &&
    !relPath.includes('\0')
  );
}

// --- Granularité de la mise en avant -----------------------------------------
//
//  - pas de `line`           : on parle du fichier entier -> pas de sélection ;
//  - `line` seule            : la ligne (ou, avec `match`, seulement ce texte) ;
//  - `line` + `end_line`     : une petite plage (partie de fonction, petite
//                              fonction), plafonnée à MAX_RANGE_LINES.
// Un diff n'a de sens que pour un changement de taille raisonnable.
export const MAX_RANGE_LINES = 25;
export const MAX_DIFF_LINES = 60;

// Fin de plage retenue : ignorée sans `line`, jamais avant le début, plafonnée.
export function clampEndLine(
  line: number | undefined,
  endLine: number | undefined,
): { end?: number; clamped: boolean } {
  if (line === undefined || endLine === undefined) {
    return { end: undefined, clamped: false };
  }
  const end = Math.max(endLine, line);
  if (end - line + 1 > MAX_RANGE_LINES) {
    return { end: line + MAX_RANGE_LINES - 1, clamped: true };
  }
  return { end, clamped: false };
}

export interface MarkRange {
  // Lignes 1-based, fin incluse.
  startLine: number;
  endLine: number;
  // Colonnes 0-based : présentes seulement pour une mise en avant « inline »
  // (une ligne + `match`) ; sinon les lignes entières sont mises en avant.
  startCol?: number;
  endCol?: number;
}

// Zone à mettre en avant dans `content`, ou undefined (fichier entier).
export function computeMarkRange(
  content: string,
  line?: number,
  endLine?: number,
  match?: string,
): MarkRange | undefined {
  if (!line && !match) {
    return undefined;
  }
  const lines = content.split('\n');
  const start = resolveLine(content, line, match);
  const { end } = clampEndLine(line ?? start, endLine);
  if (end !== undefined && end > start) {
    return { startLine: start, endLine: Math.min(end, lines.length) };
  }
  if (match) {
    const col = (lines[start - 1] ?? '').indexOf(match);
    if (col >= 0) {
      return {
        startLine: start,
        endLine: start,
        startCol: col,
        endCol: col + match.length,
      };
    }
  }
  return { startLine: start, endLine: start };
}

// Lignes (1-based) d'un document de diff unifié qui correspondent aux lignes
// `start`..`end` d'un côté du diff (`old` : numérotation d'avant, `new` :
// d'après). undefined si ces lignes ne figurent dans aucun hunk.
export function diffLineFor(
  diffText: string,
  side: 'old' | 'new',
  start: number,
  end: number,
): { first: number; last: number } | undefined {
  let oldNo = 0;
  let newNo = 0;
  let first: number | undefined;
  let last: number | undefined;
  let inHunk = false;
  diffText.split('\n').forEach((text, i) => {
    const header = text.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (header) {
      oldNo = Number(header[1]);
      newNo = Number(header[2]);
      inHunk = true;
      return;
    }
    if (!inHunk || text.startsWith('\\')) {
      return;
    }
    const kind = text[0];
    const isOld = kind === '-' || kind === ' ';
    const isNew = kind === '+' || kind === ' ';
    if (!isOld && !isNew) {
      return;
    }
    const no =
      side === 'old' ? (isOld ? oldNo : undefined) : isNew ? newNo : undefined;
    if (no !== undefined && no >= start && no <= end) {
      first = first ?? i + 1;
      last = i + 1;
    }
    if (isOld) oldNo++;
    if (isNew) newNo++;
  });
  return first === undefined || last === undefined
    ? undefined
    : { first, last };
}
