import * as vscode from "vscode";
import MarkdownIt from "markdown-it";
import { NvidiaProvider } from "./provider.js";

const md = new MarkdownIt({
	html: false,
	breaks: true,
	linkify: true,
});

interface ChatMessage {
	role: string;
	content: string;
	html?: string;
	timestamp?: number;
	toolCalls?: ToolCallDisplay[];
}

interface ToolCallDisplay {
	name: string;
	args: Record<string, unknown>;
	result: string;
	status: "pending" | "running" | "done" | "error";
}

interface ChatSession {
	id: string;
	title: string;
	messages: ChatMessage[];
}

export class NvidiaViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = "nvidia.welcome";

	private _view?: vscode.WebviewView;
	private readonly provider: NvidiaProvider;
	private readonly workspaceState: vscode.Memento;
	private readonly version: string;
	private readonly extensionUri: vscode.Uri;
	private readonly chatsKey = "nvidia.chats";
	private readonly activeChatKey = "nvidia.activeChatId";
	private readonly providerKey = "nvidia.provider";
	private readonly modelKey = "nvidia.model";
	private readonly autoApproveKey = "nvidia.autoApprove";
	private readonly webSearchKey = "nvidia.webSearch";
	private readonly runCommandKey = "nvidia.runCommand";
	private readonly downloadFileKey = "nvidia.downloadFile";
	private readonly gitPermKey = "nvidia.gitPerm";
	private readonly nvidiaEnabledKey = "nvidia.nvidiaEnabled";
	private readonly openrouterEnabledKey = "nvidia.openrouterEnabled";
	private readonly deepseekEnabledKey = "nvidia.deepseekEnabled";
	private abortController?: AbortController;

	constructor(
		provider: NvidiaProvider,
		workspaceState: vscode.Memento,
		version?: string,
		extensionUri?: vscode.Uri,
	) {
		this.provider = provider;
		this.workspaceState = workspaceState;
		this.version = version ?? "0.0.0";
		this.extensionUri = extensionUri ?? vscode.Uri.file("");
	}

	private getChats(): ChatSession[] {
		return this.workspaceState.get<ChatSession[]>(this.chatsKey, []);
	}

	private async saveChats(chats: ChatSession[]): Promise<void> {
		await this.workspaceState.update(this.chatsKey, chats);
	}

	private getActiveChatId(): string | undefined {
		return this.workspaceState.get<string>(this.activeChatKey);
	}

	private async setActiveChatId(id: string): Promise<void> {
		await this.workspaceState.update(this.activeChatKey, id);
	}

	private newChatId(): string {
		return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
	}

	private makeTitle(messages: ChatMessage[]): string {
		const firstUser = messages.find((m) => m.role === "user");
		if (!firstUser) return "Nuevo chat";
		const t = firstUser.content.replace(/\s+/g, " ").trim();
		return t.length > 40 ? t.slice(0, 40) + "…" : t;
	}

	private sendChatList(): void {
		const chats = this.getChats();
		const activeId = this.getActiveChatId();
		this._view?.webview.postMessage({
			command: "chats",
			chats: chats.map((c) => ({ id: c.id, title: c.title })),
			activeId,
		});
	}

	private withRenderedHtml(
		messages: ChatMessage[],
	): ChatMessage[] {
		return messages.map((m) => {
			if (m.role === "assistant" && !m.html) {
				return { ...m, html: md.render(m.content) };
			}
			return m;
		});
	}

	private async persistChat(
		chatId: string,
		history: ChatMessage[],
		fullText: string,
	): Promise<void> {
		const chats = this.getChats();
		const idx = chats.findIndex((c) => c.id === chatId);
		if (idx < 0) return;
		const msgs = history.filter(
			(m) => m.role === "user" || m.role === "assistant",
		);
		if (fullText.trim()) {
			msgs.push({ role: "assistant", content: fullText, timestamp: Date.now() });
		}
		chats[idx] = {
			...chats[idx],
			title: this.makeTitle(msgs),
			messages: msgs,
		};
		await this.saveChats(chats);
		this.sendChatList();
	}

	resolveWebviewView(
		webviewView: vscode.WebviewView,
		context: vscode.WebviewViewResolveContext,
		token: vscode.CancellationToken,
	): void {
		this._view = webviewView;

		webviewView.webview.options = {
			enableScripts: true,
		};

		const donationGifUri = webviewView.webview.asWebviewUri(
			vscode.Uri.joinPath(this.extensionUri, "media", "donation.gif"),
		);

		webviewView.webview.html = this.getHtml(donationGifUri);

		webviewView.webview.onDidReceiveMessage(async (message) => {
			switch (message.command) {
				case "init": {
					let chats = this.getChats();
					let activeId = this.getActiveChatId();
					if (!activeId || !chats.find((c) => c.id === activeId)) {
						if (chats.length === 0) {
							const c: ChatSession = {
								id: this.newChatId(),
								title: "Nuevo chat",
								messages: [],
							};
							chats.push(c);
							await this.saveChats(chats);
						}
						activeId = chats[0].id;
						await this.setActiveChatId(activeId);
					}
					const active = chats.find((c) => c.id === activeId);
					const savedProvider = this.workspaceState.get<string>(
						this.providerKey,
						"nvidia",
					);
					const savedModel = this.workspaceState.get<string>(this.modelKey, "");
					const savedAuto = this.workspaceState.get<boolean>(
						this.autoApproveKey,
						false,
					);
					const savedWeb = this.workspaceState.get<boolean>(
						this.webSearchKey,
						false,
					);
					const savedRunCommand = this.workspaceState.get<boolean>(
						this.runCommandKey,
						false,
					);
					const savedDownloadFile = this.workspaceState.get<boolean>(
						this.downloadFileKey,
						false,
					);
					const savedGitPerm = this.workspaceState.get<boolean>(
						this.gitPermKey,
						false,
					);
					const savedNvidiaEnabled = this.workspaceState.get<boolean>(
						this.nvidiaEnabledKey,
						true,
					);
					const savedOpenrouterEnabled = this.workspaceState.get<boolean>(
						this.openrouterEnabledKey,
						true,
					);
					const savedDeepseekEnabled = this.workspaceState.get<boolean>(
						this.deepseekEnabledKey,
						true,
					);
					this.provider.setAutoApprove(savedAuto);
					this.provider.setWebSearchEnabled(savedWeb);
					this.provider.setPermission("runCommand", savedRunCommand);
					this.provider.setPermission("downloadFile", savedDownloadFile);
					this.provider.setPermission("git", savedGitPerm);
					this._view?.webview.postMessage({
						command: "init",
						chats: chats.map((c) => ({ id: c.id, title: c.title })),
						activeId,
						history: this.withRenderedHtml(active?.messages ?? []),
						settings: {
							provider: savedProvider,
							model: savedModel,
							autoApprove: savedAuto,
							webSearch: savedWeb,
							runCommand: savedRunCommand,
							downloadFile: savedDownloadFile,
							git: savedGitPerm,
							nvidiaEnabled: savedNvidiaEnabled,
							openrouterEnabled: savedOpenrouterEnabled,
							deepseekEnabled: savedDeepseekEnabled,
						},
					});
					break;
				}
				case "newChat": {
					const c: ChatSession = {
						id: this.newChatId(),
						title: "Nuevo chat",
						messages: [],
					};
					const chats = this.getChats();
					chats.unshift(c);
					await this.saveChats(chats);
					await this.setActiveChatId(c.id);
					this._view?.webview.postMessage({
						command: "chatOpened",
						id: c.id,
						history: [],
					});
					this.sendChatList();
					break;
				}
				case "switchChat": {
					const id: string = message.id;
					await this.setActiveChatId(id);
					const chat = this.getChats().find((c) => c.id === id);
					this._view?.webview.postMessage({
						command: "chatOpened",
						id,
						history: this.withRenderedHtml(chat?.messages ?? []),
					});
					break;
				}
				case "deleteChat": {
					const id: string = message.id;
					let chats = this.getChats().filter((c) => c.id !== id);
					if (this.getActiveChatId() === id) {
						if (chats.length === 0) {
							chats = [
								{
									id: this.newChatId(),
									title: "Nuevo chat",
									messages: [],
								},
							];
						}
						await this.setActiveChatId(chats[0].id);
						this._view?.webview.postMessage({
							command: "chatOpened",
							id: chats[0].id,
							history: this.withRenderedHtml(chats[0].messages ?? []),
						});
					}
					await this.saveChats(chats);
					this.sendChatList();
					break;
				}
				case "stopGeneration": {
					this.abortController?.abort();
					break;
				}
				case "copyText": {
					await vscode.env.clipboard.writeText(String(message.text ?? ""));
					break;
				}
				case "openExternal": {
					const url = String(message.url ?? "");
					if (url) {
						await vscode.env.openExternal(vscode.Uri.parse(url));
					}
					break;
				}
				case "getContext": {
					const editor = vscode.window.activeTextEditor;
					if (!editor) {
						this._view?.webview.postMessage({
							command: "context",
							text: "",
							label: "",
						});
						break;
					}
					const sel = editor.selection;
					let text = "";
					let label = "";
					if (!sel.isEmpty) {
						text = editor.document.getText(sel);
						label = `${editor.document.fileName} (selección)`;
					} else {
						text = editor.document.getText().slice(0, 4000);
						label = editor.document.fileName;
					}
					this._view?.webview.postMessage({ command: "context", text, label });
					break;
				}
				case "exportChat": {
					const chat = this.getChats().find((c) => c.id === message.id);
					if (!chat) break;
					let out = `# ${chat.title}\n\n`;
					for (const m of chat.messages) {
						out += `## ${m.role === "user" ? "Usuario" : "Asistente"}\n\n${m.content}\n\n`;
					}
					const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
					const uri = await vscode.window.showSaveDialog({
						defaultUri: folder
							? vscode.Uri.joinPath(folder, "chat.md")
							: vscode.Uri.file("chat.md"),
						filters: { Markdown: ["md"] },
					});
					if (uri) {
						await vscode.workspace.fs.writeFile(
							uri,
							Buffer.from(out, "utf8"),
						);
						vscode.window.showInformationMessage("Chat exportado correctamente.");
					}
					break;
				}
				case "openSettings": {
					await vscode.commands.executeCommand("nvidia.openSettings");
					break;
				}
				case "openDebugConsole": {
					await vscode.commands.executeCommand("nvidia.openDebugConsole");
					break;
				}
				case "getOutputDir": {
					this._view?.webview.postMessage({
						command: "outputDir",
						dir: this.provider.getOutputFolder(),
					});
					break;
				}
				case "setOutputDir": {
					await vscode.commands.executeCommand("nvidia.setOutputDirectory");
					this._view?.webview.postMessage({
						command: "outputDir",
						dir: this.provider.getOutputFolder(),
					});
					break;
				}
				case "setAutoApprove": {
					const v = Boolean(message.value);
					this.provider.setAutoApprove(v);
					await this.workspaceState.update(this.autoApproveKey, v);
					break;
				}
				case "setWebSearch": {
					const v = Boolean(message.value);
					this.provider.setWebSearchEnabled(v);
					await this.workspaceState.update(this.webSearchKey, v);
					break;
				}
				case "setRunCommand": {
					const v = Boolean(message.value);
					this.provider.setPermission("runCommand", v);
					await this.workspaceState.update(this.runCommandKey, v);
					break;
				}
				case "setDownloadFile": {
					const v = Boolean(message.value);
					this.provider.setPermission("downloadFile", v);
					await this.workspaceState.update(this.downloadFileKey, v);
					break;
				}
				case "setGit": {
					const v = Boolean(message.value);
					this.provider.setPermission("git", v);
					await this.workspaceState.update(this.gitPermKey, v);
					break;
				}
				case "setProviderEnabled": {
					const v = Boolean(message.value);
					const prov = String(message.provider);
					if (prov === "nvidia") {
						await this.workspaceState.update(this.nvidiaEnabledKey, v);
					} else if (prov === "openrouter") {
						await this.workspaceState.update(this.openrouterEnabledKey, v);
					} else if (prov === "deepseek") {
						await this.workspaceState.update(this.deepseekEnabledKey, v);
					}
					break;
				}
				case "setProvider": {
					await this.workspaceState.update(
						this.providerKey,
						String(message.value),
					);
					break;
				}
				case "setModel": {
					await this.workspaceState.update(this.modelKey, String(message.value));
					break;
				}
				case "getModels": {
					const providerName: string = message.provider ?? "nvidia";
					try {
						const models =
							providerName === "openrouter"
								? await this.provider.getOpenRouterFreeModels()
								: providerName === "deepseek"
									? this.provider.getDeepSeekModels()
									: await this.provider.getNemotronModels();
						this._view?.webview.postMessage({
							command: "models",
							models,
						});
					} catch (err) {
						this._view?.webview.postMessage({
							command: "modelsError",
							message: String(err),
						});
					}
					break;
				}
				case "send": {
					const history: ChatMessage[] = message.history ?? [];
					const model: string = message.model;
					const providerName: string = message.provider ?? "nvidia";
					const chatId: string = message.chatId;

					// Cancel any in-flight request so we never run two at once.
					this.abortController?.abort();
					this.abortController = new AbortController();
					const signal = this.abortController.signal;

					webviewView.webview.postMessage({ command: "streamStart" });
					let fullText = "";
					const onTool = (name: string) => {
						webviewView.webview.postMessage({
							command: "toolWorking",
							name,
						});
					};
					const onReasoning = () => {
						webviewView.webview.postMessage({
							command: "reasoning",
						});
					};
					try {
						const gen =
							providerName === "openrouter"
								? this.provider.streamOpenRouterChat(history, model, signal, onTool, onReasoning)
								: providerName === "deepseek"
									? this.provider.streamDeepSeekChat(history, model, signal, onTool, onReasoning)
									: this.provider.streamChat(history, model, signal, onTool, onReasoning);
						for await (const chunk of gen) {
							fullText += chunk;
							webviewView.webview.postMessage({
								command: "streamChunk",
								text: chunk,
								html: md.render(fullText),
							});
						}
						await this.persistChat(chatId, history, fullText);
						webviewView.webview.postMessage({
							command: "streamEnd",
							html: md.render(fullText),
							text: fullText,
						});
					} catch (err) {
						if (signal.aborted) {
							await this.persistChat(chatId, history, fullText);
							webviewView.webview.postMessage({
								command: "streamEnd",
								html: md.render(fullText),
								text: fullText,
								stopped: true,
							});
						} else {
							webviewView.webview.postMessage({
								command: "streamError",
								message: String(err),
							});
						}
					}
					break;
				}
			}
		});
	}

	private getHtml(donationGifUri: vscode.Uri): string {
		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<style>
		:root {
			--cy-cyan: #00e5ff;
			--cy-magenta: #ff00e0;
			--cy-green: #00ff9c;
			--cy-yellow: #f0ff00;
			--cy-bg: #0a0a14;
			--cy-panel: #131324;
			--cy-bubble: #17172b;
		}
		* { box-sizing: border-box; }
		body {
			font-family: var(--vscode-font-family);
			color: #d8d8f0;
			margin: 0;
			display: flex;
			flex-direction: column;
			height: 100vh;
			overflow: hidden;
			background:
				radial-gradient(circle at 20% 10%, rgba(0,229,255,0.06), transparent 40%),
				radial-gradient(circle at 80% 90%, rgba(255,0,224,0.06), transparent 40%),
				var(--cy-bg);
		}

		/* ---------- Header ---------- */
		#header {
			position: relative;
			display: flex;
			align-items: center;
			justify-content: space-between;
			padding: 6px 8px;
			border-bottom: 1px solid rgba(0,229,255,0.15);
			z-index: 20;
		}
		#header-left {
			font-size: 11px;
			letter-spacing: 1px;
			text-transform: uppercase;
			color: var(--cy-cyan);
			opacity: 0.7;
			text-shadow: 0 0 6px var(--cy-cyan);
		}
		#version-badge {
			display: inline-block;
			margin-left: 6px;
			padding: 1px 5px;
			border: 1px solid rgba(0,229,255,0.25);
			border-radius: 8px;
			font-size: 9px;
			letter-spacing: 0;
			text-transform: none;
			color: var(--cy-green);
			opacity: 0.75;
			vertical-align: middle;
		}
		#header-right { display: flex; gap: 4px; }
		.hbtn {
			background: transparent;
			border: 1px solid rgba(0,229,255,0.25);
			border-radius: 6px;
			width: 26px;
			height: 26px;
			display: flex;
			align-items: center;
			justify-content: center;
			cursor: pointer;
			color: var(--cy-cyan);
			transition: all 0.2s ease;
			padding: 0;
		}
		.hbtn:hover {
			background: rgba(0,229,255,0.12);
			box-shadow: 0 0 10px rgba(0,229,255,0.5);
			border-color: var(--cy-cyan);
		}
		.hbtn.active {
			background: rgba(0,229,255,0.18);
			border-color: var(--cy-cyan);
			color: #fff;
		}

		/* ---------- Popups ---------- */
		#popup-layer {
			position: absolute;
			top: 39px;
			right: 8px;
			z-index: 30;
		}
		.popup {
			display: none;
			background: var(--cy-panel);
			border: 1px solid rgba(0,229,255,0.3);
			border-radius: 8px;
			box-shadow: 0 10px 30px rgba(0,0,0,0.7), 0 0 15px rgba(0,229,255,0.15);
			padding: 10px;
			min-width: 240px;
			max-width: 320px;
		}
		.popup.open { display: block; animation: pop-in 0.15s ease; }
		@keyframes pop-in {
			from { opacity: 0; transform: translateY(-6px); }
			to { opacity: 1; transform: translateY(0); }
		}
		.popup-title {
			font-size: 10px;
			text-transform: uppercase;
			letter-spacing: 1px;
			color: var(--cy-cyan);
			margin: 0 0 8px 0;
			opacity: 0.7;
		}
		#prov-tabs { display: flex; gap: 4px; margin-bottom: 8px; }
		#prov-switches { margin-bottom: 8px; }
		.prov-switch-row {
			display: flex;
			align-items: center;
			gap: 6px;
			padding: 5px 8px;
			border: 1px solid rgba(0,229,255,0.2);
			border-radius: 6px;
			font-size: 11px;
			color: var(--cy-cyan);
			margin-bottom: 4px;
		}
		.prov-switch-row .switch-label { flex: 1; }
		.prov-btn {
			flex: 1;
			padding: 5px;
			border: 1px solid rgba(0,229,255,0.25);
			border-radius: 6px;
			background: transparent;
			color: var(--cy-cyan);
			cursor: pointer;
			font-size: 11px;
			font-family: inherit;
			text-transform: uppercase;
			transition: all 0.2s ease;
		}
		.prov-btn.active {
			background: rgba(0,229,255,0.15);
			color: #fff;
			border-color: var(--cy-cyan);
			text-shadow: 0 0 6px var(--cy-cyan);
		}
		#model-row {
			display: flex;
			align-items: center;
			gap: 6px;
			padding: 4px 8px;
			border: 1px solid rgba(255,0,224,0.25);
			border-radius: 6px;
			color: var(--cy-magenta);
		}
		#model-row .ico { display: flex; }
		#model-select {
			flex: 1;
			background: transparent;
			color: #d8d8f0;
			border: none;
			outline: none;
			padding: 5px 0;
			font-size: 12px;
			font-family: inherit;
		}
		#model-select option { background: var(--cy-panel); color: #d8d8f0; }

		#auto-row, #web-row, #cmd-row, #dl-row, #git-row {
			display: flex;
			align-items: center;
			gap: 6px;
			padding: 6px 8px;
			border-radius: 6px;
			font-size: 11px;
			margin-bottom: 6px;
		}
		#auto-row { border: 1px solid rgba(240,255,0,0.25); color: var(--cy-yellow); }
		#web-row { border: 1px solid rgba(0,229,255,0.25); color: var(--cy-cyan); }
		#cmd-row { border: 1px solid rgba(255,0,224,0.25); color: var(--cy-magenta); }
		#dl-row { border: 1px solid rgba(0,255,156,0.25); color: var(--cy-green); }
		#git-row { border: 1px solid rgba(0,229,255,0.25); color: var(--cy-cyan); }
		#auto-row .switch-label, #web-row .switch-label, #cmd-row .switch-label, #dl-row .switch-label, #git-row .switch-label { flex: 1; }
		.switch { position: relative; display: inline-block; width: 32px; height: 17px; flex-shrink: 0; }
		.switch input { opacity: 0; width: 0; height: 0; }
		.slider {
			position: absolute;
			cursor: pointer;
			top: 0; left: 0; right: 0; bottom: 0;
			background: rgba(0,0,0,0.4);
			border: 1px solid rgba(0,229,255,0.4);
			border-radius: 17px;
			transition: 0.25s;
		}
		.slider:before {
			content: "";
			position: absolute;
			height: 11px; width: 11px;
			left: 2px; bottom: 2px;
			background: var(--cy-cyan);
			border-radius: 50%;
			transition: 0.25s;
		}
		.switch input:checked + .slider {
			background: rgba(0,229,255,0.25);
			box-shadow: 0 0 8px rgba(0,229,255,0.6);
		}
		.switch input:checked + .slider:before {
			transform: translateX(15px);
			background: var(--cy-green);
		}
		.folder-info {
			display: flex;
			align-items: center;
			gap: 6px;
			padding: 6px 8px;
			border: 1px solid rgba(0,255,156,0.25);
			border-radius: 6px;
			color: var(--cy-green);
			font-size: 11px;
			margin-bottom: 8px;
		}
		#output-dir { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: 0.9; }
		#setDirBtn {
			width: 100%;
			padding: 6px;
			background: transparent;
			border: 1px solid rgba(0,255,156,0.4);
			color: var(--cy-green);
			border-radius: 6px;
			cursor: pointer;
			font-size: 11px;
			font-family: inherit;
			transition: all 0.2s ease;
		}
		#setDirBtn:hover { background: rgba(0,255,156,0.12); box-shadow: 0 0 8px rgba(0,255,156,0.5); }
		#donate-anim {
			display: block;
			width: 120px;
			height: 120px;
			margin: 0 auto 6px;
			object-fit: contain;
			border-radius: 12px;
		}
		.donate-text {
			font-size: 11.5px;
			color: #d8d8f0;
			text-align: center;
			margin: 0 0 8px 0;
		}
		.donate-row {
			display: flex;
			align-items: center;
			gap: 6px;
			padding: 6px 8px;
			border: 1px solid rgba(0,229,255,0.25);
			border-radius: 6px;
			color: var(--cy-cyan);
			font-size: 11.5px;
			margin-bottom: 8px;
		}
		.donate-row .ico { display: flex; flex-shrink: 0; }
		#paypal-email { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.donate-actions { display: flex; gap: 6px; }
		.donate-actions button {
			flex: 1;
			padding: 7px;
			border-radius: 6px;
			cursor: pointer;
			font-family: inherit;
			font-size: 11.5px;
			transition: all 0.2s ease;
		}
		#donateCopyBtn {
			background: transparent;
			border: 1px solid rgba(0,229,255,0.4);
			color: var(--cy-cyan);
		}
		#donateCopyBtn:hover { background: rgba(0,229,255,0.12); box-shadow: 0 0 8px rgba(0,229,255,0.4); }
		#donateOpenBtn {
			background: linear-gradient(120deg, #ffd600, #ff9e00);
			border: none;
			color: #1a1a1a;
			font-weight: 600;
		}
		#donateOpenBtn:hover { box-shadow: 0 0 10px rgba(255,214,0,0.6); transform: scale(1.02); }
		#bmcBtn {
			width: 100%;
			margin-top: 8px;
			padding: 8px;
			border-radius: 8px;
			cursor: pointer;
			font-family: inherit;
			font-size: 12px;
			font-weight: 600;
			background: #FFDD00;
			color: #000000;
			border: none;
			transition: all 0.2s ease;
		}
		#bmcBtn:hover { box-shadow: 0 0 10px rgba(255,221,0,0.7); transform: scale(1.02); }

		/* ---------- Drawer (chats) ---------- */
		#drawer {
			position: fixed;
			top: 0;
			right: 0;
			width: 250px;
			height: 100%;
			background: var(--cy-panel);
			border-left: 1px solid rgba(0,229,255,0.3);
			box-shadow: -10px 0 30px rgba(0,0,0,0.7);
			transform: translateX(100%);
			transition: transform 0.25s ease;
			z-index: 50;
			display: flex;
			flex-direction: column;
		}
		#drawer.open { transform: translateX(0); }
		#drawer-head {
			display: flex;
			align-items: center;
			justify-content: space-between;
			padding: 10px;
			border-bottom: 1px solid rgba(0,229,255,0.15);
		}
		#drawer-head h3 {
			margin: 0;
			font-size: 12px;
			text-transform: uppercase;
			letter-spacing: 1px;
			color: var(--cy-cyan);
		}
		#drawer-head button {
			background: transparent;
			border: 1px solid rgba(0,229,255,0.3);
			color: var(--cy-cyan);
			border-radius: 5px;
			width: 24px;
			height: 24px;
			cursor: pointer;
			display: flex;
			align-items: center;
			justify-content: center;
		}
		#chat-list {
			flex: 1;
			overflow-y: auto;
			padding: 6px;
		}
		.chat-item {
			display: flex;
			align-items: center;
			gap: 6px;
			padding: 8px;
			border-radius: 6px;
			cursor: pointer;
			margin-bottom: 4px;
			border: 1px solid transparent;
			font-size: 12px;
			transition: all 0.15s ease;
		}
		.chat-item:hover { background: rgba(0,229,255,0.06); }
		.chat-item.active {
			background: rgba(0,229,255,0.12);
			border-color: rgba(0,229,255,0.4);
		}
		.chat-item .chat-title {
			flex: 1;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		.chat-item .chat-del {
			background: transparent;
			border: none;
			color: rgba(255,0,224,0.6);
			cursor: pointer;
			opacity: 0;
			display: flex;
			align-items: center;
			padding: 2px;
		}
		.chat-item:hover .chat-del { opacity: 1; }
		.chat-item .chat-del:hover { color: var(--cy-magenta); }
		#drawer-footer { padding: 8px; border-top: 1px solid rgba(0,229,255,0.15); }
		#newChatBtn {
			width: 100%;
			padding: 8px;
			background: rgba(0,229,255,0.1);
			border: 1px solid rgba(0,229,255,0.4);
			color: var(--cy-cyan);
			border-radius: 6px;
			cursor: pointer;
			font-family: inherit;
			font-size: 12px;
			display: flex;
			align-items: center;
			justify-content: center;
			gap: 6px;
			transition: all 0.2s ease;
		}
		#newChatBtn:hover { background: rgba(0,229,255,0.2); box-shadow: 0 0 10px rgba(0,229,255,0.4); }
		#drawer-overlay {
			position: fixed;
			top: 0; left: 0; right: 0; bottom: 0;
			background: rgba(0,0,0,0.4);
			opacity: 0;
			pointer-events: none;
			transition: opacity 0.25s ease;
			z-index: 40;
		}
		#drawer-overlay.open { opacity: 1; pointer-events: auto; }

		/* ---------- Chat ---------- */
		#chat { flex: 1; overflow-y: auto; padding: 10px 10px 6px; }
		.msg-row {
			display: flex;
			gap: 6px;
			margin-bottom: 12px;
			align-items: flex-start;
			position: relative;
		}
		.msg-row.user { flex-direction: row-reverse; }
		.msg-avatar {
			width: 20px;
			height: 20px;
			border-radius: 50%;
			flex-shrink: 0;
			display: flex;
			align-items: center;
			justify-content: center;
			border: 1px solid rgba(0,229,255,0.4);
			color: var(--cy-cyan);
			background: rgba(0,229,255,0.06);
			margin-top: 3px;
		}
		.msg-row.user .msg-avatar {
			border-color: rgba(255,0,224,0.4);
			color: var(--cy-magenta);
			background: rgba(255,0,224,0.06);
		}
		.msg-col { display: flex; flex-direction: column; max-width: 94%; }
		.msg-bubble {
			padding: 1px;
			border-radius: 10px;
			background: linear-gradient(120deg, rgba(255,0,224,0.28), rgba(0,229,255,0.28), rgba(0,255,156,0.28), rgba(255,0,224,0.28));
		}
		.msg-inner {
			background: var(--cy-bubble);
			border-radius: 9px;
			padding: 8px 11px;
			word-wrap: break-word;
			overflow-wrap: anywhere;
			font-size: 12.5px;
			line-height: 1.45;
		}
		.msg-row.user .msg-inner { background: #1c1030; white-space: pre-wrap; }
		.msg-inner p { margin: 0 0 6px 0; }
		.msg-inner p:last-child { margin-bottom: 0; }
		.msg-inner a {
			color: var(--cy-cyan);
			text-decoration: none;
			border-bottom: 1px solid rgba(0,229,255,0.35);
			transition: color 0.15s ease, border-color 0.15s ease;
		}
		.msg-inner a:hover {
			color: #ffffff;
			border-bottom-color: var(--cy-cyan);
			text-shadow: 0 0 6px rgba(0,229,255,0.5);
		}
		.msg-inner strong, .msg-inner b { color: #ffffff; font-weight: 600; }
		.msg-inner em, .msg-inner i { color: rgba(216,216,240,0.92); }
		.msg-inner del, .msg-inner s, .msg-inner strike { opacity: 0.55; }
		.msg-inner ul, .msg-inner ol { margin: 0 0 6px 0; padding-left: 20px; }
		.msg-inner li { margin: 2px 0; }
		.msg-inner ul li::marker { color: var(--cy-cyan); }
		.msg-inner ol li::marker { color: var(--cy-magenta); }
		.msg-inner h1, .msg-inner h2, .msg-inner h3, .msg-inner h4, .msg-inner h5, .msg-inner h6 {
			margin: 12px 0 5px 0;
			line-height: 1.3;
			font-weight: 600;
			color: #ffffff;
		}
		.msg-inner h1 { font-size: 18px; }
		.msg-inner h2 { font-size: 16px; }
		.msg-inner h3 { font-size: 14px; }
		.msg-inner h4 { font-size: 13px; }
		.msg-inner h5 { font-size: 12.5px; }
		.msg-inner h6 { font-size: 12px; opacity: 0.85; }
		.msg-inner h1, .msg-inner h2 {
			padding-bottom: 3px;
			border-bottom: 1px solid rgba(0,229,255,0.15);
		}
		.msg-inner blockquote {
			margin: 6px 0;
			padding: 4px 12px;
			border-left: 3px solid var(--cy-cyan);
			background: rgba(0,229,255,0.04);
			border-radius: 0 6px 6px 0;
			color: rgba(216,216,240,0.85);
		}
		.msg-inner blockquote p { margin-bottom: 2px; }
		.msg-inner hr { margin: 10px 0; border: none; border-top: 1px solid rgba(0,229,255,0.2); }
		.msg-inner code {
			background: #44475a;
			padding: 2px 5px;
			border-radius: 4px;
			font-family: var(--vscode-editor-font-family, monospace);
			font-size: 11.5px;
			color: #8be9fd;
		}
		.msg-inner pre {
			background:
				linear-gradient(#282a36, #282a36) padding-box,
				linear-gradient(120deg, #4a9eff, #00e5ff, #bd93f9) border-box;
			border: 1px solid transparent;
			border-radius: 8px;
			padding: 10px 12px;
			overflow-x: auto;
			color: #f8f8f2;
		}
		.msg-inner pre code {
			background: none;
			padding: 0;
			color: inherit;
		}
		.msg-inner pre::-webkit-scrollbar { height: 6px; }
		.msg-inner pre::-webkit-scrollbar-thumb {
			background: rgba(139,233,253,0.3);
			border-radius: 3px;
		}
		.code-block { position: relative; }
		.code-copy-btn {
			position: absolute;
			top: 6px;
			right: 6px;
			width: 22px;
			height: 22px;
			background: rgba(40,42,54,0.9);
			border: 1px solid rgba(139,233,253,0.3);
			color: #8be9fd;
			border-radius: 4px;
			cursor: pointer;
			display: flex;
			align-items: center;
			justify-content: center;
			padding: 0;
			opacity: 0;
			transition: opacity 0.15s ease;
		}
		.code-block:hover .code-copy-btn { opacity: 1; }
		.code-copy-btn:hover { background: rgba(68,71,90,0.95); border-color: #8be9fd; }
		.table-wrapper {
			max-width: 100%;
			overflow-x: auto;
			border-radius: 6px;
			border: 1px solid rgba(0,229,255,0.15);
			margin: 4px 0;
		}
		.msg-inner table {
			width: 100%;
			border-collapse: collapse;
			font-size: 12px;
		}
		.msg-inner th, .msg-inner td {
			border: 1px solid rgba(0,229,255,0.25);
			padding: 6px 8px;
			text-align: left;
			white-space: normal;
			word-break: break-word;
		}
		.msg-inner th {
			background: rgba(0,229,255,0.08);
			color: #ffffff;
			font-weight: 600;
		}
		.msg-inner tr:nth-child(even) td { background: rgba(0,0,0,0.15); }
		.msg-inner img { max-width: 100%; height: auto; }
		.table-wrapper::-webkit-scrollbar { height: 6px; }
		.table-wrapper::-webkit-scrollbar-thumb {
			background: rgba(0,229,255,0.3);
			border-radius: 3px;
		}

		.msg-actions {
			display: flex;
			gap: 4px;
			margin-top: 4px;
			opacity: 0.45;
			transition: opacity 0.15s ease;
		}
		.msg-row:hover .msg-actions { opacity: 1; }
		.msg-row.user .msg-actions { flex-direction: row-reverse; }
		.mbtn {
			background: transparent;
			border: 1px solid rgba(0,229,255,0.3);
			color: var(--cy-cyan);
			border-radius: 4px;
			width: 20px;
			height: 20px;
			cursor: pointer;
			display: flex;
			align-items: center;
			justify-content: center;
			padding: 0;
			transition: all 0.15s ease;
		}
		.mbtn:hover { background: rgba(0,229,255,0.15); }

		/* Thinking indicator */
		.thinking { display: flex; gap: 4px; padding: 4px 2px; align-items: center; }
		.think-label {
			font-size: 11px;
			color: var(--cy-cyan);
			opacity: 0.75;
			margin-right: 4px;
		}
		.thinking span.dot {
			width: 6px; height: 6px; border-radius: 50%;
			background: var(--cy-cyan);
			animation: blink 1.2s infinite;
		}
		.thinking span.dot:nth-child(3) { animation-delay: 0.2s; }
		.thinking span.dot:nth-child(4) { animation-delay: 0.4s; }
		@keyframes blink {
			0%, 80%, 100% { opacity: 0.2; transform: scale(0.8); }
			40% { opacity: 1; transform: scale(1.2); }
		}

		/* Context chip */
		#context-chip {
			display: none;
			align-items: center;
			gap: 6px;
			padding: 4px 8px;
			margin: 0 10px 4px;
			border: 1px solid rgba(240,255,0,0.3);
			border-radius: 6px;
			color: var(--cy-yellow);
			font-size: 11px;
		}
		#context-chip.show { display: flex; }
		#context-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		#context-clear { background: transparent; border: none; color: var(--cy-yellow); cursor: pointer; }

		/* ---------- Input ---------- */
		#input-row {
			display: flex;
			gap: 6px;
			padding: 8px 10px;
			border-top: 1px solid rgba(0,229,255,0.15);
		}
		#input {
			flex: 1;
			background: rgba(0,0,0,0.25);
			color: #d8d8f0;
			border: 1px solid rgba(0,229,255,0.3);
			border-radius: 8px;
			padding: 8px 10px;
			resize: none;
			font-family: inherit;
			font-size: 12.5px;
		}
		#input:focus {
			outline: none;
			border-color: var(--cy-cyan);
			box-shadow: 0 0 10px rgba(0,229,255,0.3);
		}
		#send {
			background: linear-gradient(120deg, #00e5ff, #ff00e0);
			color: #0a0a14;
			border: none;
			border-radius: 8px;
			width: 40px;
			display: flex;
			align-items: center;
			justify-content: center;
			cursor: pointer;
			transition: all 0.2s ease;
		}
		#send:hover:not(:disabled) {
			box-shadow: 0 0 12px rgba(255,0,224,0.7);
			transform: scale(1.05);
		}
		#send.stop { background: linear-gradient(120deg, #ff00e0, #ff4444); }
		#send:disabled { opacity: 0.4; cursor: not-allowed; }
	</style>
</head>
<body>
	<div id="header">
		<div id="header-left">NVIDIA Chat <span id="version-badge">v${this.version}</span></div>
		<div id="header-right">
			<button class="hbtn" id="attachBtn" title="Adjuntar selección del editor"></button>
			<button class="hbtn" id="modelsBtn" title="Proveedores y modelos"></button>
			<button class="hbtn" id="permsBtn" title="Permisos"></button>
			<button class="hbtn" id="folderBtn" title="Carpeta de salida"></button>
			<button class="hbtn" id="chatsBtn" title="Lista de chats"></button>
			<button class="hbtn" id="debugBtn" title="Consola de depuración"></button>
			<button class="hbtn" id="donateBtn" title="Donaciones"></button>
			<button class="hbtn" id="gearBtn" title="Configuración"></button>
		</div>
	</div>

	<div id="popup-layer">
		<div id="models-popup" class="popup">
			<p class="popup-title" id="title-models">Proveedor y modelo</p>
			<div id="prov-switches">
				<div class="prov-switch-row">
					<span class="switch-label">NVIDIA</span>
					<label class="switch">
						<input type="checkbox" id="provEnabledNvidia" checked>
						<span class="slider"></span>
					</label>
				</div>
				<div class="prov-switch-row">
					<span class="switch-label">OpenRouter</span>
					<label class="switch">
						<input type="checkbox" id="provEnabledOpenrouter" checked>
						<span class="slider"></span>
					</label>
				</div>
				<div class="prov-switch-row">
					<span class="switch-label">DeepSeek</span>
					<label class="switch">
						<input type="checkbox" id="provEnabledDeepseek" checked>
						<span class="slider"></span>
					</label>
				</div>
			</div>
			<div id="prov-tabs">
				<button class="prov-btn active" id="prov-nvidia" data-prov="nvidia">NVIDIA</button>
				<button class="prov-btn" id="prov-openrouter" data-prov="openrouter">OpenRouter</button>
				<button class="prov-btn" id="prov-deepseek" data-prov="deepseek">DeepSeek</button>
			</div>
			<div id="model-row">
				<span class="ico" id="icon-model"></span>
				<select id="model-select"><option>Cargando modelos...</option></select>
			</div>
		</div>
		<div id="perms-popup" class="popup">
			<p class="popup-title" id="title-perms">Permisos</p>
			<div id="auto-row">
				<span class="ico" id="icon-auto"></span>
				<label class="switch-label" id="label-auto">Auto aprobar (legacy)</label>
				<label class="switch" id="switch-auto">
					<input type="checkbox" id="autoApprove" title="Aprobar automáticamente escritura y ejecución de comandos">
					<span class="slider" id="slider-auto"></span>
				</label>
			</div>
			<div id="web-row">
				<span class="ico" id="icon-web"></span>
				<label class="switch-label" id="label-web">Buscar en internet</label>
				<label class="switch" id="switch-web">
					<input type="checkbox" id="webSearch" title="Permitir que el modelo busque información curada en internet">
					<span class="slider" id="slider-web"></span>
				</label>
			</div>
			<div id="cmd-row">
				<span class="ico" id="icon-cmd"></span>
				<label class="switch-label" id="label-cmd">Ejecutar comandos</label>
				<label class="switch" id="switch-cmd">
					<input type="checkbox" id="runCommand" title="Permitir ejecutar comandos en terminal (CMD/PowerShell)">
					<span class="slider" id="slider-cmd"></span>
				</label>
			</div>
			<div id="dl-row">
				<span class="ico" id="icon-dl"></span>
				<label class="switch-label" id="label-dl">Descargar archivos</label>
				<label class="switch" id="switch-dl">
					<input type="checkbox" id="downloadFile" title="Permitir descargar archivos desde internet">
					<span class="slider" id="slider-dl"></span>
				</label>
			</div>
			<div id="git-row">
				<span class="ico" id="icon-git"></span>
				<label class="switch-label" id="label-git">Git</label>
				<label class="switch" id="switch-git">
					<input type="checkbox" id="gitPerm" title="Permitir operaciones de Git (commit, push, etc.)">
					<span class="slider" id="slider-git"></span>
				</label>
			</div>
		</div>
		<div id="folder-popup" class="popup">
			<p class="popup-title" id="title-folder">Carpeta de salida</p>
			<div class="folder-info" id="folder-info">
				<span class="ico" id="icon-folder"></span>
				<span id="output-dir">Cargando carpeta...</span>
			</div>
			<button id="setDirBtn">Cambiar carpeta</button>
		</div>
		<div id="donate-popup" class="popup">
			<p class="popup-title" id="title-donate">Apoyá el proyecto</p>
			<img id="donate-anim" src="${donationGifUri}" alt="Donación">
			<p class="donate-text">Si te resulta útil esta extensión, podés invitarme un café 😊</p>
			<div class="donate-row">
				<span class="ico" id="icon-paypal"></span>
				<span id="paypal-email">martinoviedo@disroot.org</span>
			</div>
			<div class="donate-actions">
				<button id="donateCopyBtn" title="Copiar email de PayPal">Copiar email</button>
				<button id="donateOpenBtn" title="Abrir PayPal">Donar</button>
			</div>
			<button id="bmcBtn" title="Buy Me a Coffee">☕ Buy Me a Coffee</button>
		</div>
	</div>

	<div id="drawer-overlay"></div>
	<div id="drawer">
		<div id="drawer-head">
			<h3 id="drawer-title">Chats</h3>
			<button id="drawer-close" title="Cerrar"></button>
		</div>
		<div id="chat-list"></div>
		<div id="drawer-footer">
			<button id="newChatBtn"></button>
		</div>
	</div>

	<div id="context-chip">
		<span class="ico" id="icon-context"></span>
		<span id="context-label"></span>
		<button id="context-clear" title="Quitar contexto"></button>
	</div>

	<div id="chat"></div>
	<div id="input-row">
		<textarea id="input" rows="2" placeholder="Escribe un mensaje..."></textarea>
		<button id="send" title="Enviar"></button>
	</div>

	<script>
		const vscode = acquireVsCodeApi();
		let history = [];
		let streaming = false;
		let selectedModel = '';
		let currentProvider = 'nvidia';
		let activeChatId = '';
		let attachedContext = null;
		let gotFirstChunk = false;
		let savedModel = '';
		let inited = false;
		let msgCounter = 0;
		let nvidiaEnabled = true;
		let openrouterEnabled = true;
		let deepseekEnabled = true;

		const ICONS = {
			settings: '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>',
			box: '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></svg>',
			shield: '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/></svg>',
			folder: '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>',
			chats: '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
			paperclip: '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>',
			user: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
			bot: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/></svg>',
			send: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 7-7 7 7"/><path d="M12 19V5"/></svg>',
			stop: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="12" height="12" x="6" y="6" rx="1"/></svg>',
			cpu: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="16" height="16" x="4" y="4" rx="2"/><rect width="6" height="6" x="9" y="9" rx="1"/><path d="M15 2v2"/><path d="M15 20v2"/><path d="M2 15h2"/><path d="M2 9h2"/><path d="M20 15h2"/><path d="M20 9h2"/><path d="M9 2v2"/><path d="M9 20v2"/></svg>',
			zap: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/></svg>',
			globe: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>',
			copy: '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>',
			trash: '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>',
			refresh: '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M3 21v-5h5"/></svg>',
			download: '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>',
			plus: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg>',
			x: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>',
			terminal: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/></svg>',
			check: '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
			heart: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/></svg>',
			coffee: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2v2"/><path d="M14 2v2"/><path d="M16 8a1 1 0 0 1 1 1v8a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1h14a4 4 0 1 1 0 8h-1"/><path d="M6 2v2"/></svg>'
		};

		// Header icons
		document.getElementById('attachBtn').innerHTML = ICONS.paperclip;
		document.getElementById('modelsBtn').innerHTML = ICONS.box;
		document.getElementById('permsBtn').innerHTML = ICONS.shield;
		document.getElementById('folderBtn').innerHTML = ICONS.folder;
		document.getElementById('chatsBtn').innerHTML = ICONS.chats;
		document.getElementById('debugBtn').innerHTML = ICONS.terminal;
		document.getElementById('donateBtn').innerHTML = ICONS.heart;
		document.getElementById('gearBtn').innerHTML = ICONS.settings;
		document.getElementById('send').innerHTML = ICONS.send;
		document.getElementById('model-row').querySelector('.ico').innerHTML = ICONS.cpu;
		document.getElementById('auto-row').querySelector('.ico').innerHTML = ICONS.zap;
		document.getElementById('web-row').querySelector('.ico').innerHTML = ICONS.globe;
		document.getElementById('cmd-row').querySelector('.ico').innerHTML = ICONS.cpu;
		document.getElementById('dl-row').querySelector('.ico').innerHTML = ICONS.download;
		document.getElementById('git-row').querySelector('.ico').innerHTML = ICONS.box;
		document.getElementById('folder-popup').querySelector('.folder-info .ico').innerHTML = ICONS.folder;
		document.getElementById('donate-popup').querySelector('.donate-row .ico').innerHTML = ICONS.coffee;
		document.getElementById('context-chip').querySelector('.ico').innerHTML = ICONS.paperclip;
		document.getElementById('context-clear').innerHTML = ICONS.x;
		document.getElementById('drawer-close').innerHTML = ICONS.x;
		document.getElementById('newChatBtn').innerHTML = ICONS.plus + ' Nuevo chat';

		function escapeHtml(text) {
			const div = document.createElement('div');
			div.textContent = text;
			return div.innerHTML;
		}

		function enhanceCodeBlocks(container) {
			if (!container) return;
			container.querySelectorAll('pre').forEach((pre) => {
				if (pre.parentElement && pre.parentElement.classList.contains('code-block')) return;
				const wrapper = document.createElement('div');
				wrapper.className = 'code-block';
				pre.parentNode.insertBefore(wrapper, pre);
				wrapper.appendChild(pre);
				const btn = document.createElement('button');
				btn.className = 'code-copy-btn';
				btn.title = 'Copiar código';
				btn.innerHTML = ICONS.copy;
				btn.addEventListener('click', () => {
					const code = pre.querySelector('code');
					const text = code ? code.textContent : pre.textContent;
					vscode.postMessage({ command: 'copyText', text });
					btn.innerHTML = ICONS.check;
					setTimeout(() => { btn.innerHTML = ICONS.copy; }, 1500);
				});
				wrapper.appendChild(btn);
			});
		}

		function enhanceTables(container) {
			if (!container) return;
			container.querySelectorAll('table').forEach((table) => {
				if (table.parentElement && table.parentElement.classList.contains('table-wrapper')) return;
				const wrapper = document.createElement('div');
				wrapper.className = 'table-wrapper';
				table.parentNode.insertBefore(wrapper, table);
				wrapper.appendChild(table);
			});
		}

		function enhanceContent(container) {
			enhanceCodeBlocks(container);
			enhanceTables(container);
		}

		function mdRender(text) {
			let t = escapeHtml(text);
			const nl = String.fromCharCode(10);
			const triple = String.fromCharCode(96, 96, 96);
			t = t.split(triple).map(function(part, i) { return i % 2 === 1 ? '<pre><code>' + part + '</code></pre>' : part; }).join('');
			const single = String.fromCharCode(96);
			t = t.split(single).map(function(part, i) { return i % 2 === 1 ? '<code>' + part + '</code>' : part; }).join('');
			t = t.split('**').map(function(part, i) { return i % 2 === 1 ? '<b>' + part + '</b>' : part; }).join('');
			t = t.split(nl).join('<br>');
			return t;
		}

		function thinkingHtml(label) {
			return '<div class="thinking"><span class="think-label">' + (label || 'Trabajando') + '</span>' +
				'<span class="dot"></span><span class="dot"></span><span class="dot"></span></div>';
		}

		function addMessage(role, text, isHtml) {
			const chat = document.getElementById('chat');
			const row = document.createElement('div');
			row.className = 'msg-row ' + role;
			row.id = 'msg-' + (++msgCounter);

			const avatar = document.createElement('div');
			avatar.className = 'msg-avatar';
			avatar.id = 'msg-avatar-' + msgCounter;
			avatar.innerHTML = role === 'user' ? ICONS.user : ICONS.bot;

			const col = document.createElement('div');
			col.className = 'msg-col';
			col.id = 'msg-col-' + msgCounter;

			const bubble = document.createElement('div');
			bubble.className = 'msg-bubble';
			bubble.id = 'msg-bubble-' + msgCounter;
			const inner = document.createElement('div');
			inner.className = 'msg-inner';
			inner.id = 'msg-inner-' + msgCounter;
			if (isHtml) { inner.innerHTML = text; } else { inner.textContent = text; }
			if (isHtml) { enhanceContent(inner); }
			bubble.appendChild(inner);
			col.appendChild(bubble);

			if (text) {
				attachCopyAction(inner);
			}

			row.appendChild(avatar);
			row.appendChild(col);
			chat.appendChild(row);
			chat.scrollTop = chat.scrollHeight;
			return inner;
		}

		function attachCopyAction(inner) {
			const col = inner.closest('.msg-col');
			if (!col || col.querySelector('.msg-actions')) return;
			const actions = document.createElement('div');
			actions.className = 'msg-actions';
			const copyBtn = document.createElement('button');
			copyBtn.className = 'mbtn';
			copyBtn.title = 'Copiar';
			copyBtn.innerHTML = ICONS.copy;
			copyBtn.addEventListener('click', () => {
				vscode.postMessage({ command: 'copyText', text: inner.textContent });
			});
			actions.appendChild(copyBtn);
			col.appendChild(actions);
		}

		function clearChat() {
			document.getElementById('chat').innerHTML = '';
		}

		function renderHistory(list) {
			clearChat();
			for (const m of list) {
				if (m.role === 'user') {
					addMessage('user', escapeHtml(m.content), false);
				} else if (m.role === 'assistant') {
					addMessage('assistant', m.html || mdRender(m.content), true);
				}
			}
		}

		function refreshProviderUI() {
			const nvidiaTab = document.getElementById('prov-nvidia');
			const openrouterTab = document.getElementById('prov-openrouter');
			const deepseekTab = document.getElementById('prov-deepseek');
			if (nvidiaTab) { nvidiaTab.style.display = nvidiaEnabled ? '' : 'none'; }
			if (openrouterTab) { openrouterTab.style.display = openrouterEnabled ? '' : 'none'; }
			if (deepseekTab) { deepseekTab.style.display = deepseekEnabled ? '' : 'none'; }

			if (!nvidiaEnabled && !openrouterEnabled && !deepseekEnabled) {
				nvidiaEnabled = true;
				document.getElementById('provEnabledNvidia').checked = true;
				if (nvidiaTab) { nvidiaTab.style.display = ''; }
			}
			const enabledProviders = [];
			if (nvidiaEnabled) enabledProviders.push('nvidia');
			if (openrouterEnabled) enabledProviders.push('openrouter');
			if (deepseekEnabled) enabledProviders.push('deepseek');
			if (!enabledProviders.includes(currentProvider)) {
				currentProvider = enabledProviders[0] || 'nvidia';
				vscode.postMessage({ command: 'setProvider', value: currentProvider });
			}
			document.querySelectorAll('.prov-btn').forEach((b) => {
				if (b.dataset.prov === currentProvider) { b.classList.add('active'); }
				else { b.classList.remove('active'); }
			});
		}

		function loadModels() {
			refreshProviderUI();
			const select = document.getElementById('model-select');
			if (!select) return;
			select.innerHTML = '<option>Cargando modelos...</option>';
			vscode.postMessage({ command: 'getModels', provider: currentProvider });
		}

		function loadOutputDir() { vscode.postMessage({ command: 'getOutputDir' }); }
		function init() { vscode.postMessage({ command: 'init' }); }

		// Popup toggle
		function closeAllPopups() {
			document.querySelectorAll('.popup').forEach((p) => p.classList.remove('open'));
			document.querySelectorAll('.hbtn').forEach((b) => b.classList.remove('active'));
		}
		function togglePopup(name) {
			const popup = document.getElementById(name + '-popup');
			const btn = document.getElementById(name + 'Btn');
			const wasOpen = popup.classList.contains('open');
			closeAllPopups();
			if (!wasOpen) { popup.classList.add('open'); btn.classList.add('active'); }
		}

		document.getElementById('modelsBtn').addEventListener('click', () => togglePopup('models'));
		document.getElementById('permsBtn').addEventListener('click', () => togglePopup('perms'));
		document.getElementById('folderBtn').addEventListener('click', () => togglePopup('folder'));
		document.getElementById('debugBtn').addEventListener('click', () => {
			closeAllPopups();
			vscode.postMessage({ command: 'openDebugConsole' });
		});
		document.getElementById('donateBtn').addEventListener('click', () => {
			togglePopup('donate');
		});
		document.getElementById('donateCopyBtn').addEventListener('click', () => {
			vscode.postMessage({ command: 'copyText', text: 'martinoviedo@disroot.org' });
			const btn = document.getElementById('donateCopyBtn');
			btn.textContent = '¡Copiado!';
			setTimeout(() => { btn.textContent = 'Copiar email'; }, 1500);
		});
		document.getElementById('donateOpenBtn').addEventListener('click', () => {
			vscode.postMessage({ command: 'openExternal', url: 'https://www.paypal.com/donate/?business=martinoviedo%40disroot.org' });
		});
		document.getElementById('bmcBtn').addEventListener('click', () => {
			vscode.postMessage({ command: 'openExternal', url: 'https://www.buymeacoffee.com/martinalejandrooviedo' });
		});
		document.getElementById('gearBtn').addEventListener('click', () => {
			closeAllPopups();
			vscode.postMessage({ command: 'openSettings' });
		});

		// Drawer
		function openDrawer() {
			document.getElementById('drawer').classList.add('open');
			document.getElementById('drawer-overlay').classList.add('open');
		}
		function closeDrawer() {
			document.getElementById('drawer').classList.remove('open');
			document.getElementById('drawer-overlay').classList.remove('open');
		}
		document.getElementById('chatsBtn').addEventListener('click', () => {
			closeAllPopups();
			openDrawer();
		});
		document.getElementById('drawer-close').addEventListener('click', closeDrawer);
		document.getElementById('drawer-overlay').addEventListener('click', closeDrawer);
		document.getElementById('newChatBtn').addEventListener('click', () => {
			vscode.postMessage({ command: 'newChat' });
			closeDrawer();
		});

		// Attach context
		document.getElementById('attachBtn').addEventListener('click', () => {
			closeAllPopups();
			vscode.postMessage({ command: 'getContext' });
		});
		document.getElementById('context-clear').addEventListener('click', () => {
			attachedContext = null;
			document.getElementById('context-chip').classList.remove('show');
		});

		document.getElementById('setDirBtn').addEventListener('click', () => {
			vscode.postMessage({ command: 'setOutputDir' });
		});

		document.querySelectorAll('.prov-btn').forEach((btn) => {
			btn.addEventListener('click', () => {
				document.querySelectorAll('.prov-btn').forEach((b) => b.classList.remove('active'));
				btn.classList.add('active');
				currentProvider = btn.dataset.prov;
				vscode.postMessage({ command: 'setProvider', value: currentProvider });
				loadModels();
			});
		});

		document.getElementById('provEnabledNvidia').addEventListener('change', (e) => {
			nvidiaEnabled = e.target.checked;
			vscode.postMessage({ command: 'setProviderEnabled', provider: 'nvidia', value: nvidiaEnabled });
			loadModels();
		});

		document.getElementById('provEnabledOpenrouter').addEventListener('change', (e) => {
			openrouterEnabled = e.target.checked;
			vscode.postMessage({ command: 'setProviderEnabled', provider: 'openrouter', value: openrouterEnabled });
			loadModels();
		});

		document.getElementById('provEnabledDeepseek').addEventListener('change', (e) => {
			deepseekEnabled = e.target.checked;
			vscode.postMessage({ command: 'setProviderEnabled', provider: 'deepseek', value: deepseekEnabled });
			loadModels();
		});

		document.getElementById('model-select').addEventListener('change', (e) => {
			selectedModel = e.target.value;
			vscode.postMessage({ command: 'setModel', value: selectedModel });
		});

		document.getElementById('autoApprove')?.addEventListener('change', (e) => {
			vscode.postMessage({ command: 'setAutoApprove', value: e.target.checked });
		});

		document.getElementById('webSearch')?.addEventListener('change', (e) => {
			vscode.postMessage({ command: 'setWebSearch', value: e.target.checked });
		});

		document.getElementById('runCommand')?.addEventListener('change', (e) => {
			vscode.postMessage({ command: 'setRunCommand', value: e.target.checked });
		});

		document.getElementById('downloadFile')?.addEventListener('change', (e) => {
			vscode.postMessage({ command: 'setDownloadFile', value: e.target.checked });
		});

		document.getElementById('gitPerm')?.addEventListener('change', (e) => {
			vscode.postMessage({ command: 'setGit', value: e.target.checked });
		});

		function setStreaming(on) {
			streaming = on;
			const sendBtn = document.getElementById('send');
			if (on) {
				sendBtn.innerHTML = ICONS.stop;
				sendBtn.classList.add('stop');
				sendBtn.title = 'Detener';
			} else {
				sendBtn.innerHTML = ICONS.send;
				sendBtn.classList.remove('stop');
				sendBtn.title = 'Enviar';
			}
		}

		document.getElementById('send').addEventListener('click', () => {
			if (streaming) {
				vscode.postMessage({ command: 'stopGeneration' });
			} else {
				sendMessage();
			}
		});
		document.getElementById('input').addEventListener('keydown', (e) => {
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				sendMessage();
			}
		});

		function sendMessage() {
			const input = document.getElementById('input');
			const text = input.value.trim();
			if (!text || streaming) return;
			input.value = '';

			let finalText = text;
			if (attachedContext && attachedContext.text) {
				const nl = String.fromCharCode(10);
				const t = String.fromCharCode(96, 96, 96);
				finalText = '[Contexto: ' + attachedContext.label + ']' + nl +
					t + nl + attachedContext.text + nl + t + nl + nl + text;
			}

			history.push({ role: 'user', content: finalText });
			addMessage('user', escapeHtml(finalText));
			setStreaming(true);
			gotFirstChunk = false;
			const aiInner = addMessage('assistant', '', false);
			aiInner.innerHTML = thinkingHtml('Trabajando');
			window.__aiInner = aiInner;
			vscode.postMessage({
				command: 'send',
				history: history,
				model: selectedModel,
				provider: currentProvider,
				chatId: activeChatId,
			});
		}

		function renderChatList(chats, activeId) {
			const list = document.getElementById('chat-list');
			list.innerHTML = '';
			for (const c of chats) {
				const item = document.createElement('div');
				item.className = 'chat-item' + (c.id === activeId ? ' active' : '');
				item.id = 'chat-item-' + c.id;
				const title = document.createElement('span');
				title.className = 'chat-title';
				title.id = 'chat-title-' + c.id;
				title.textContent = c.title;
				const del = document.createElement('button');
				del.className = 'chat-del';
				del.id = 'chat-del-' + c.id;
				del.title = 'Eliminar';
				del.innerHTML = ICONS.trash;
				del.addEventListener('click', (e) => {
					e.stopPropagation();
					vscode.postMessage({ command: 'deleteChat', id: c.id });
				});
				item.appendChild(title);
				item.appendChild(del);
				item.addEventListener('click', () => {
					vscode.postMessage({ command: 'switchChat', id: c.id });
					closeDrawer();
				});
				list.appendChild(item);
			}
		}

		window.addEventListener('message', (event) => {
			const message = event.data;
			if (message.command === 'init') {
				activeChatId = message.activeId;
				history = message.history || [];
				renderChatList(message.chats, message.activeId);
				renderHistory(history);
				const s = message.settings || {};
				currentProvider = s.provider || 'nvidia';
				savedModel = s.model || '';
				nvidiaEnabled = s.nvidiaEnabled !== false;
				openrouterEnabled = s.openrouterEnabled !== false;
				deepseekEnabled = s.deepseekEnabled !== false;
				document.getElementById('provEnabledNvidia').checked = nvidiaEnabled;
				document.getElementById('provEnabledOpenrouter').checked = openrouterEnabled;
				document.getElementById('provEnabledDeepseek').checked = deepseekEnabled;
				document.querySelectorAll('.prov-btn').forEach((b) => {
					if (b.dataset.prov === currentProvider) { b.classList.add('active'); }
					else { b.classList.remove('active'); }
				});
				document.getElementById('autoApprove').checked = !!s.autoApprove;
				document.getElementById('webSearch').checked = !!s.webSearch;
				document.getElementById('runCommand').checked = !!s.runCommand;
				document.getElementById('downloadFile').checked = !!s.downloadFile;
				document.getElementById('gitPerm').checked = !!s.git;
				inited = true;
				loadModels();
			} else if (message.command === 'chats') {
				renderChatList(message.chats, message.activeId);
			} else if (message.command === 'chatOpened') {
				activeChatId = message.id;
				history = message.history || [];
				renderHistory(history);
			} else if (message.command === 'models') {
				const select = document.getElementById('model-select');
				select.innerHTML = '';
				for (const m of message.models) {
					const opt = document.createElement('option');
					opt.value = m;
					opt.textContent = m.split('/').pop();
					select.appendChild(opt);
				}
				if (savedModel && [...select.options].some((o) => o.value === savedModel)) {
					select.value = savedModel;
				}
				selectedModel = select.value;
			} else if (message.command === 'modelsError') {
				const select = document.getElementById('model-select');
				if (select) select.innerHTML = '<option>Error al cargar modelos</option>';
			} else if (message.command === 'context') {
				if (message.text) {
					attachedContext = { label: message.label, text: message.text };
					document.getElementById('context-label').textContent = message.label;
					document.getElementById('context-chip').classList.add('show');
				}
			} else if (message.command === 'streamChunk') {
				const inner = window.__aiInner;
				gotFirstChunk = true;
				inner.innerHTML = message.html;
				enhanceContent(inner);
				document.getElementById('chat').scrollTop = document.getElementById('chat').scrollHeight;
			} else if (message.command === 'streamStart') {
				const inner = window.__aiInner;
				inner.innerHTML = thinkingHtml('Trabajando');
			} else if (message.command === 'toolWorking') {
				const inner = window.__aiInner;
				if (inner && !gotFirstChunk) {
					inner.innerHTML = thinkingHtml('Trabajando: ' + message.name);
				}
			} else if (message.command === 'reasoning') {
				const inner = window.__aiInner;
				if (inner && !gotFirstChunk) {
					inner.innerHTML = thinkingHtml('Razonando');
				}
			} else if (message.command === 'streamEnd') {
				const inner = window.__aiInner;
				inner.innerHTML = message.html;
				enhanceContent(inner);
				attachCopyAction(inner);
				history.push({ role: 'assistant', content: message.text });
				setStreaming(false);
				document.getElementById('chat').scrollTop = document.getElementById('chat').scrollHeight;
			} else if (message.command === 'streamError') {
				const inner = window.__aiInner;
				inner.textContent = message.message;
				attachCopyAction(inner);
				setStreaming(false);
			} else if (message.command === 'outputDir') {
				document.getElementById('output-dir').textContent = message.dir;
			}
		});

		init();
		loadOutputDir();
	</script>
</body>
</html>`;
	}
}
