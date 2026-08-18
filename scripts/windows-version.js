const MAX_WINDOWS_VERSION_COMPONENT = 65535;
const PRE_RELEASE_RANGE_SIZE = 16384;
const PRE_RELEASE_OFFSETS = {
  alpha: 0,
  beta: PRE_RELEASE_RANGE_SIZE,
  rc: PRE_RELEASE_RANGE_SIZE * 2,
};

function parseWindowsVersionComponent(value, label) {
  const component = Number(value);

  if (
    !Number.isSafeInteger(component) ||
    component < 0 ||
    component > MAX_WINDOWS_VERSION_COMPONENT
  ) {
    throw new Error(
      `Windows version ${label} must be an integer between 0 and ${MAX_WINDOWS_VERSION_COMPONENT}.`,
    );
  }

  return component;
}

/**
 * Converts the release workflow's SemVer shape into a four-part Windows PE
 * version while keeping alpha, beta, release-candidate, and stable builds
 * numerically ordered.
 */
export function toWindowsVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta|rc)\.(\d+))?$/.exec(
    version,
  );

  if (!match) {
    throw new Error(
      `Unsupported AI Runtime version for Windows metadata: ${version}. Expected X.Y.Z or X.Y.Z-(alpha|beta|rc).N.`,
    );
  }

  const major = parseWindowsVersionComponent(match[1], "major component");
  const minor = parseWindowsVersionComponent(match[2], "minor component");
  const patch = parseWindowsVersionComponent(match[3], "patch component");
  const prereleaseId = match[4];
  const prereleaseNumber = match[5];

  if (!prereleaseId) {
    return `${major}.${minor}.${patch}.${MAX_WINDOWS_VERSION_COMPONENT}`;
  }

  const prereleaseSequence = parseWindowsVersionComponent(
    prereleaseNumber,
    "pre-release sequence",
  );

  if (prereleaseSequence >= PRE_RELEASE_RANGE_SIZE) {
    throw new Error(
      `Windows ${prereleaseId} pre-release sequence must be below ${PRE_RELEASE_RANGE_SIZE}.`,
    );
  }

  return `${major}.${minor}.${patch}.${PRE_RELEASE_OFFSETS[prereleaseId] + prereleaseSequence}`;
}
