import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { computeNextVersion } from "./version-utils.js";

const pkgPath = resolve("package.json");
const bumpType = process.argv[2];
const preidFlagIndex = process.argv.indexOf("--preid");
const preid = preidFlagIndex >= 0 ? process.argv[preidFlagIndex + 1] : undefined;

if (!bumpType) {
  console.error(
    "Usage: bun scripts/bump-version.js <patch|minor|major|prerelease|prepatch|preminor|premajor> [--preid alpha|beta|rc]",
  );
  process.exit(1);
}

try {
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  pkg.version = computeNextVersion(pkg.version, bumpType, preid);
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log(`v${pkg.version}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
