import { defineConfig } from "vite";
import { resolve } from "path";

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
			"@": resolve(__dirname, "src"),
		},
	},
});