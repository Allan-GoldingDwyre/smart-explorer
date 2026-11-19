#!/usr/bin/env bash
# install.sh — installe le serveur MCP stdio de Smart Explorer sur macOS/Linux.
# Télécharge le bundle autonome depuis la dernière release GitHub (aucun
# build nécessaire, requiert seulement Node.js >= 18 déjà installé).
#
# Usage :
#   curl -fsSL https://raw.githubusercontent.com/<owner>/smart-explorer/main/install.sh | bash
#   SMART_EXPLORER_GH_REPO=owner/repo SMART_EXPLORER_HOME=~/.local/share/smart-explorer ./install.sh
set -euo pipefail

GH_REPO="${SMART_EXPLORER_GH_REPO:-owner/smart-explorer}"
ASSET="smart-explorer-mcp.js"
HOME_DIR="${SMART_EXPLORER_HOME:-$HOME/.local/share/smart-explorer}"

if ! command -v node >/dev/null 2>&1; then
  echo "Erreur : Node.js >= 18 requis (https://nodejs.org)." >&2
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "Erreur : Node.js >= 18 requis (trouvé : $(node --version))." >&2
  exit 1
fi

mkdir -p "$HOME_DIR"
DEST="$HOME_DIR/$ASSET"

# Dernière release, sinon branche main.
URL="https://github.com/${GH_REPO}/releases/latest/download/${ASSET}"
if ! curl -fsSL "$URL" -o "$DEST.tmp"; then
  echo "Release introuvable, essai depuis la branche main..."
  URL="https://raw.githubusercontent.com/${GH_REPO}/main/dist/${ASSET}"
  curl -fsSL "$URL" -o "$DEST.tmp"
fi
mv "$DEST.tmp" "$DEST"
chmod +x "$DEST"

echo "Installé : $DEST"
echo
echo "Ajoute dans le .mcp.json de ton client MCP (Claude Code, Vibe, CLI Mistral) :"
echo
cat <<EOF
{
  "mcpServers": {
    "smart-explorer": {
      "command": "node",
      "args": ["$DEST"]
    }
  }
}
EOF
echo
echo "Le serveur résout la racine du projet via --root, SMART_EXPLORER_ROOT, ou le cwd du client."
