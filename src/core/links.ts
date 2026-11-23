// Liens d'un workspace vers des issues / PR (GitHub ou Linear). Un workspace
// peut en porter plusieurs, et passer d'issues à PR sans rien perdre. Module
// pur (sans vscode, sans disque) : la résolution GitHub (issue ou PR ?) passe
// par un résolveur injectable (voir github.ts).

type LinkKind = 'github-issue' | 'github-pr' | 'linear-issue' | 'unknown';

export interface WorkspaceLink {
  kind: LinkKind;
  // Identifiant canonique : `owner/repo#123` (GitHub) ou `ARCHON-120` (Linear).
  ref: string;
  title?: string;
  url?: string;
}

export interface GithubLookup {
  kind: 'github-issue' | 'github-pr';
  title?: string;
  url?: string;
}

// Dit si `repo#number` est une issue ou une PR (undefined : introuvable).
export type GithubResolver = (
  repo: string,
  number: number,
) => Promise<GithubLookup | undefined>;

interface ResolveContext {
  // Dépôt de `origin` (owner/repo) pour les formes courtes `#123` / `123`.
  defaultRepo?: string;
  github?: GithubResolver;
}

// Ce qu'on sait d'une saisie sans réseau.
type ParsedLink =
  | { kind: 'link'; link: WorkspaceLink }
  | { kind: 'github-number'; repo?: string; number: number }
  | { kind: 'unknown'; raw: string };

const LINEAR_ID = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/;

function linearRef(team: string, num: string): string {
  return `${team.toUpperCase()}-${num}`;
}

export function parseLinkInput(input: string): ParsedLink {
  const value = input.trim();

  const linear = value.match(LINEAR_ID);
  if (linear) {
    return {
      kind: 'link',
      link: { kind: 'linear-issue', ref: linearRef(linear[1], linear[2]) },
    };
  }
  const linearUrl = value.match(
    /linear\.app\/[^/]+\/issue\/([A-Za-z][A-Za-z0-9]*)-(\d+)/i,
  );
  if (linearUrl) {
    return {
      kind: 'link',
      link: {
        kind: 'linear-issue',
        ref: linearRef(linearUrl[1], linearUrl[2]),
        url: value,
      },
    };
  }

  const githubUrl = value.match(
    /github\.com\/([^/\s]+\/[^/\s#?]+)\/(pull|issues)\/(\d+)/i,
  );
  if (githubUrl) {
    return {
      kind: 'link',
      link: {
        kind:
          githubUrl[2].toLowerCase() === 'pull' ? 'github-pr' : 'github-issue',
        ref: `${githubUrl[1]}#${githubUrl[3]}`,
        url: value,
      },
    };
  }

  const short = value.match(/^#?(\d+)$/);
  if (short) {
    return { kind: 'github-number', number: Number(short[1]) };
  }
  const withRepo = value.match(/^([^/\s#]+\/[^/\s#]+)#(\d+)$/);
  if (withRepo) {
    return {
      kind: 'github-number',
      repo: withRepo[1],
      number: Number(withRepo[2]),
    };
  }
  return { kind: 'unknown', raw: value };
}

export interface ResolvedLink {
  link: WorkspaceLink;
  // Explication quand la saisie n'a pas pu être résolue complètement.
  note?: string;
}

// Résout une saisie en lien. Ne perd jamais l'information : ce qu'on ne sait
// pas résoudre est conservé en `unknown` avec une note.
export async function resolveLink(
  input: string,
  ctx: ResolveContext = {},
): Promise<ResolvedLink> {
  const parsed = parseLinkInput(input);
  if (parsed.kind === 'link') {
    return { link: parsed.link };
  }
  if (parsed.kind === 'unknown') {
    return {
      link: { kind: 'unknown', ref: parsed.raw },
      note: `lien non reconnu : ${parsed.raw} (attendu : URL GitHub/Linear, owner/repo#N, #N ou ABC-123)`,
    };
  }
  const repo = parsed.repo ?? ctx.defaultRepo;
  if (!repo) {
    return {
      link: { kind: 'unknown', ref: `#${parsed.number}` },
      note: `#${parsed.number} : dépôt GitHub inconnu (pas de remote origin) ; donne owner/repo#${parsed.number} ou l'URL`,
    };
  }
  const ref = `${repo}#${parsed.number}`;
  const found = await ctx.github?.(repo, parsed.number);
  if (!found) {
    return {
      link: { kind: 'unknown', ref },
      note: `${ref} : issue ou PR non déterminée (gh indisponible ou introuvable) ; ré-ajoute l'URL complète pour préciser`,
    };
  }
  return {
    link: {
      kind: found.kind,
      ref,
      ...(found.title ? { title: found.title } : {}),
      ...(found.url ? { url: found.url } : {}),
    },
  };
}

// Deux liens désignent la même chose si leur ref est identique (issue et PR
// d'un même dépôt partagent la numérotation).
function sameRef(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

// Ajoute des liens : un lien déjà présent (même ref) est remplacé par la
// version la plus précise (ex. `unknown` -> `github-pr`), sans doublon.
export function addLinks(
  existing: WorkspaceLink[],
  added: WorkspaceLink[],
): WorkspaceLink[] {
  const out = [...existing];
  for (const link of added) {
    const i = out.findIndex((l) => sameRef(l.ref, link.ref));
    if (i < 0) {
      out.push(link);
    } else if (link.kind !== 'unknown' || out[i].kind === 'unknown') {
      out[i] = { ...out[i], ...link };
    }
  }
  return out;
}

// Retire les liens désignés par des saisies (mêmes formes que pour l'ajout ;
// `#123` sans dépôt retire tout lien dont le numéro correspond).
export function removeLinks(
  existing: WorkspaceLink[],
  inputs: string[],
  defaultRepo?: string,
): WorkspaceLink[] {
  const matchers = inputs.map((input) => {
    const parsed = parseLinkInput(input);
    if (parsed.kind === 'link') {
      return (l: WorkspaceLink) => sameRef(l.ref, parsed.link.ref);
    }
    if (parsed.kind === 'github-number') {
      const repo = parsed.repo ?? defaultRepo;
      return (l: WorkspaceLink) =>
        repo
          ? sameRef(l.ref, `${repo}#${parsed.number}`)
          : l.ref.endsWith(`#${parsed.number}`);
    }
    return (l: WorkspaceLink) => sameRef(l.ref, parsed.raw);
  });
  return existing.filter((l) => !matchers.some((m) => m(l)));
}

// Nature d'un workspace d'après ses liens (affichage) : une PR l'emporte.
export function workspaceKind(
  links: WorkspaceLink[] | undefined,
): 'pr' | 'issue' | 'text' {
  if (links?.some((l) => l.kind === 'github-pr')) {
    return 'pr';
  }
  return links?.length ? 'issue' : 'text';
}
