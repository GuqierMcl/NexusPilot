export function updateCargoLockPackageVersion(cargoLock, packageName, version) {
  const packageBlocks = /^\[\[package\]\]\r?\n(?:(?!^\[\[package\]\]).*(?:\r?\n|$))*/gm;

  for (const match of cargoLock.matchAll(packageBlocks)) {
    const block = match[0];
    const name = /^name = "([^"]+)"$/m.exec(block)?.[1];
    if (name !== packageName) continue;

    const versionLine = /^version = "[^"]+"$/m;
    if (!versionLine.test(block)) {
      throw new Error(`Cargo.lock package "${packageName}" has no version`);
    }
    const updatedBlock = block.replace(versionLine, `version = "${version}"`);

    const start = match.index;
    return `${cargoLock.slice(0, start)}${updatedBlock}${cargoLock.slice(start + block.length)}`;
  }

  throw new Error(`Cargo.lock does not contain package "${packageName}"`);
}
