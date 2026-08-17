import * as vscode from "vscode";
import { NvidiaProvider } from "./provider.js";
import { NvidiaViewProvider } from "./view.js";

export function activate(context: vscode.ExtensionContext) {
	const provider = new NvidiaProvider(context.secrets);

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
					"@ext:nvidia.nvidia-vscode-copilot",
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
	);

	// Sidebar view (icon in the right activity bar) with a full chat UI.
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(
			NvidiaViewProvider.viewType,
			new NvidiaViewProvider(provider, context.workspaceState),
		),
	);

	vscode.window.showInformationMessage(
		"NVIDIA Models extension activated.",
	);
}

export function deactivate() {}