const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || "playwright");
const { expect } = require((process.env.PLAYWRIGHT_MODULE_PATH || "playwright") + "/test");
const assert = require("node:assert/strict");

(async () => {
  const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || "msedge" });
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 800 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(process.env.COMPOSER_TEST_URL || "http://localhost:1431/tests/browser/composer/index.html");
    const input = page.getByRole("combobox", { name: "消息输入" });
    const preview = page.locator('[data-slot="composer-active-tab"]').last();
    const markers = page.locator('[data-role="user"] [data-slot="message-active-tab"]');
    const select = async (id) => page.evaluate((id) => {
      window.tabsStore.setState({ activeTabId: id });
    }, id);
    await page.evaluate(() => {
      const tabs = Array.from({ length: 100 }, (_, i) => ({ id: `tab-${i}`, title: `查询 ${i}`, type: "sql_editor", isDirty: false, isPinned: false,
        payload: { profileId: "p-1", tabRuntimeId: `runtime-${i}`, runtime: {}, initialContext: { database: "sales", schema: null }, sqlText: "NEVER_SEND_THIS_SQL" },
      }));
      window.tabsStore.setState({ tabs, activeTabId: "tab-0" });
    });
    await expect(preview).toHaveText("查询 0本条消息携带标签页信息，未包含页面内容");
    await expect(preview.getByText("当前标签页：")).toHaveCount(0);
    await input.fill("first");
    await input.press("Enter");
    await expect.poll(() => page.evaluate(() => window.requests.length)).toBe(1);
    await expect(markers).toHaveCount(1);
    const first = await page.evaluate(() => window.requests[0]);
    assert.equal(first.activeTabContext.tabId, "tab-0");
    assert.equal(first.activeTabContext.capabilities.content, false);
    assert.deepEqual(first.input.parts, [{ type: "text", text: "first" }]);
    assert(!JSON.stringify(first).includes("NEVER_SEND_THIS_SQL"));
    assert(!JSON.stringify(first).includes("查询 99"));
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.locator('[data-role="user"]').first().hover();
    await page.locator('[data-role="user"]').first().getByRole("button", { name: "复制", exact: true }).click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "first");
    await page.evaluate(() => window.tabsStore.setState(({ tabs }) => ({ tabs: tabs.map(tab => tab.id === "tab-0" ? { ...tab, payload: { ...tab.payload, initialContext: { database: "changed", schema: null } } } : tab) })));
    await expect(markers.first().locator('[data-slot="active-tab-chip"]')).toHaveAttribute("title", /状态已变化/);
    await select("tab-1");
    await expect(preview).toContainText("查询 1");
    await expect(markers.first()).toContainText("查询 0");
    await preview.getByRole("button").click();
    await select("tab-2");
    await expect(page.locator('[data-slot="composer-active-tab"]')).toHaveCount(0);
    await input.fill("omitted");
    await input.press("Enter");
    await expect.poll(() => page.evaluate(() => window.requests.length)).toBe(2);
    assert.equal(await page.evaluate(() => window.requests[1].activeTabContext), undefined);
    await expect(markers).toHaveCount(1);
    await expect(preview).toContainText("查询 2");
    // A complete manual clear starts a new draft. Switching tabs alone does not.
    await input.fill("draft");
    await preview.getByRole("button").click();
    await input.fill("");
    await expect(preview).toContainText("查询 2");
    // Native message content is a data part, and text-only copy sees only the text.
    assert.deepEqual(await page.evaluate(() => window.messages[0].content.map(p => p.type)), ["text", "data"]);
    await page.getByRole("button", { name: "切换渲染" }).click();
    await expect(markers).toHaveCount(1);
    await expect(preview).toContainText("查询 2");
    await page.locator('[data-role="user"]').first().hover();
    await page.getByRole("button", { name: "编辑", exact: true }).first().click();
    const edit = page.getByRole("combobox", { name: "编辑消息" });
    const editContext = page.locator('[data-slot="aui_edit-composer-wrapper"] [data-slot="composer-active-tab"]');
    await expect(editContext).toContainText("查询 0");
    await select("tab-3");
    await expect(editContext).toContainText("查询 0");
    await edit.fill("edited");
    await edit.press("Enter");
    await expect.poll(() => page.evaluate(() => window.requests.length)).toBe(3);
    assert.equal(await page.evaluate(() => window.requests[2].activeTabContext.tabId), "tab-0");
    // Failure recovery restores the submitted snapshot even after changing the active tab.
    await page.evaluate(() => { window.fail = true; });
    await input.fill("recover me");
    await input.press("Enter");
    await expect(page.getByRole("button", { name: "恢复未发送草稿" })).toBeVisible();
    await select("tab-4");
    await page.getByRole("button", { name: "恢复未发送草稿" }).click();
    await expect(input).toHaveValue("recover me");
    await expect(preview).toContainText("查询 3");
    await page.evaluate(() => { window.fail = false; });
    await input.fill("");
    await expect(preview).toContainText("查询 4");
    // Local and conversation commands do not submit a tab-bearing user message.
    const before = await page.evaluate(() => window.requests.length);
    await input.fill("/compact");
    await input.press("Enter");
    await input.press("Enter");
    await expect.poll(() => page.evaluate(() => window.compactions)).toBe(1);
    assert.equal(await page.evaluate(() => window.requests.length), before);
    await page.getByRole("button", { name: "取消压缩" }).click();
    await select(null);
    await expect(page.locator('[data-slot="composer-active-tab"]')).toHaveCount(0);
    // An upload can finish after the selected tab changes; submit still owns its original snapshot.
    await select("tab-5");
    await page.evaluate(async () => {
      window.holdAttachments = true;
      await window.aui.composer().addAttachment(new File(["file"], "context.txt", { type: "text/plain" }));
    });
    await input.fill("with file");
    await input.press("Enter");
    await expect.poll(() => page.evaluate(() => typeof window.finishAttachment)).toBe("function");
    await select("tab-6");
    await page.evaluate(() => { window.holdAttachments = false; window.finishAttachment(); });
    await expect.poll(() => page.evaluate(() => window.requests.length)).toBe(before + 1);
    const uploaded = await page.evaluate(() => window.requests.at(-1));
    assert.equal(uploaded.activeTabContext.tabId, "tab-5");
    assert.equal(uploaded.input.parts[1].type, "file");
    await expect(preview).toContainText("查询 6");
    // Removing automatic context preserves explicit references and short commands.
    await input.fill("@开发");
    await input.press("Enter");
    await preview.getByRole("button").click();
    await expect(page.locator('[data-slot="agent-composer-input"]').last().locator("mark")).toHaveCount(1);
    await input.press("End");
    await input.press("Shift+Enter");
    await input.pressSequentially("/explain");
    await input.press("Enter");
    await input.press("Enter");
    await expect.poll(() => page.evaluate(() => window.requests.length)).toBe(before + 2);
    const command = await page.evaluate(() => window.requests.at(-1));
    assert.equal(command.activeTabContext, undefined);
    assert.equal(command.input.parts[0].command.commandId, "explain");
    assert.equal(command.input.parts[0].references.targets.length, 1);
    await page.setViewportSize({ width: 420, height: 800 });
    await page.getByRole("button", { name: "主题", exact: true }).click();
    await expect(preview).toBeVisible();
    if (process.env.ACTIVE_TAB_SCREENSHOT) await page.screenshot({ path: process.env.ACTIVE_TAB_SCREENSHOT });
    assert.deepEqual(errors, []);
    console.log("Active tab browser checks passed: metadata-only, omission, reset, native copy, revision, history, virtualized, recovery, upload freezing, references, commands, compact, narrow dark UI.");
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
