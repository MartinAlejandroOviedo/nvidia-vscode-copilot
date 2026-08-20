# Development

Build, packaging and publishing guide for the extension.

## Prerequisites

- Node.js 20+ and npm.
- [@vscode/vsce](https://github.com/microsoft/vscode-vsce) (installed automatically via `npx`).

## Setup

```bash
npm install
```

## Build

```bash
npm run compile       # vite build
npm run check-types   # tsc --noEmit (type checking)
```

## Package (VSIX)

```bash
npm run vsce-package
```

This runs the `vscode:prepublish` script (`vite build --minify`) and generates
`nvidia-vscode-copilot-<version>.vsix` at the repo root.

## Local install

1. `npm run vsce-package`.
2. In VS Code: Extensions → `...` menu → **Install from VSIX...**.
3. Select the `.vsix` and reload the window (`Ctrl+Shift+P` → **Developer: Reload Window**).

## Publish to the Marketplace

```bash
npx vsce login MartinAlejandroOviedo   # one-time, with a Personal Access Token
npm run vsce-publish                   # npx vsce publish --no-dependencies
```

## Project structure

- `src/extension.ts` — entry point: registers commands, the chat provider and the sidebar view.
- `src/provider.ts` — chat logic: providers (NVIDIA, OpenRouter, DeepSeek, OrcaRouter), agent loop and tools.
- `src/view.ts` — sidebar webview (HTML/CSS/JS for the chat panel).
- `media/` — icons and assets.
- `docs/` — documentation.
- `dist/` — build output (git-ignored).

## Notes

- The root `README.md` and `CHANGELOG.md` are required by the Marketplace and are
  the canonical copies. Keep them in sync with each release.
- `release/` holds the generated `.vsix` artifacts only (git-ignored).
