# Changelog

Todos los cambios notables de esta extensión se documentan en este archivo.

El formato sigue [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y el versionado sigue [SemVer](https://semver.org/lang/es/).

## [0.1.0] - 2026-08-16

### Añadido
- Chat con modelos NVIDIA NIM (Nemotron) y OpenRouter (modelos gratuitos).
- Herramientas de archivos: `list_files`, `read_file`, `write_file`, `search_text`.
- Ejecución de comandos `run_command` con selector de shell (`cmd`, `powershell`, `pwsh`).
- Herramienta `git` con aprobación para operaciones que modifican el repositorio.
- Herramienta `download_file` para descargar archivos desde internet.
- Búsqueda web curada (`web_search`) vía DuckDuckGo y Wikipedia.
- Permisos individuales por herramienta desde el panel (auto aprobar, web, comandos, descargas, git).
- Carpeta de salida configurable (`nvidia.outputDirectory`).
- Prompt de sistema reemplazable (`nvidia.systemPrompt`).
- Panel lateral con historial de chats, selección de proveedor/modelo y exportación de chats.
