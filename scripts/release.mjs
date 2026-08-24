#!/usr/bin/env bun

import path from "node:path";
import { fileURLToPath } from "node:url";

import { getHelpText } from "./release/help.mjs";
import {
  build,
  collect,
  doctor,
  finalize,
  prepare,
  publish,
} from "./release/commands.mjs";
import { loadEnvFile, redactReleaseSecrets } from "./release/env.mjs";

const releaseEnvPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".env.release.local",
);

function loadReleaseRedactionEnv() {
  try {
    return { ...process.env, ...loadEnvFile(releaseEnvPath) };
  } catch {
    return process.env;
  }
}

const [command = "help", ...args] = process.argv.slice(2);

async function main() {
  if (command === "help" || command === "--help" || command === "-h") {
    console.log(getHelpText());
    return;
  }

  if (command === "doctor") {
    await doctor();
    return;
  }

  if (command === "prepare") {
    prepare(args);
    return;
  }

  if (command === "build") {
    build();
    return;
  }

  if (command === "collect") {
    collect();
    return;
  }

  if (command === "publish") {
    await publish(args);
    return;
  }

  if (command === "finalize") {
    finalize();
    return;
  }

  throw new Error(`未知发布命令：${command}。运行 \`bun run release help\` 查看可用命令。`);
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(redactReleaseSecrets(message, loadReleaseRedactionEnv()));
  process.exit(1);
}
