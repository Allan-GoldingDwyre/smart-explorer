#!/usr/bin/env bash
# install.sh — installe Smart Explorer : extension VS Code, serveur MCP stdio et
# skills pour les agents détectés (Claude Code, Vibe). Tout est global (user).
# Requiert Node.js >= 18 ; les fichiers viennent de la dernière release GitHub.
#
# Usage :
#   curl -fsSL https://raw.githubusercontent.com/Allan-GoldingDwyre/smart-explorer/main/install.sh | bash
#   ./install.sh                         # interactif : choix des agents
#   ./install.sh --yes                   # sans question : tous les agents détectés
#   ./install.sh --agents claude,vibe    # sans question : agents précisés
#   ./install.sh --uninstall             # retire tout (extension, MCP, skills)
# Variables : SMART_EXPLORER_GH_REPO=owner/repo, SMART_EXPLORER_HOME=<dossier>,
# SMART_EXPLORER_BASE_URL=<url ou file:// des assets> (tests).
set -euo pipefail

GH_REPO="${SMART_EXPLORER_GH_REPO:-Allan-GoldingDwyre/smart-explorer}"
HOME_DIR="${SMART_EXPLORER_HOME:-$HOME/.local/share/smart-explorer}"
BASE_URL="${SMART_EXPLORER_BASE_URL:-https://github.com/${GH_REPO}/releases/latest/download}"
MCP_JS="$HOME_DIR/smart-explorer-mcp.js"
SKILLS_SRC="$HOME_DIR/skills"
VIBE_CONFIG="$HOME/.vibe/config.toml"

YES=0
UNINSTALL=0
AGENTS_ARG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --yes | -y) YES=1 ;;
    --uninstall) UNINSTALL=1 ;;
    --agents)
      AGENTS_ARG="${2:-}"
      shift
      ;;
    --agents=*) AGENTS_ARG="${1#--agents=}" ;;
    -h | --help)
      sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Option inconnue : $1" >&2
      exit 1
      ;;
  esac
  shift
done

say() { printf '%s\n' "$*"; }
die() {
  printf 'Erreur : %s\n' "$*" >&2
  exit 1
}
has() { command -v "$1" >/dev/null 2>&1; }

# --- Détection des agents -------------------------------------------------------

DETECTED=()
has claude && DETECTED+=(claude)
{ has vibe || [ -d "$HOME/.vibe" ]; } && DETECTED+=(vibe)

agent_label() {
  case "$1" in
    claude) echo "Claude Code" ;;
    vibe) echo "Vibe" ;;
  esac
}

# Choix interactif (lit /dev/tty : le script peut arriver par `curl | bash`).
SELECTED=()
choose_agents() {
  if [ -n "$AGENTS_ARG" ]; then
    IFS=',' read -r -a SELECTED <<<"$AGENTS_ARG"
    for a in "${SELECTED[@]}"; do
      case "$a" in claude | vibe) ;; *) die "agent inconnu : $a (claude, vibe)" ;; esac
    done
    return
  fi
  if [ "${#DETECTED[@]}" -eq 0 ]; then
    return
  fi
  if [ "$YES" -eq 1 ] || [ ! -r /dev/tty ]; then
    SELECTED=("${DETECTED[@]}")
    return
  fi
  say "Agents détectés : le MCP et les skills seront installés pour ceux que tu acceptes."
  for a in "${DETECTED[@]}"; do
    read -r -p "Installer pour $(agent_label "$a") ? [O/n] " ans </dev/tty
    case "${ans:-o}" in n | N | non | no) ;; *) SELECTED+=("$a") ;; esac
  done
}

# --- Édition de ~/.vibe/config.toml ---------------------------------------------
# Bloc `[[mcp_servers]]` nommé smart-explorer : ajouté, mis à jour, ou retiré.
vibe_config() { # add <chemin du js> | remove
  [ -f "$VIBE_CONFIG" ] || [ "$1" = "add" ] || return 0
  mkdir -p "$(dirname "$VIBE_CONFIG")"
  touch "$VIBE_CONFIG"
  node - "$VIBE_CONFIG" "$1" "${2:-}" <<'EOF'
const fs = require('fs');
const [file, action, js] = process.argv.slice(2);
const text = fs.readFileSync(file, 'utf8');
// Découpe en blocs : chaque `[[mcp_servers]]` (et ses sous-tables) forme un bloc.
const parts = text.split(/^(?=\[\[mcp_servers\]\]\s*$)/m);
const isOurs = (p) => /^\[\[mcp_servers\]\]/.test(p) && /^name\s*=\s*"smart-explorer"/m.test(p);
const block =
  `[[mcp_servers]]\nname = "smart-explorer"\ntransport = "stdio"\ncommand = "node"\nargs = [${JSON.stringify(js)}]\n`;
let found = false;
const out = [];
for (const p of parts) {
  if (!isOurs(p)) { out.push(p); continue; }
  found = true;
  // Garde ce qui suit le bloc (autres tables) : on ne remplace que nos lignes.
  const rest = p.replace(/^\[\[mcp_servers\]\][^\n]*\n(?:(?!\[)[^\n]*\n?)*/, '');
  if (action === 'add') out.push(block + (rest ? '\n' + rest : '\n'));
  else if (rest) out.push(rest);
}
if (action === 'add' && !found) {
  const base = out.join('');
  out.length = 0;
  out.push(base + (base && !base.endsWith('\n\n') ? (base.endsWith('\n') ? '\n' : '\n\n') : '') + block);
}
fs.writeFileSync(file, out.join(''));
EOF
}

skill_names() {
  local d
  for d in "$SKILLS_SRC"/*/; do
    [ -d "$d" ] && basename "$d"
  done
}

# --- Désinstallation ------------------------------------------------------------

uninstall() {
  say "Désinstallation de Smart Explorer…"
  if has claude; then
    claude mcp remove --scope user smart-explorer >/dev/null 2>&1 || true
  fi
  [ -f "$VIBE_CONFIG" ] && vibe_config remove
  for root in "$HOME/.claude/skills" "$HOME/.vibe/skills"; do
    for s in smart-explorer smart-explorer-baby-steps; do # (baby-steps : ancien skill, fusionné)
      [ -e "$root/$s" ] || [ -L "$root/$s" ] && rm -rf "${root:?}/$s"
    done
  done
  if has code; then
    ext="$(code --list-extensions 2>/dev/null | grep -E '(^|\.)smart-explorer$' || true)"
    [ -n "$ext" ] && code --uninstall-extension "$ext" >/dev/null 2>&1 || true
  fi
  rm -rf "$HOME_DIR"
  say "Fait."
}

if [ "$UNINSTALL" -eq 1 ]; then
  uninstall
  exit 0
fi

# --- Prérequis ------------------------------------------------------------------

has node || die "Node.js >= 18 requis (https://nodejs.org)."
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 18 ] ||
  die "Node.js >= 18 requis (trouvé : $(node --version))."
has curl || die "curl requis."
has tar || die "tar requis."

choose_agents

# --- Téléchargement -------------------------------------------------------------

mkdir -p "$HOME_DIR"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fetch() { curl -fsSL "$BASE_URL/$1" -o "$TMP/$1" || die "téléchargement impossible : $BASE_URL/$1 (aucune release publiée ?)"; }

say "Téléchargement de la dernière release…"
fetch smart-explorer-mcp.js
fetch skills.tar.gz
fetch smart-explorer.vsix

mv "$TMP/smart-explorer-mcp.js" "$MCP_JS"
chmod +x "$MCP_JS"
rm -rf "$SKILLS_SRC"
mkdir -p "$SKILLS_SRC"
tar -xzf "$TMP/skills.tar.gz" -C "$SKILLS_SRC"
say "  MCP    : $MCP_JS"
say "  Skills : $SKILLS_SRC"

# --- Extension VS Code ----------------------------------------------------------

if has code; then
  if code --install-extension "$TMP/smart-explorer.vsix" --force >/dev/null 2>&1; then
    say "  VS Code : extension installée (recharge la fenêtre)"
  else
    say "  VS Code : échec de l'installation (essaie : code --install-extension <vsix>)"
  fi
else
  cp "$TMP/smart-explorer.vsix" "$HOME_DIR/smart-explorer.vsix"
  say "  VS Code : commande 'code' absente — installe $HOME_DIR/smart-explorer.vsix (Extensions → Install from VSIX…)"
fi

# --- MCP + skills par agent -----------------------------------------------------

install_skills() { # <dossier skills de l'agent>
  mkdir -p "$1"
  local s
  rm -rf "${1:?}/smart-explorer-baby-steps" # ancien skill, fusionné dans smart-explorer
  for s in $(skill_names); do
    rm -rf "${1:?}/$s"
    cp -R "$SKILLS_SRC/$s" "$1/$s"
  done
}

for a in ${SELECTED[@]+"${SELECTED[@]}"}; do
  case "$a" in
    claude)
      claude mcp remove --scope user smart-explorer >/dev/null 2>&1 || true
      claude mcp add --scope user smart-explorer -- node "$MCP_JS" >/dev/null
      install_skills "$HOME/.claude/skills"
      say "  Claude Code : MCP (user) + skills"
      ;;
    vibe)
      vibe_config add "$MCP_JS"
      install_skills "$HOME/.vibe/skills"
      say "  Vibe : MCP (~/.vibe/config.toml) + skills"
      ;;
  esac
done

if [ "${#SELECTED[@]}" -eq 0 ]; then
  say "  Aucun agent (claude, vibe) choisi ou détecté : MCP et skills non branchés."
  say "  Serveur à déclarer à la main : node $MCP_JS"
fi

say
say "Terminé. Redémarre tes agents pour qu'ils chargent le MCP et les skills."
