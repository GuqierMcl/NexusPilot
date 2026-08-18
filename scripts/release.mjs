#!/usr/bin/env bun

import { getHelpText } from "./release/help.mjs";
import {
  build,
  collect,
  doctor,
  finalize,
  prepare,
  publish,
} from "./release/commands.mjs";

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
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
