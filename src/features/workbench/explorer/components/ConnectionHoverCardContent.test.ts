import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ConnectionHoverCardContent } from "@/features/workbench/explorer/components/ConnectionHoverCardContent";
import type { ConnectionHoverCardModel } from "@/features/workbench/explorer/connection-hover-card";

function render(model: ConnectionHoverCardModel): string {
    return renderToStaticMarkup(createElement(ConnectionHoverCardContent, { model }));
}

describe("ConnectionHoverCardContent", () => {
    test("renders connection identity, multiline note, and structured fields", () => {
        const markup = render({
            name: "订单生产库",
            driverName: "PostgreSQL",
            tag: {
                label: "生产",
                colorLabel: "紫色",
                markerClassName: "bg-violet-500",
            },
            note: "仅用于月末报表\n请勿写入",
            fields: [
                { label: "地址", value: "db.internal:5432" },
                { label: "默认数据库", value: "orders" },
                { label: "Schema", value: "reporting" },
            ],
        });

        expect(markup.includes("订单生产库")).toBe(true);
        expect(markup.includes("PostgreSQL")).toBe(true);
        expect(markup.includes("生产")).toBe(true);
        expect(markup.includes("bg-violet-500")).toBe(true);
        expect(markup.includes("连接标签颜色：紫色")).toBe(true);
        expect(markup.includes("备注")).toBe(true);
        expect(markup.includes("仅用于月末报表\n请勿写入")).toBe(true);
        expect(markup.includes("whitespace-pre-wrap")).toBe(true);
        expect(markup.includes("db.internal:5432")).toBe(true);
        expect(markup.includes("orders")).toBe(true);
        expect(markup.includes("reporting")).toBe(true);
    });

    test("omits the entire note section and optional tag when absent", () => {
        const markup = render({
            name: "本地数据库",
            driverName: "SQLite",
            tag: null,
            note: null,
            fields: [
                { label: "文件路径", value: "D:\\data\\local.db" },
                { label: "访问模式", value: "只读" },
            ],
        });

        expect(markup.includes("未填写备注")).toBe(false);
        expect(markup.includes(">备注<")).toBe(false);
        expect(markup.includes('data-slot="connection-hover-note"')).toBe(false);
        expect(markup.includes('data-slot="connection-hover-tag"')).toBe(false);
        expect(markup.includes("D:\\data\\local.db")).toBe(true);
        expect(markup.includes("只读")).toBe(true);
    });

    test("uses bounded wrapping styles and contains no controls", () => {
        const markup = render({
            name: "一个很长但必须完整展示的连接名称",
            driverName: "ClickHouse",
            tag: null,
            note: null,
            fields: [
                {
                    label: "地址",
                    value: "https://a-very-long-hostname.internal.example:8443",
                },
            ],
        });

        expect(markup.includes("min-w-0")).toBe(true);
        expect(markup.includes("break-words")).toBe(true);
        expect(markup.includes("[overflow-wrap:anywhere]")).toBe(true);
        expect(markup.includes("<button")).toBe(false);
        expect(markup.includes("<input")).toBe(false);
        expect(markup.includes("<a ")).toBe(false);
    });
});
