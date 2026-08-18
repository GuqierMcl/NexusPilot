import { describe, expect, test } from "bun:test";

const ASSISTANT_UI_SHARED_MODULES = [
    "@assistant-ui/core",
    "@assistant-ui/store",
] as const;

describe("assistant-ui dependency coherence", () => {
    test.each(ASSISTANT_UI_SHARED_MODULES)(
        "%s resolves to one shared module instance",
        (moduleName) => {
            const reactEntry = Bun.resolveSync(
                "@assistant-ui/react",
                import.meta.dir,
            );
            const aiSdkEntry = Bun.resolveSync(
                "@assistant-ui/react-ai-sdk",
                import.meta.dir,
            );

            expect(Bun.resolveSync(moduleName, reactEntry)).toBe(
                Bun.resolveSync(moduleName, aiSdkEntry),
            );
        },
    );
});
