import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/**
 * GitHub Pages cannot send response headers, so the built page carries its Content Security Policy itself.
 * `frame-ancestors` has no effect in a meta policy; `main.tsx` refuses to render inside a frame instead.
 * Only the build gets the policy: the dev server injects inline scripts.
 */
const CONTENT_SECURITY_POLICY = [
    "default-src 'none'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self'",
    "img-src 'self'",
    "connect-src https://api.github.com",
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
].join("; ");

const contentSecurityPolicy = (): Plugin => ({
    name: "ezshare-content-security-policy",
    apply: "build",
    transformIndexHtml: () => [
        {
            tag: "meta",
            attrs: { "http-equiv": "Content-Security-Policy", content: CONTENT_SECURITY_POLICY },
            injectTo: "head-prepend",
        },
    ],
});

export default defineConfig({
    root: "src/web",
    base: "/",
    plugins: [react(), tailwindcss(), contentSecurityPolicy()],
    build: { outDir: "../../dist/web", emptyOutDir: true, sourcemap: false, assetsInlineLimit: 0 },
    server: { host: "127.0.0.1", port: 4173 },
});
