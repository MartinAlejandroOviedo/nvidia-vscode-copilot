import * as vscode from "vscode";
import { NvidiaProvider } from "./provider.js";
import { NvidiaViewProvider } from "./view.js";

export function activate(context: vscode.ExtensionContext) {
	const output = vscode.window.createOutputChannel("NVIDIA Chat Debug");
	const provider = new NvidiaProvider(context.secrets, output);

	// Register the language model chat provider so NVIDIA models appear
	// in the VS Code Chat model picker.
	try {
		context.subscriptions.push(
			vscode.lm.registerLanguageModelChatProvider(
				"nvidia.nvidia",
				provider,
			),
		);
	} catch (err) {
		vscode.window.showErrorMessage(
			`Failed to register NVIDIA chat provider: ${err}`,
		);
	}

	// Commands.
	context.subscriptions.push(
		vscode.commands.registerCommand("nvidia.openSettings", async () => {
			try {
				await vscode.commands.executeCommand(
					"workbench.action.openSettings",
					"@ext:MartinAlejandroOviedo.nvidia-vscode-copilot",
				);
			} catch {
				await vscode.commands.executeCommand("workbench.action.openSettings");
			}
		}),
		vscode.commands.registerCommand("nvidia.setOutputDirectory", async () => {
			const current = vscode.workspace
				.getConfiguration("nvidia")
				.get<string>("outputDirectory");
			const result = await vscode.window.showInputBox({
				prompt: "Carpeta donde el modelo guardará los archivos (relativa al workspace). Deja vacío para usar la raíz.",
				value: current ?? "",
				ignoreFocusOut: true,
			});
			if (result !== undefined) {
				// Workspace scope: each project keeps its own folder.
				await vscode.workspace
					.getConfiguration("nvidia")
					.update("outputDirectory", result, vscode.ConfigurationTarget.Workspace);
				vscode.window.showInformationMessage(
					result.trim() === ""
						? "Carpeta de salida: raíz del workspace."
						: `Carpeta de salida configurada: ${result}`,
				);
			}
		}),
		vscode.commands.registerCommand("nvidia.openDebugConsole", async () => {
			output.show(true);
		}),
	);

	// Sidebar view (icon in the activity bar) with a full chat UI.
	const version = context.extension.packageJSON.version ?? "0.0.0";
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(
			NvidiaViewProvider.viewType,
			new NvidiaViewProvider(provider, context.workspaceState, version, context.extensionUri),
		),
	);
}

export function deactivate() {}