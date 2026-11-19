# Smart Explorer

A smarter file explorer panel for VS Code.

## Features

- Custom tree view in the Activity Bar
- Browse workspace files and folders
- Click a file to open it
- Refresh button to reload the tree

## Backlog — issues ouvertes (à traiter plus tard)

- **Conflit à l'ajout d'un workspace** : un même sujet peut exister à la fois dans Linear et dans GitHub (ex : une issue GitHub suivie d'un ticket Linear). Aujourd'hui l'anti-doublon ne compare que `type + ref` ; il faudrait détecter les doublons cross-source (même titre / lien croisé) et proposer de fusionner ou de garder les deux.
- **Meilleure explication du mode Smart** : la détection auto (Linear vs GitHub issue vs PR vs texte) n'est documentée nulle part pour l'utilisateur. Ajouter une description claire dans le quick pick / le README du fonctionnement de la détection.

## Development

```bash
npm install
npm run watch
```

Press `F5` in VS Code to launch the Extension Development Host.

## Structure

```
smart-explorer/
├── package.json                  # Extension manifest & contributions
├── tsconfig.json                 # TypeScript config
├── src/
│   ├── extension.ts              # Entry point (activate/deactivate)
│   └── SmartExplorerProvider.ts  # TreeDataProvider implementation
├── resources/
│   └── icon.svg                  # Activity bar icon
└── .vscode/
    └── launch.json               # Debug config
```
