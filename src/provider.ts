import * as vscode from "vscode";
import OpenAI from "openai";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

const MODEL_ID_PREFIX = "vscode-nvidia/";
const NVIDIA_API_BASE = "https://integrate.api.nvidia.com/v1";
const OPENROUTER_API_BASE = "https://openrouter.ai/api/v1";
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const DEFAULT_MODEL = "nvidia/llama-3.3-nemotron-super-49b-v1";
const MAX_AGENT_ITERATIONS = 10;

interface ChatMessage {
	role: string;
	content: string;
}

interface ToolCallAccum {
	id: string;
	name: string;
	args: string;
}

export class NvidiaProvider implements vscode.LanguageModelChatProvider {
	private _cachedModels: vscode.LanguageModelChatInformation[] | undefined;
	private readonly secrets: vscode.SecretStorage;
	private autoApprove = false;
	private permissions = {
		webSearch: false,
		runCommand: false,
		downloadFile: false,
		git: false,
	};

	constructor(secrets: vscode.SecretStorage) {
		this.secrets = secrets;
	}

	/** Enable/disable automatic approval of write/run operations (legacy). */
	setAutoApprove(value: boolean): void {
		this.autoApprove = value;
	}

	/** Get current permissions. */
	getPermissions(): typeof this.permissions {
		return { ...this.permissions };
	}

	/** Update a specific permission. */
	setPermission<K extends keyof typeof this.permissions>(key: K, value: boolean): void {
		this.permissions[key] = value;
	}

	/** Enable/disable internet search via the web_search tool. */
	setWebSearchEnabled(value: boolean): void {
		this.permissions.webSearch = value;
	}

	/** Check if a tool requires user approval. */
	private requiresApproval(toolName: string): boolean {
		if (this.autoApprove) return false;
		const toolPermissions: Record<string, keyof typeof this.permissions> = {
			run_command: "runCommand",
			download_file: "downloadFile",
			git: "git",
			write_file: "runCommand", // write_file uses runCommand permission
			web_search: "webSearch",
		};
		const permKey = toolPermissions[toolName];
		if (!permKey) return true; // default to requiring approval for unknown tools
		return !this.permissions[permKey];
	}

	private getWorkspaceRoot(): string {
		const folder = vscode.workspace.workspaceFolders?.[0];
		if (!folder) throw new Error("No hay ninguna carpeta abierta en el workspace");
		return folder.uri.fsPath;
	}

	// Tool schemas exposed to the model so it can act on the project files.
	private get agentTools(): any[] {
		const tools: any[] = [
		{
			type: "function",
			function: {
				name: "list_files",
				description:
					"List the files and directories inside a folder of the workspace. Path is relative to the workspace root.",
				parameters: {
					type: "object",
					properties: {
						path: {
							type: "string",
							description: "Relative folder path, e.g. \"src\" or \"\" for the root.",
						},
					},
					required: ["path"],
				},
			},
		},
		{
			type: "function",
			function: {
				name: "read_file",
				description:
					"Read the full content of a file in the workspace. Path is relative to the workspace root.",
				parameters: {
					type: "object",
					properties: {
						path: {
							type: "string",
							description: "Relative file path, e.g. \"src/main.py\".",
						},
					},
					required: ["path"],
				},
			},
		},
		{
			type: "function",
			function: {
				name: "write_file",
				description:
					"Create or overwrite a file in the workspace with the given content. Path is relative to the workspace root.",
				parameters: {
					type: "object",
					properties: {
						path: {
							type: "string",
							description: "Relative file path, e.g. \"src/foo.py\".",
						},
						content: {
							type: "string",
							description: "Full file content to write.",
						},
					},
					required: ["path", "content"],
				},
			},
		},
		{
			type: "function",
			function: {
				name: "search_text",
				description:
					"Search for a text pattern across all files in the workspace and return matching lines.",
				parameters: {
					type: "object",
					properties: {
						query: {
							type: "string",
							description: "Text or regex to search for.",
						},
					},
					required: ["query"],
				},
			},
		},
		{
			type: "function",
			function: {
				name: "run_command",
				description:
					"Run a shell command inside the workspace folder (e.g. npm test, python script.py). Use shell \"powershell\" to run PowerShell commands (or scripts .ps1) and \"cmd\" for the Windows command prompt. The user will be asked to approve the command first.",
				parameters: {
					type: "object",
					properties: {
						command: {
							type: "string",
							description: "The shell command to execute.",
						},
						shell: {
							type: "string",
							enum: ["cmd", "powershell", "pwsh"],
							description:
								"Which shell to use. \"cmd\" (default) for the Windows command prompt, \"powershell\" for Windows PowerShell 5.1, \"pwsh\" for PowerShell 7+.",
						},
					},
					required: ["command"],
				},
			},
		},
		{
			type: "function",
			function: {
				name: "download_file",
				description:
					"Download a file from a URL and save it inside the workspace. Provide a relative path/filename to save to; otherwise the filename is taken from the URL. The user will be asked to approve the download first.",
				parameters: {
					type: "object",
					properties: {
						url: {
							type: "string",
							description:
								"The full URL of the file to download (must start with http:// or https://).",
						},
						path: {
							type: "string",
							description:
								"Optional relative path/filename to save the file to, e.g. \"downloads/tool.exe\".",
						},
					},
					required: ["url"],
				},
			},
		},
		{
			type: "function",
			function: {
				name: "git",
				description:
					"Run a git command in the workspace repository. Read-only commands (status, log, diff, show, etc.) run automatically; mutating commands (add, commit, push, pull, checkout, merge, reset, clean, etc.) require user approval.",
				parameters: {
					type: "object",
					properties: {
						args: {
							type: "string",
							description:
								"Arguments passed to git, e.g. \"status --short\", \"log --oneline -10\", \"add .\", \"commit -m 'mensaje'\", \"push\".",
						},
					},
					required: ["args"],
				},
			},
		},
		];

		if (this.permissions.webSearch) {
			tools.push({
				type: "function",
				function: {
					name: "web_search",
					description:
						"Search the web for curated, reliable information (Wikipedia and DuckDuckGo instant answers). Use this when the user asks about facts, documentation, or current information that is not in the project files.",
					parameters: {
						type: "object",
						properties: {
							query: {
								type: "string",
								description: "The search query.",
							},
						},
						required: ["query"],
					},
				},
			});
		}

		return tools;
	}

	/** Perform a curated web search (DuckDuckGo instant answers + Wikipedia). */
	private async curatedWebSearch(query: string): Promise<string> {
		const results: string[] = [];
		const ddgUrl =
			"https://api.duckduckgo.com/?q=" +
			encodeURIComponent(query) +
			"&format=json&no_html=1&skip_disambig=1";

		try {
			const resp = await fetch(ddgUrl, {
				headers: { "User-Agent": "vscode-nvidia-copilot/0.1.0" },
			});
			if (resp.ok) {
				const ddg = (await resp.json()) as any;
				if (ddg.AbstractText) {
					results.push(
						`## ${ddg.Heading || query}\n${ddg.AbstractText}` +
							(ddg.AbstractURL ? `\nFuente: ${ddg.AbstractURL}` : ""),
					);
				} else if (ddg.Answer) {
					results.push(`## Respuesta\n${ddg.Answer}`);
				}
				const topics: any[] = ddg.RelatedTopics ?? [];
				for (const t of topics) {
					if (typeof t.Text === "string" && t.Text) {
						results.push(`- ${t.Text}` + (t.FirstURL ? `\n  ${t.FirstURL}` : ""));
					}
					const sub: any[] = t.Topics ?? [];
					for (const s of sub) {
						if (typeof s.Text === "string" && s.Text) {
							results.push(`- ${s.Text}` + (s.FirstURL ? `\n  ${s.FirstURL}` : ""));
						}
					}
				}
			}
		} catch {
			// ignore network errors and fall through
		}

		// Wikipedia curated results as fallback/supplement
		try {
			const wikiUrl =
				"https://en.wikipedia.org/w/api.php?action=opensearch&search=" +
				encodeURIComponent(query) +
				"&limit=5&namespace=0&format=json&origin=*";
			const wikiResp = await fetch(wikiUrl);
			if (wikiResp.ok) {
				const wiki = (await wikiResp.json()) as [string, string[], string[], string[]];
				const titles = wiki[1] ?? [];
				const links = wiki[3] ?? [];
				for (let i = 0; i < titles.length; i++) {
					results.push(`[Wiki] ${titles[i]}: ${links[i]}`);
				}
			}
		} catch {
			// ignore
		}

		if (results.length === 0) {
			return `Sin resultados curados para "${query}".`;
		}
		return results.slice(0, 12).join("\n");
	}

	/** Resolve a relative path against the output folder and return the URI. */
	private resolveUri(rel: string): vscode.Uri {
		const root = vscode.workspace.workspaceFolders?.[0]?.uri;
		if (!root) throw new Error("No hay ninguna carpeta abierta");

		const configured = vscode.workspace
			.getConfiguration("nvidia")
			.get<string>("outputDirectory");
		let base = root;
		if (configured && configured.trim() !== "") {
			const cleaned = configured.replace(/\\/g, "/").replace(/^\.?\//, "");
			base = vscode.Uri.joinPath(root, cleaned);
		}

		const cleanedRel = rel.replace(/\\/g, "/").replace(/^\.?\//, "");
		return vscode.Uri.joinPath(base, cleanedRel);
	}

	/** The folder where the model will write files. */
	getOutputFolder(): string {
		const configured = vscode.workspace
			.getConfiguration("nvidia")
			.get<string>("outputDirectory");
		const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
		if (configured && configured.trim() !== "") {
			const cleaned = configured.replace(/\\/g, "/").replace(/^\.?\//, "");
			return vscode.Uri.joinPath(vscode.Uri.file(root), cleaned).fsPath;
		}
		return root;
	}

	/** Execute a tool call and return the result as a string. */
	private async executeTool(name: string, argsJson: string): Promise<string> {
		let args: Record<string, unknown>;
		try {
			args = JSON.parse(argsJson || "{}") as Record<string, unknown>;
		} catch {
			return "Error: los argumentos de la herramienta no son JSON válido.";
		}

		switch (name) {
			case "list_files": {
				const uri = this.resolveUri(String(args.path ?? ""));
				try {
					const entries = await vscode.workspace.fs.readDirectory(uri);
					const lines = entries.map(([n, t]) =>
						t === vscode.FileType.Directory ? `${n}/` : n,
					);
					return lines.length ? lines.sort().join("\n") : "(directorio vacío)";
				} catch (err) {
					return `Error al listar: ${err}`;
				}
			}
			case "read_file": {
				const uri = this.resolveUri(String(args.path ?? ""));
				try {
					const bytes = await vscode.workspace.fs.readFile(uri);
					const text = Buffer.from(bytes).toString("utf8");
					return text.length > 8000
						? text.slice(0, 8000) + "\n...[contenido truncado]"
						: text;
				} catch (err) {
					return `Error al leer: ${err}`;
				}
			}
			case "write_file": {
				const path = String(args.path ?? "");
				const content = String(args.content ?? "");
				const uri = this.resolveUri(path);
				if (!this.autoApprove) {
					const approve = await vscode.window.showWarningMessage(
						`¿Permitir que NVIDIA Chat ${content.length > 0 ? "sobrescriba" : "cree"} el archivo "${path}"?`,
						{ modal: true },
						"Aprobar",
						"Cancelar",
					);
					if (approve !== "Aprobar") {
						return "Operación cancelada por el usuario.";
					}
				}
				try {
					await vscode.workspace.fs.writeFile(
						uri,
						Buffer.from(content, "utf8"),
					);
					return `Archivo "${path}" guardado correctamente.`;
				} catch (err) {
					return `Error al escribir: ${err}`;
				}
			}
			case "search_text": {
				const query = String(args.query ?? "");
				const root = vscode.workspace.workspaceFolders?.[0]?.uri;
				if (!root) return "Sin workspace.";
				const results: string[] = [];
				try {
					const files = await vscode.workspace.findFiles(
						"**/*",
						"**/node_modules/**",
						100,
					);
					for (const fileUri of files) {
						if (results.length >= 50) break;
						try {
							const bytes = await vscode.workspace.fs.readFile(fileUri);
							const text = Buffer.from(bytes).toString("utf8");
							const lines = text.split("\n");
							for (let i = 0; i < lines.length; i++) {
								if (lines[i].toLowerCase().includes(query.toLowerCase())) {
									results.push(
										`${fileUri.path}:${i + 1}: ${lines[i].trim().slice(0, 200)}`,
									);
									if (results.length >= 50) break;
								}
							}
						} catch {
							// skip binary/unreadable files
						}
					}
				} catch (err) {
					return `Error en la búsqueda: ${err}`;
				}
				return results.length ? results.join("\n") : "Sin resultados.";
			}
			case "run_command": {
				const command = String(args.command ?? "");
				const shellChoice = String(args.shell ?? "cmd").toLowerCase();
				const root = this.getWorkspaceRoot();
				if (this.requiresApproval("run_command")) {
					const shellLabel =
						shellChoice === "powershell" || shellChoice === "pwsh"
							? "PowerShell"
							: "CMD";
					const approve = await vscode.window.showWarningMessage(
						`¿Permitir ejecutar el comando en ${shellLabel}?\n\n${command}`,
						{ modal: true },
						"Ejecutar",
						"Cancelar",
					);
					if (approve !== "Ejecutar") {
						return "Comando cancelado por el usuario.";
					}
				}
				try {
					let fullCommand = command;
					if (shellChoice === "powershell") {
						fullCommand =
							`powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "` +
							command.replace(/"/g, '\\"') +
							`"`;
					} else if (shellChoice === "pwsh") {
						fullCommand =
							`pwsh -NoProfile -ExecutionPolicy Bypass -Command "` +
							command.replace(/"/g, '\\"') +
							`"`;
					}
					const { stdout, stderr } = await execAsync(fullCommand, {
						cwd: root,
						timeout: 120000,
						maxBuffer: 8 * 1024 * 1024,
					});
					const out = (stdout + (stderr ? `\n[stderr] ${stderr}` : "")).slice(0, 4000);
					return out || "(sin salida)";
				} catch (err: any) {
					const msg = err?.stdout ?? err?.message ?? String(err);
					return `Comando terminó con error:\n${String(msg).slice(0, 3000)}`;
				}
			}
			case "git": {
				const argsStr = String(args.args ?? "").trim();
				if (!argsStr) {
					return "Error: especifica los argumentos de git (por ejemplo \"status\").";
				}
				const root = this.getWorkspaceRoot();
				const sub = argsStr.split(/\s+/)[0]?.toLowerCase() ?? "";
				const readOnly = new Set([
					"status",
					"log",
					"diff",
					"show",
					"shortlog",
					"describe",
					"ls-files",
					"reflog",
					"blame",
					"grep",
					"rev-parse",
					"config",
				]);
				const needsApproval = !readOnly.has(sub) && this.requiresApproval("git");
				if (needsApproval) {
					const approve = await vscode.window.showWarningMessage(
						`¿Permitir ejecutar el comando git?\n\ngit ${argsStr}`,
						{ modal: true },
						"Ejecutar",
						"Cancelar",
					);
					if (approve !== "Ejecutar") {
						return "Comando git cancelado por el usuario.";
					}
				}
				try {
					const { stdout, stderr } = await execAsync(`git ${argsStr}`, {
						cwd: root,
						timeout: 120000,
						maxBuffer: 8 * 1024 * 1024,
					});
					const out = (stdout + (stderr ? `\n[stderr] ${stderr}` : "")).slice(0, 4000);
					return out || "(sin salida)";
				} catch (err: any) {
					const msg = err?.stdout ?? err?.stderr ?? err?.message ?? String(err);
					return `Comando git terminó con error:\n${String(msg).slice(0, 3000)}`;
				}
			}
			case "download_file": {
				const url = String(args.url ?? "").trim();
				const path = String(args.path ?? "").trim();
				if (!url) {
					return "Error: no se especificó una URL.";
				}
				if (!/^https?:\/\//i.test(url)) {
					return "Error: la URL debe empezar con http:// o https://";
				}
				let targetPath = path;
				if (!targetPath) {
					try {
						const fileName = new URL(url).pathname.split("/").pop();
						targetPath = fileName && fileName !== "" ? fileName : "download.bin";
					} catch {
						targetPath = "download.bin";
					}
				}
				if (this.requiresApproval("download_file")) {
					const approve = await vscode.window.showWarningMessage(
						`¿Permitir descargar el archivo desde internet?\n\n${url}\n\nGuardar como: "${targetPath}"`,
						{ modal: true },
						"Descargar",
						"Cancelar",
					);
					if (approve !== "Descargar") {
						return "Descarga cancelada por el usuario.";
					}
				}
				try {
					const resp = await fetch(url, {
						headers: { "User-Agent": "vscode-nvidia-copilot/0.1.0" },
					});
					if (!resp.ok) {
						return `Error al descargar: HTTP ${resp.status} ${resp.statusText}`;
					}
					const buf = Buffer.from(await resp.arrayBuffer());
					const uri = this.resolveUri(targetPath);
					await vscode.workspace.fs.writeFile(uri, buf);
					return `Archivo descargado y guardado en "${targetPath}" (${buf.length} bytes).`;
				} catch (err) {
					return `Error al descargar: ${err}`;
				}
			}
			case "web_search": {
				if (!this.permissions.webSearch) {
					return "La búsqueda en internet está deshabilitada.";
				}
				const query = String(args.query ?? "");
				if (!query.trim()) {
					return "No se especificó una consulta de búsqueda.";
				}
				return await this.curatedWebSearch(query.trim());
			}
			default:
				return `Herramienta desconocida: ${name}`;
		}
	}

	/** Check whether a parsed tool name corresponds to a known tool. */
	private isKnownTool(name: string): boolean {
		return ["list_files", "read_file", "write_file", "search_text", "run_command", "download_file", "git", "web_search"].includes(
			name,
		);
	}

	/**
	 * Some models (esp. small free ones) emit tool calls as plain text like
	 * <tool_call><function=read_file><parameter=path>foo.txt</parameter></function></tool_call>
	 * instead of the native tool-calling protocol. Parse that text so we can
	 * still execute the requested tool.
	 */
	/** True if the accumulated text could be the start of a text-mode tool call. */
	private looksLikeToolCall(s: string): boolean {
		if (!s.startsWith("<")) return false;
		const prefixes = ["<tool_call", "<function", "<tool"];
		return prefixes.some((p) => p.startsWith(s) || s.startsWith(p));
	}

	private parseTextToolCall(
		content: string,
	): { name: string; args: Record<string, string> } | undefined {
		const funcMatch = content.match(/<function\s*=\s*([^>]+)>/i);
		if (!funcMatch) return undefined;
		const name = funcMatch[1].trim();
		const args: Record<string, string> = {};
		const paramRegex = /<parameter\s*=\s*([^>]+)>([\s\S]*?)<\/parameter>/gi;
		let m;
		while ((m = paramRegex.exec(content)) !== null) {
			args[m[1].trim()] = m[2].trim();
		}
		if (Object.keys(args).length === 0) {
			// Fallback: treat the text after the function tag as a single "query".
			const body = content.replace(/<[^>]+>/g, " ").trim();
			if (body) args.query = body;
		}
		return { name, args };
	}

	/** Build the system message telling the model it can act on project files. */
	private buildSystemMessage(): ChatMessage {
		const outputFolder = this.getOutputFolder();
		return {
			role: "system",
			content:
				"Eres un asistente que trabaja sobre los archivos del proyecto del usuario. " +
				`Todas las rutas relativas que uses en las herramientas list_files, read_file, write_file, search_text, run_command, download_file y web_search se resuelven dentro de la carpeta de trabajo: "${outputFolder}". ` +
				"Cuando el usuario pida crear o escribir un archivo, usa la herramienta write_file con un nombre de archivo razonable dentro de esa carpeta. " +
				"Cuando el usuario pida descargar un archivo desde internet, usa la herramienta download_file con la URL y (opcionalmente) una ruta de destino. " +
				"Cuando el usuario pida ejecutar un comando o un script, usa run_command; usa shell \"powershell\" para comandos o scripts de PowerShell y \"cmd\" para el símbolo del sistema. " +
				"Cuando el usuario pida usar git (estado, commits, ramas, push, etc.), usa la herramienta git con los argumentos apropiados. " +
				"Cuando leas un archivo, usa read_file con la ruta relativa desde la carpeta de trabajo. " +
				"IMPORTANTE: no describas la acción en texto ni digas que lo harás; ejecuta directamente la herramienta correspondiente. " +
				"Después de recibir el resultado de una herramienta (por ejemplo web_search), responde directamente con la información obtenida y NO vuelvas a llamar a la misma herramienta ni encadenes más herramientas. " +
				"Usa como máximo una o dos herramientas por respuesta. " +
				"Responde en el mismo idioma que usa el usuario.",
		};
	}

	/** Shared agent loop: streams completions, executes tool calls, iterates. */
	private async *runAgentLoop(
		openai: OpenAI,
		modelId: string,
		convo: any[],
		signal?: AbortSignal,
		onTool?: (name: string) => void,
		enableReasoning = false,
		onReasoning?: () => void,
	): AsyncGenerator<string> {
		for (let iter = 0; iter < MAX_AGENT_ITERATIONS; iter++) {
			const body: any = {
				model: modelId,
				messages: convo,
				stream: true,
				tools: this.agentTools as any,
				tool_choice: "auto",
			};
			if (enableReasoning) {
				body.reasoning = { enabled: true };
			}
			const stream = await openai.chat.completions.create(body, { signal });

			let content = "";
			let buffering = false;
			const toolCalls = new Map<number, ToolCallAccum>();

			const iterable = stream as unknown as AsyncIterable<any>;
			for await (const chunk of iterable) {
				const delta: any = chunk.choices?.[0]?.delta;
				if (!delta) continue;
				if (delta.reasoning || delta.reasoning_content) {
					onReasoning?.();
					continue;
				}
				if (delta.content) {
					content += delta.content;
					if (!buffering) {
						const head = content.trimStart();
						if (this.looksLikeToolCall(head)) {
							buffering = true;
						} else {
							yield delta.content;
						}
					}
				}
				if (delta.tool_calls) {
					for (const tc of delta.tool_calls) {
						const idx = tc.index ?? 0;
						const acc = toolCalls.get(idx) ?? { id: "", name: "", args: "" };
						if (tc.id) acc.id = tc.id;
						if (tc.function?.name) acc.name = tc.function.name;
						if (tc.function?.arguments) acc.args += tc.function.arguments;
						toolCalls.set(idx, acc);
					}
				}
			}

			if (toolCalls.size === 0) {
				// Fallback: model may have emitted the tool call as plain text.
				const textTool = this.parseTextToolCall(content);
				if (textTool && this.isKnownTool(textTool.name)) {
					onTool?.(textTool.name);
					const result = await this.executeTool(
						textTool.name,
						JSON.stringify(textTool.args),
					);
					// Push a native-looking tool call so the model understands the
					// tool was invoked (avoids it echoing the raw <tool_call> tags).
					convo.push({
						role: "assistant",
						content: null,
						tool_calls: [
							{
								id: "text-tool-" + iter,
								type: "function",
								function: {
									name: textTool.name,
									arguments: JSON.stringify(textTool.args),
								},
							},
						],
					});
					convo.push({
						role: "tool",
						tool_call_id: "text-tool-" + iter,
						content: result,
					});
					continue;
				}
				if (buffering) {
					// It looked like a tool call but couldn't be parsed; show it.
					yield content;
				}
				return; // final answer
			}

			// Push assistant message with tool calls
			const assistantMsg: any = {
				role: "assistant",
				content: content || null,
				tool_calls: [...toolCalls.values()].map((tc) => ({
					id: tc.id,
					type: "function",
					function: { name: tc.name, arguments: tc.args },
				})),
			};
			convo.push(assistantMsg);

			// Execute each tool and push results
			for (const tc of toolCalls.values()) {
				onTool?.(tc.name);
				const result = await this.executeTool(tc.name, tc.args);
				convo.push({
					role: "tool",
					tool_call_id: tc.id,
					content: result,
				});
			}
		}

		// Reached the iteration limit: force a final answer WITHOUT tools so the
		// model stops calling tools and writes a summary from what it gathered.
		const finalStream = await openai.chat.completions.create(
			{
				model: modelId,
				messages: convo,
				stream: true,
			} as any,
			{ signal },
		);
		const finalIterable = finalStream as unknown as AsyncIterable<any>;
		for await (const chunk of finalIterable) {
			const delta = chunk.choices?.[0]?.delta;
			if (delta?.content) {
				yield delta.content;
			}
		}
	}

	/** Stream a chat completion against NVIDIA with agent tool-calling. */
	async *streamChat(
		messages: ChatMessage[],
		model?: string,
		signal?: AbortSignal,
		onTool?: (name: string) => void,
		onReasoning?: () => void,
	): AsyncGenerator<string> {
		const apiKey = await this.getApiKey();
		if (!apiKey) {
			throw new Error(
				"NVIDIA API key no configurada. Abre la Configuración e ingresa tu clave.",
			);
		}

		const openai = new OpenAI({
			apiKey,
			baseURL: NVIDIA_API_BASE,
		});

		const modelId = model ?? DEFAULT_MODEL;
		const convo: any[] = [this.buildSystemMessage(), ...messages];
		yield* this.runAgentLoop(openai, modelId, convo, signal, onTool, false, onReasoning);
	}

	/** Get the list of Nemotron chat models (without the VS Code prefix). */
	async getNemotronModels(): Promise<string[]> {
		const info = await this.provideLanguageModelChatInformation(
			{ silent: true } as vscode.PrepareLanguageModelChatModelOptions,
			new vscode.CancellationTokenSource().token,
		);
		return info.map((m) => m.id.replace(MODEL_ID_PREFIX, ""));
	}

	/** Get the list of OpenRouter FREE models (id ends with ":free"). */
	async getOpenRouterFreeModels(): Promise<string[]> {
		const resp = await fetch(OPENROUTER_MODELS_URL, {
			headers: { "Content-Type": "application/json" },
		});
		if (!resp.ok) {
			throw new Error(`OpenRouter models ${resp.status}: ${await resp.text()}`);
		}
		const data = (await resp.json()) as {
			data?: Array<{ id?: string }>;
		};
		const models = data.data ?? [];
		return models
			.map((m) => m.id)
			.filter((id): id is string => !!id && id.toLowerCase().endsWith(":free"));
	}

	/** Stream a chat completion against OpenRouter with agent tool-calling. */
	async *streamOpenRouterChat(
		messages: ChatMessage[],
		model: string,
		signal?: AbortSignal,
		onTool?: (name: string) => void,
		onReasoning?: () => void,
	): AsyncGenerator<string> {
		const apiKey = await this.getOpenRouterApiKey();
		if (!apiKey) {
			throw new Error(
				"OpenRouter API key no configurada. Abre la Configuración e ingresa tu clave.",
			);
		}

		const openai = new OpenAI({
			apiKey,
			baseURL: OPENROUTER_API_BASE,
			defaultHeaders: {
				"HTTP-Referer": "https://github.com/NVIDIA/vscode-nvidia-copilot",
				"X-Title": "NVIDIA VS Code Extension",
			},
		});

		const convo: any[] = [this.buildSystemMessage(), ...messages];
		try {
			yield* this.runAgentLoop(openai, model, convo, signal, onTool, true, onReasoning);
		} catch (err) {
			const msg = String(err);
			if (
				msg.includes("401") ||
				msg.toLowerCase().includes("user not found") ||
				msg.toLowerCase().includes("unauthorized")
			) {
				throw new Error(
					"API key de OpenRouter inválida o vacía. Revisa tu clave en Configuración (botón de ajustes) — el nombre del modelo no es el problema.",
				);
			}
			// Retry without reasoning (some models/streaming fail with reasoning enabled).
			yield* this.runAgentLoop(openai, model, convo, signal, onTool, false, onReasoning);
		}
	}

	private async getOpenRouterApiKey(): Promise<string | undefined> {
		let key = await this.secrets.get("openrouter.apiKey");
		if (!key) {
			key = vscode.workspace
				.getConfiguration("nvidia")
				.get<string>("openrouterApiKey");
		}
		return key || undefined;
	}

	/** Store the OpenRouter API key in VS Code secret storage. */
	async setOpenRouterApiKey(key: string): Promise<void> {
		await this.secrets.store("openrouter.apiKey", key);
		await vscode.workspace
			.getConfiguration("nvidia")
			.update("openrouterApiKey", key, vscode.ConfigurationTarget.Global);
	}

	private async getApiKey(): Promise<string | undefined> {
		let key = await this.secrets.get("nvidia.apiKey");
		if (!key) {
			key = vscode.workspace
				.getConfiguration("nvidia")
				.get<string>("apiKey");
		}
		return key || undefined;
	}

	/** Store the API key in VS Code secret storage. */
	async setApiKey(key: string): Promise<void> {
		await this.secrets.store("nvidia.apiKey", key);
		await vscode.workspace
			.getConfiguration("nvidia")
			.update("apiKey", key, vscode.ConfigurationTarget.Global);
	}

	private async discoverModels(): Promise<vscode.LanguageModelChatInformation[]> {
		try {
			const openai = new OpenAI({
				apiKey: "no-key-required-for-model-list",
				baseURL: NVIDIA_API_BASE,
			});

			// List models from NVIDIA API (does not require an API key)
			const models = await openai.models.list();

			const excluded = [
				"embed",
				"embedding",
				"safety",
				"reward",
				"parse",
				"vl-8b",
			];

			const list: vscode.LanguageModelChatInformation[] = [];
			for (const model of models.data) {
				const id = model.id;
				if (typeof id !== "string") continue;
				if (!id.toLowerCase().includes("nemotron")) continue;
				if (excluded.some((e) => id.toLowerCase().includes(e))) continue;
				const family = "nvidia";
				const name = id.split("/").pop() ?? id;
				list.push({
					id: MODEL_ID_PREFIX + id,
					name,
					family,
					version: "latest",
					maxInputTokens: 128000,
					maxOutputTokens: 8192,
					capabilities: {
						imageInput: false,
						toolCalling: true,
					},
				});
			}
			return list;
		} catch (err) {
			vscode.window.showErrorMessage(`Failed to discover NVIDIA models: ${err}`);
			return [];
		}
	}

	async provideLanguageModelChatInformation(
		options: vscode.PrepareLanguageModelChatModelOptions,
		token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelChatInformation[]> {
		const silent = "silent" in options && options.silent === true;
		if (this._cachedModels) return this._cachedModels;

		const list = await this.discoverModels();
		if (list.length > 0) {
			this._cachedModels = list;
		}
		return this._cachedModels ?? [];
	}

	async provideLanguageModelChatResponse(
		model: vscode.LanguageModelChatInformation,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken,
	): Promise<void> {
		const apiKey = await this.getApiKey();
		if (!apiKey) {
			throw new Error(
				"NVIDIA API key no configurada. Abre la Configuración e ingresa tu clave.",
			);
		}

		const modelId = this.getModelId(model.id);
		const openai = new OpenAI({
			apiKey,
			baseURL: NVIDIA_API_BASE,
		});

		const controller = new AbortController();
		token.onCancellationRequested(() => controller.abort());

		const stream = await openai.chat.completions.create(
			{
				model: modelId,
				messages: messages as any,
				stream: true,
				tools: this.agentTools as any,
				tool_choice: "auto",
			} as any,
			{ signal: controller.signal }
		);

const iterable = stream as unknown as AsyncIterable<any>;
		for await (const chunk of iterable) {
			for (const choice of chunk.choices ?? []) {
				const delta = choice.delta;
				if (delta.content) {
					progress.report(new vscode.LanguageModelTextPart(delta.content));
				}
			}
		}
	}

	private getModelId(vscodeModelId: string): string {
		return vscodeModelId.startsWith(MODEL_ID_PREFIX)
			? vscodeModelId.slice(MODEL_ID_PREFIX.length)
			: vscodeModelId;
	}

	async provideTokenCount(
		_model: vscode.LanguageModelChatInformation,
		text: string | vscode.LanguageModelChatRequestMessage,
		_token: vscode.CancellationToken,
	): Promise<number> {
		const content = typeof text === "string" ? text : JSON.stringify(text);
		return Math.ceil(content.length / 3);
	}
}
