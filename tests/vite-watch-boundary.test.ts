import { expect, test } from "bun:test";
import { join } from "node:path";
import { shouldIgnoreVitePath } from "../vite.config";

const root = process.cwd();

test("Vite watches frontend and contract inputs", () => {
  for (const relativePath of [
    "src/App.tsx",
    "contracts/ai-runtime/active-tab-context.ts",
    "public/favicon.svg",
    "index.html",
    "vite.config.ts",
    "tsconfig.json",
  ]) {
    expect(shouldIgnoreVitePath(join(root, relativePath))).toBe(false);
  }
});

test("Vite ignores backend, sidecar, site and generated trees", () => {
  for (const relativePath of [
    "ai-runtime/src/main.ts",
    "src-tauri/src/main.rs",
    "sites/docs/src/content.ts",
    "docs/architecture/overview.md",
    "scripts/build-ai-runtime.js",
    "dist/assets/index.js",
    "node_modules/vite/index.js",
    ".git/HEAD",
  ]) {
    expect(shouldIgnoreVitePath(join(root, relativePath))).toBe(true);
  }
});
