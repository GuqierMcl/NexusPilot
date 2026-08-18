import { describe, expect, test } from "bun:test";

import { canRunSelectedAiRuntimeModel } from "../../src/features/workbench/agent/model/useSelectedAiRuntimeModel";

const SELECTED_MODEL = {
    providerId: "openai",
    providerName: "OpenAI",
    modelId: "gpt-test",
    modelName: "GPT Test",
};

describe("selected AI Runtime model availability", () => {
    test("keeps a cached available model runnable during background refresh", () => {
        expect(
            canRunSelectedAiRuntimeModel({
                selectedModel: SELECTED_MODEL,
                isAvailabilityKnown: true,
                isFetching: true,
                error: null,
            }),
        ).toBe(true);
    });

    test("blocks a missing or failed model fact", () => {
        expect(
            canRunSelectedAiRuntimeModel({
                selectedModel: null,
                isAvailabilityKnown: true,
                isFetching: false,
                error: null,
            }),
        ).toBe(false);
        expect(
            canRunSelectedAiRuntimeModel({
                selectedModel: SELECTED_MODEL,
                isAvailabilityKnown: true,
                isFetching: false,
                error: new Error("model catalog unavailable"),
            }),
        ).toBe(false);
    });
});
