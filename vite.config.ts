import * as path from "path";
import { fileURLToPath } from "url";
import { defineConfig } from "vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
	root: "./",
	build: {
		outDir: "dist",
		lib: {
			entry: "src/extension.ts",
			formats: ["es"],
			fileName: () => "extension.js",
		},
		rollupOptions: {
			external: ["vscode", "child_process", "util"],
		},
	},
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "src"),
		},
	},
});
