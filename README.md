# Smart Explorer

A smarter file explorer panel for VS Code.

## Features

- Custom tree view in the Activity Bar
- Browse workspace files and folders
- Click a file to open it
- Refresh button to reload the tree

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
