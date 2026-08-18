const stableBumps = new Set(["patch", "minor", "major"]);
const prereleaseBumps = new Set(["prerelease", "prepatch", "preminor", "premajor"]);

function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+)\.(\d+))?$/.exec(version);

  if (!match) {
    throw new Error(`Unsupported package version format: ${version}`);
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prereleaseId: match[4],
    prereleaseNumber: match[5] === undefined ? undefined : Number(match[5]),
  };
}

function formatVersion(version) {
  const base = `${version.major}.${version.minor}.${version.patch}`;

  if (!version.prereleaseId) {
    return base;
  }

  return `${base}-${version.prereleaseId}.${version.prereleaseNumber ?? 0}`;
}

function bumpStable(version, type) {
  if (type === "patch") {
    if (version.prereleaseId) {
      return { major: version.major, minor: version.minor, patch: version.patch };
    }

    return { major: version.major, minor: version.minor, patch: version.patch + 1 };
  }

  if (type === "minor") {
    return { major: version.major, minor: version.minor + 1, patch: 0 };
  }

  return { major: version.major + 1, minor: 0, patch: 0 };
}

function bumpPrerelease(version, type, preid) {
  if (type === "prepatch") {
    return { major: version.major, minor: version.minor, patch: version.patch + 1, prereleaseId: preid, prereleaseNumber: 0 };
  }

  if (type === "preminor") {
    return { major: version.major, minor: version.minor + 1, patch: 0, prereleaseId: preid, prereleaseNumber: 0 };
  }

  if (type === "premajor") {
    return { major: version.major + 1, minor: 0, patch: 0, prereleaseId: preid, prereleaseNumber: 0 };
  }

  if (version.prereleaseId === preid && version.prereleaseNumber !== undefined) {
    return {
      major: version.major,
      minor: version.minor,
      patch: version.patch,
      prereleaseId: preid,
      prereleaseNumber: version.prereleaseNumber + 1,
    };
  }

  if (version.prereleaseId) {
    return {
      major: version.major,
      minor: version.minor,
      patch: version.patch,
      prereleaseId: preid,
      prereleaseNumber: 0,
    };
  }

  return {
    major: version.major,
    minor: version.minor,
    patch: version.patch + 1,
    prereleaseId: preid,
    prereleaseNumber: 0,
  };
}

export function computeNextVersion(version, bumpType, preid) {
  if (!stableBumps.has(bumpType) && !prereleaseBumps.has(bumpType)) {
    throw new Error(`Unsupported version bump type: ${bumpType}`);
  }

  if (prereleaseBumps.has(bumpType) && !preid) {
    throw new Error(`--preid is required for ${bumpType}`);
  }

  const parsed = parseVersion(version);
  const next = stableBumps.has(bumpType)
    ? bumpStable(parsed, bumpType)
    : bumpPrerelease(parsed, bumpType, preid);

  return formatVersion(next);
}
