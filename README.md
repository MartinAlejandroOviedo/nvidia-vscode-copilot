# NVIDIA Models for VS Code

Chat de inteligencia artificial para Visual Studio Code que puede actuar sobre tu proyecto: leer y escribir archivos, ejecutar comandos en CMD/PowerShell, usar Git, descargar archivos desde internet y buscar información en la web.

## Características

- **Chat con modelos NVIDIA NIM** (Nemotron) y **OpenRouter** (modelos gratuitos).
- **Herramientas de archivos**: listar, leer, escribir y buscar texto en el workspace.
- **Ejecutar comandos**: CMD o PowerShell (5.1 y 7+), con aprobación del usuario.
- **Git**: operaciones de solo lectura automáticas; las que modifican piden aprobación.
- **Descargar archivos** desde cualquier URL (http/https) al workspace.
- **Búsqueda web** curada (DuckDuckGo + Wikipedia).
- **Permisos individuales** por herramienta, controlados desde el panel.

## Instalación

### Desde VSIX (local)

1. Ejecutá `npm run vsce-package` para generar `nvidia-vscode-copilot-<versión>.vsix`.
2. En VS Code: `Extensiones` → menú `...` → **Instalar desde VSIX...**.
3. Seleccioná el archivo `.vsix`.
4. Recargá la ventana (`Ctrl+Shift+P` → **Developer: Reload Window**).

### Desde el Marketplace

Busca **NVIDIA Models for VS Code** en el Marketplace de VS Code e instalala.

## Configuración

| Clave | Descripción |
| --- | --- |
| `nvidia.apiKey` | API key de NVIDIA NIM (build.nvidia.com). |
| `nvidia.openrouterApiKey` | API key de OpenRouter (opcional, para modelos gratuitos). |
| `nvidia.outputDirectory` | Carpeta donde el modelo crea/escribe archivos. Vacía = raíz del workspace. |
| `nvidia.systemPrompt` | Reemplaza el prompt de sistema por defecto (opcional). |

Las claves se guardan en el almacenamiento seguro de VS Code y persisten entre instalaciones.

## Uso

1. Abrí el panel **NVIDIA Chat** desde la barra de actividad.
2. Elegí proveedor (**NVIDIA** o **OpenRouter**) y modelo desde el botón de caja.
3. Configurá tu API key con el botón de engranaje.
4. Escribí tu mensaje. El modelo puede:
   - Leer/escribir archivos del proyecto.
   - Ejecutar comandos (`run_command`) en `cmd` o `powershell`.
   - Usar `git` (status, commit, push, etc.).
   - Descargar archivos (`download_file`).
   - Buscar en internet (`web_search`).

## Permisos

Desde el botón de escudo podés activar/desactivar cada capacidad de forma independiente:

- **Auto aprobar** (heredado): aprobar escritura y ejecución sin preguntar.
- **Buscar en internet**
- **Ejecutar comandos**
- **Descargar archivos**
- **Git**

## Desarrollo

```bash
npm install          # instala dependencias
npm run compile      # compila (vite build)
npm run check-types  # verifica tipos
npm run vsce-package # empaqueta .vsix
```

## Licencia

MIT. Ver [LICENSE](LICENSE).
