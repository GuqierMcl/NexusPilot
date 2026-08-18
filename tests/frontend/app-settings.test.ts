import { describe, expect, test } from "bun:test";

import { DEFAULT_APP_SETTINGS } from "../../src/config/app-settings";

describe("app settings defaults", () => {
    test("uses Ask as the default Workbench agent mode preference", () => {
        expect(DEFAULT_APP_SETTINGS.ai.selectedAgentMode).toBe("ask");
    });
});
