import { describe, expect, test } from "bun:test";
import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ConnectionMetadataDisclosure } from "@/features/workbench/explorer/components/ConnectionMetadataDisclosure";

const noop = () => undefined;

describe("ConnectionMetadataDisclosure", () => {
    test("renders only the compact summary while collapsed", () => {
        const markup = renderToStaticMarkup(createElement(
            ConnectionMetadataDisclosure,
            {
                open: false,
                onOpenChange: noop,
                tag: { tagLabel: "生产", tagColor: "violet" },
                onTagChange: noop,
                note: "仅用于月末报表\n请勿写入",
                onNoteChange: noop,
                disabled: false,
                noteInputRef: createRef<HTMLTextAreaElement>(),
            },
        ));

        expect(markup.includes(">外观与备注<")).toBe(true);
        expect(markup.includes("外观与备注（可选）")).toBe(false);
        expect(markup.includes("生产 · 仅用于月末报表 请勿写入")).toBe(true);
        expect(markup.includes("有备注")).toBe(false);
        expect(markup.includes("备注：")).toBe(false);
        expect(markup.includes('aria-expanded="false"')).toBe(true);
        expect(markup.includes("truncate whitespace-nowrap")).toBe(true);
        expect(markup.includes('id="conn-note"')).toBe(false);
        expect(markup.includes('id="conn-tag-label"')).toBe(false);
    });

    test("keeps the disclosure title and summary on one trigger row", () => {
        for (const open of [false, true]) {
            const markup = renderToStaticMarkup(createElement(
                ConnectionMetadataDisclosure,
                {
                    open,
                    onOpenChange: noop,
                    tag: { tagLabel: "生产", tagColor: "violet" },
                    onTagChange: noop,
                    note: "仅用于月末报表",
                    onNoteChange: noop,
                    disabled: false,
                    noteInputRef: createRef<HTMLTextAreaElement>(),
                },
            ));

            expect(markup.includes(
                '<span class="shrink-0 text-sm font-medium">外观与备注</span>',
            )).toBe(true);
            expect(markup.includes(
                'class="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-muted-foreground"',
            )).toBe(true);
            expect(markup.includes("mt-0.5")).toBe(false);
            expect(markup.includes("size-4 shrink-0")).toBe(true);
        }
    });

    test("renders an opaque section with a visible boundary after the driver form", () => {
        const markup = renderToStaticMarkup(createElement(
            ConnectionMetadataDisclosure,
            {
                open: false,
                onOpenChange: noop,
                tag: { tagLabel: "", tagColor: null },
                onTagChange: noop,
                note: "",
                onNoteChange: noop,
                disabled: false,
                noteInputRef: createRef<HTMLTextAreaElement>(),
            },
        ));

        expect(markup.includes("border-t pt-3")).toBe(true);
        expect(markup.includes("bg-card")).toBe(true);
        expect(markup.includes("bg-muted/20")).toBe(false);
    });

    test("renders tag and multiline note controls while expanded", () => {
        const markup = renderToStaticMarkup(createElement(
            ConnectionMetadataDisclosure,
            {
                open: true,
                onOpenChange: noop,
                tag: { tagLabel: "", tagColor: null },
                onTagChange: noop,
                note: "数据库🚀",
                onNoteChange: noop,
                disabled: true,
                noteInputRef: createRef<HTMLTextAreaElement>(),
            },
        ));

        expect(markup.includes('aria-expanded="true"')).toBe(true);
        expect(markup.includes('id="conn-tag-label"')).toBe(true);
        expect(markup.includes('id="conn-note"')).toBe(true);
        expect(markup.includes("4 / 50")).toBe(true);
        expect(markup.includes("支持多行纯文本，最多 50 个字符。")).toBe(true);
        expect(markup.includes("resize-y")).toBe(true);
    });
});
