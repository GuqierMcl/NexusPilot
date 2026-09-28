import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

import { footerLinks } from "../sites/product/src/shared/config/navigation";
import { site } from "../sites/product/src/shared/config/site";

const privacyUrl = "https://nexuspilot.dev/privacy/";
const privacyPagePath = "sites/product/src/pages/privacy.astro";
const contactGuide = readFileSync("docs/guides/project/contact.md", "utf8");
const privacyPage = existsSync(privacyPagePath)
    ? readFileSync(privacyPagePath, "utf8")
    : "";

describe("website privacy policy", () => {
    test("publishes a linked static policy page with the required sections", () => {
        expect(site.privacyUrl).toBe(privacyUrl);
        expect(footerLinks).toContainEqual({
            label: "隐私政策",
            href: privacyUrl,
        });
        expect(contactGuide).toContain(privacyUrl);
        expect(privacyPage).not.toBe("");

        for (const heading of [
            "NexusPilot Privacy Policy",
            "Data We Process",
            "External AI Providers",
            "NexusPilot Cloud",
            "Your Choices",
            "Contact",
        ]) {
            expect(privacyPage).toContain(heading);
        }
    });
});
