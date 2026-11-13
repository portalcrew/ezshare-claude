import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
    root: "src/web",
    base: "/",
    plugins: [react(), tailwindcss()],
    build: { outDir: "../../dist/web", emptyOutDir: true, sourcemap: false, assetsInlineLimit: 0 },
    server: { host: "127.0.0.1", port: 4173 },
});
