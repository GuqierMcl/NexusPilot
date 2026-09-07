import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
    createReferenceTypeRegistry,
    connectionReferenceHandler,
    referenceKey,
    validateTextReferences,
    validateReferenceMessage,
    projectReferencedText,
    type TextReferences,
} from "../shared/composer-references";

const target = {
    sourceId: "connections",
    type: "connection",
    version: 1,
    id: "db-1",
    label: "开发库",
    data: { driver: "postgres" },
};
const refs: TextReferences = {
    version: 1,
    targets: [target],
    occurrences: [
        { id: "r1", start: 3, end: 7, targetKey: referenceKey(target) },
    ],
};
describe("reference contract", () => {
    test("preserves whitespace and projects only validated context", () => {
        const text = "请看 @开发库";
        expect(validateTextReferences(text, refs)).toEqual(refs);
        expect(projectReferencedText({ text, references: refs })).toContain(
            '"profileId":"db-1"',
        );
    });
    test("rejects spoofed names, ranges, overlapping spans and unknown types", () => {
        expect(() => validateTextReferences("请看 @测试库", refs)).toThrow();
        expect(() =>
            validateTextReferences("请看 @开发库", {
                ...refs,
                occurrences: [
                    ...refs.occurrences,
                    { ...refs.occurrences[0], id: "r2" },
                ],
            }),
        ).toThrow();
        expect(() =>
            validateTextReferences("请看 @开发库", {
                ...refs,
                targets: [{ ...target, type: "unknown" }],
            }),
        ).toThrow();
        expect(() =>
            validateTextReferences("请看 @开发库", {
                ...refs,
                targets: [
                    {
                        ...target,
                        data: { driver: "postgres", password: "secret" },
                    },
                ],
            }),
        ).toThrow();
    });
    test("rejects duplicate handlers and combined-message limits", () => {
        expect(() =>
            createReferenceTypeRegistry([
                connectionReferenceHandler,
                connectionReferenceHandler,
            ]),
        ).toThrow();
        expect(() =>
            validateReferenceMessage(
                Array.from({ length: 33 }, () => ({
                    text: "请看 @开发库",
                    references: refs,
                })),
            ),
        ).toThrow();
    });
    test("enforces aggregate count, unique occurrence IDs, target count and UTF-8 byte budget", () => {
        const part = { text: "请看 @开发库", references: refs };
        expect(() => validateReferenceMessage([part, part])).toThrow("重复");
        expect(() =>
            validateReferenceMessage(
                Array.from({ length: 33 }, (_, i) => ({
                    ...part,
                    references: {
                        ...refs,
                        occurrences: [{ ...refs.occurrences[0]!, id: `r${i}` }],
                    },
                })),
            ),
        ).toThrow("32");
        expect(() =>
            validateTextReferences(part.text, {
                ...refs,
                targets: Array.from({ length: 17 }, (_, i) => ({
                    ...target,
                    id: `p${i}`,
                })),
            }),
        ).toThrow();
        const registry = createReferenceTypeRegistry([
            {
                type: "large",
                version: 1,
                dataSchema: z.object({ value: z.string() }).strict(),
                describe: (entry) => ({ value: entry.data.value }),
            },
        ]);
        const large = {
            ...target,
            type: "large",
            data: { value: "中".repeat(12000) },
        };
        expect(() =>
            validateTextReferences(
                part.text,
                {
                    ...refs,
                    targets: [large],
                    occurrences: [
                        {
                            ...refs.occurrences[0]!,
                            targetKey: referenceKey(large),
                        },
                    ],
                },
                registry,
            ),
        ).toThrow("32 KiB");
    });
    test("a new semantic type requires an explicit handler; generic projection calls it", () => {
        const custom = {
            ...target,
            type: "test-object",
            data: { name: "限定快照" },
        };
        const data = {
            ...refs,
            targets: [custom],
            occurrences: [
                { ...refs.occurrences[0]!, targetKey: referenceKey(custom) },
            ],
        };
        const part = { text: "请看 @开发库", references: data };
        expect(() => projectReferencedText(part)).toThrow("Unsupported");
        const registry = createReferenceTypeRegistry([
            {
                type: "test-object",
                version: 1,
                dataSchema: z.object({ name: z.string() }).strict(),
                describe: (entry) => ({
                    objectId: entry.id,
                    name: entry.data.name,
                }),
            },
        ]);
        expect(projectReferencedText(part, registry)).toContain(
            '"objectId":"db-1"',
        );
    });
});
