import { describe, expect, test } from "bun:test";

import { releaseRegistry } from "../sites/product/src/shared/config/releases";
import { releaseIndexUrl } from "../sites/product/src/shared/release-registry/client";

describe("website release config", () => {
    test("keeps the public release index URL in the shared release config", () => {
        expect(releaseRegistry.indexUrl).toBe(
            "https://dl.nexuspilot.dev/releases/index.json",
        );
        expect(releaseIndexUrl).toBe(releaseRegistry.indexUrl);
    });
});
