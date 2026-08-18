import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

function stripInlineComment(value) {
  let quote;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];

    if ((char === "'" || char === '"') && !quote) {
      quote = char;
      continue;
    }

    if (char === quote) {
      quote = undefined;
      continue;
    }

    if (char === "#" && !quote && (index === 0 || /\s/.test(value[index - 1]))) {
      return value.slice(0, index).trimEnd();
    }
  }

  return value;
}

function unquote(value) {
  const trimmed = value.trim();
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];

  if ((first === "'" || first === '"') && first === last) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

function derivePrefix(publicBaseUrl) {
  try {
    const url = new URL(publicBaseUrl);
    const pathPrefix = url.pathname.replace(/^\/+|\/+$/g, "");
    return pathPrefix || "releases";
  } catch {
    return "releases";
  }
}

export function parseEnvContent(content) {
  const env = {};

  for (const rawLine of content.replace(/\r\n/g, "\n").split("\n")) {
    const line = rawLine.trim();

    if (!line || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");

    if (separatorIndex < 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = stripInlineComment(line.slice(separatorIndex + 1));
    env[key] = unquote(value);
  }

  return env;
}

export function loadEnvFile(filePath = ".env.release.local") {
  const resolvedPath = path.resolve(filePath);

  if (!existsSync(resolvedPath)) {
    return {};
  }

  return parseEnvContent(readFileSync(resolvedPath, "utf8"));
}

export function maskSecret(value) {
  if (!value) {
    return "";
  }

  if (value.length <= 6) {
    return "***";
  }

  return `${value.slice(0, 3)}***${value.slice(-3)}`;
}

export function hasReleaseConfigValue(value) {
  if (!value) {
    return false;
  }

  const normalized = value.trim().toLowerCase();

  if (normalized === "change-me" || normalized.includes("yourname")) {
    return false;
  }

  return true;
}

export function resolveReleaseConfig(env = {}) {
  const publicBaseUrl = (env.RELEASE_PUBLIC_BASE_URL ?? "").replace(/\/+$/g, "");

  return {
    outputDir: env.RELEASE_OUTPUT_DIR || "releases",
    publicBaseUrl,
    signing: {
      privateKey: env.TAURI_SIGNING_PRIVATE_KEY,
      privateKeyPassword: env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD,
    },
    s3: {
      endpoint: env.RELEASE_S3_ENDPOINT,
      region: env.RELEASE_S3_REGION || "us-east-1",
      bucket: env.RELEASE_S3_BUCKET,
      prefix: (env.RELEASE_S3_PREFIX || derivePrefix(publicBaseUrl)).replace(/^\/+|\/+$/g, ""),
      accessKeyId: env.RELEASE_S3_ACCESS_KEY_ID,
      secretAccessKey: env.RELEASE_S3_SECRET_ACCESS_KEY,
      forcePathStyle: env.RELEASE_S3_FORCE_PATH_STYLE
        ? env.RELEASE_S3_FORCE_PATH_STYLE.toLowerCase() === "true"
        : true,
    },
    updater: {
      platform: env.RELEASE_UPDATER_PLATFORM || "windows-x86_64",
      artifact: env.RELEASE_UPDATER_ARTIFACT || "nsis",
    },
  };
}

export function getMaskedConfigSummary(config) {
  const missing = (value) => (hasReleaseConfigValue(value) ? value : "<缺失>");

  return {
    outputDir: config.outputDir,
    publicBaseUrl: missing(config.publicBaseUrl),
    s3: {
      endpoint: missing(config.s3.endpoint),
      region: config.s3.region,
      bucket: missing(config.s3.bucket),
      prefix: config.s3.prefix,
      accessKeyId: hasReleaseConfigValue(config.s3.accessKeyId) ? maskSecret(config.s3.accessKeyId) : "<缺失>",
      secretAccessKey: hasReleaseConfigValue(config.s3.secretAccessKey) ? maskSecret(config.s3.secretAccessKey) : "<缺失>",
      forcePathStyle: config.s3.forcePathStyle,
    },
    updater: config.updater,
    signing: {
      privateKey: hasReleaseConfigValue(config.signing.privateKey) ? "<已配置>" : "<缺失>",
      privateKeyPassword: hasReleaseConfigValue(config.signing.privateKeyPassword) ? "<已配置>" : "<缺失>",
    },
  };
}
