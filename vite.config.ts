import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path"
import tailwindcss from "@tailwindcss/vite"
import svgr from 'vite-plugin-svgr';

const host = process.env.TAURI_DEV_HOST;
const frontendWatchRoots = [
  path.resolve(__dirname, "src"),
  path.resolve(__dirname, "contracts/ai-runtime"),
  path.resolve(__dirname, "public"),
];
const frontendWatchFiles = [
  path.resolve(__dirname, "index.html"),
  path.resolve(__dirname, "vite.config.ts"),
  path.resolve(__dirname, "tsconfig.json"),
  path.resolve(__dirname, "tsconfig.node.json"),
];

function isWithinOrEqual(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isParentOrEqual(candidate: string, child: string): boolean {
  const relative = path.relative(candidate, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function shouldIgnoreVitePath(filePath: string): boolean {
  const normalized = path.resolve(filePath);
  const watchedFile = frontendWatchFiles.some((file) => normalized === file);
  const watchedRoot = frontendWatchRoots.some((root) => isWithinOrEqual(normalized, root));
  const traversalParent = frontendWatchRoots.some((root) => isParentOrEqual(normalized, root));
  return !(watchedFile || watchedRoot || traversalParent);
}

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss(), svgr()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@contracts": path.resolve(__dirname, "./contracts/ai-runtime"),
    },
  },
  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  optimizeDeps: {
    // Vite's default dependency scanner crawls every HTML file under the
    // project root. Keep generated Rust/PyInstaller HTML out of dep-scan.
    entries: ["index.html"],
  },
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. watch only frontend inputs and the AI Runtime contract source.
      // The parent directories of allowed roots remain traversable; every
      // other repository path is ignored before chokidar descends into it.
      ignored: shouldIgnoreVitePath,
    },
  },
}));

export { shouldIgnoreVitePath };
