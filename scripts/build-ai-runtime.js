import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { toWindowsVersion } from "./windows-version.js";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const aiRuntimeDir = join(rootDir, "ai-runtime");
const binaryBaseName = "ai-runtime";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    ...options,
  });

  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function output(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(" ")}`);
  }

  return result.stdout;
}

function resolveTargetTriple() {
  if (process.env.TAURI_ENV_TARGET_TRIPLE) {
    return process.env.TAURI_ENV_TARGET_TRIPLE;
  }

  const rustcInfo = output("rustc", ["-vV"]);
  const hostLine = rustcInfo
    .split(/\r?\n/)
    .find((line) => line.startsWith("host: "));

  if (!hostLine) {
    throw new Error("Unable to resolve Rust host target triple from `rustc -vV`.");
  }

  return hostLine.replace("host: ", "").trim();
}

function readAiRuntimeVersion() {
  const packagePath = join(aiRuntimeDir, "package.json");
  const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));

  if (typeof packageJson.version !== "string") {
    throw new Error(`AI Runtime package version is missing: ${packagePath}`);
  }

  return packageJson.version;
}

const extension = process.platform === "win32" ? ".exe" : "";
const bunCommand = process.platform === "win32" ? "bun.exe" : "bun";
const targetTriple = resolveTargetTriple();
const distBinary = join(aiRuntimeDir, "dist", `${binaryBaseName}${extension}`);
const tauriBinariesDir = join(rootDir, "src-tauri", "binaries");
const tauriBinary = join(
  tauriBinariesDir,
  `${binaryBaseName}-${targetTriple}${extension}`,
);
const compileArgs = ["build", "src/main.ts", "--compile"];

if (process.platform === "win32") {
  const aiRuntimeVersion = readAiRuntimeVersion();

  compileArgs.push(
    "--windows-icon",
    join(rootDir, "src-tauri", "icons", "icon.ico"),
    "--windows-title",
    "NexusPilot AI Runtime",
    "--windows-publisher",
    "NIEEX AI",
    "--windows-version",
    toWindowsVersion(aiRuntimeVersion),
    "--windows-description",
    "NexusPilot AI Runtime Sidecar",
  );
}

compileArgs.push("--outfile", distBinary);

console.log(`Building Bun AI Runtime sidecar for ${targetTriple}...`);
run(bunCommand, compileArgs, { cwd: aiRuntimeDir });

if (!existsSync(distBinary)) {
  throw new Error(`Bun AI Runtime output not found: ${distBinary}`);
}

mkdirSync(tauriBinariesDir, { recursive: true });
copyFileSync(distBinary, tauriBinary);

console.log(`AI Runtime sidecar copied to ${tauriBinary}`);
