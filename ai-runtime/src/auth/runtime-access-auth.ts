import { timingSafeEqual } from "node:crypto";
import { error } from "../core/response";

const PROTECTED_PATH_PREFIX = "/v1";

export interface RuntimeAccessAuth {
  readonly enabled: boolean;
  authorizeRequest(request: Request): boolean;
}

export function createRuntimeAccessAuth(accessToken: string | null): RuntimeAccessAuth {
  return {
    enabled: accessToken !== null,
    authorizeRequest(request: Request): boolean {
      if (accessToken === null || request.method === "OPTIONS") {
        return true;
      }

      return matchesBearerToken(request.headers.get("authorization"), accessToken);
    },
  };
}

export function isProtectedRuntimePath(pathname: string): boolean {
  return pathname === PROTECTED_PATH_PREFIX || pathname.startsWith(`${PROTECTED_PATH_PREFIX}/`);
}

export function unauthorizedRuntimeResponse(): Response {
  return Response.json(error("unauthorized", "Unauthorized"), { status: 401 });
}

function matchesBearerToken(authorization: string | null, expectedToken: string): boolean {
  if (authorization === null) {
    return false;
  }

  const match = /^Bearer ([^\s]+)$/i.exec(authorization);
  if (!match) {
    return false;
  }

  const actual = Buffer.from(match[1], "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
