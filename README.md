# NVIDIA Models for VS Code

"NVIDIA Models for VS Code" is an AI chat that works directly on your project. It connects NVIDIA NIM (Nemotron), OpenRouter, DeepSeek and OrcaRouter (free) models to read and write files, run commands in CMD/PowerShell, use Git, download files and search the web.

## Features

- **Files**: list, read, write and search text in the workspace.
- **Commands**: CMD or PowerShell (5.1 and 7+), with approval.
- **Git**: read-only operations run automatically; mutating ones ask for approval.
- **Downloads**: from any http/https URL.
- **Curated web search** (DuckDuckGo + Wikipedia).
- **Per-tool permissions**.

## Configuration

- `nvidia.apiKey` and `nvidia.openrouterApiKey`: keys stored securely.
- `nvidia.deepseekApiKey` and `nvidia.orcarouterApiKey`: DeepSeek and OrcaRouter keys (optional).
- `nvidia.outputDirectory`: folder where the model creates/writes files.
- `nvidia.systemPrompt`: custom system prompt.

## Usage

Open the NVIDIA Chat panel, pick a provider and a model, set your API key and start typing.

## License

MIT.
