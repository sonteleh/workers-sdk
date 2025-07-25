import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [
		react(),
		cloudflare({
			configPath: "./wrangler.static-routing.jsonc",
			inspectorPort: false,
			persistState: false,
		}),
	],
});
