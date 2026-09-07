const { chromium } = require(
  process.env.PLAYWRIGHT_MODULE_PATH || "playwright",
);
const { expect } = require(
  (process.env.PLAYWRIGHT_MODULE_PATH || "playwright") + "/test",
);
const assert = require("node:assert/strict");
(async () => {
  const browser = await chromium.launch({
    headless: true,
    channel: process.env.BROWSER_CHANNEL || "msedge",
  });
  const page = await browser.newPage({
    viewport: { width: 1000, height: 800 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(
    process.env.COMPOSER_TEST_URL ||
      "http://localhost:1431/tests/browser/composer/index.html",
  );
  const input = page.getByRole("combobox", { name: "消息输入" });
  const composer = page.locator('[data-slot="agent-composer-input"]').last();
  const requests = () => page.evaluate(() => window.requests.length);
  await input.fill("@开发");
  await expect(page.getByRole("option")).toHaveCount(2);
  await input.press("ArrowDown");
  await input.press("Enter");
  await expect(input).toHaveValue("@开发库 ");
  assert.equal(await requests(), 0);
  await expect(composer.locator("mark")).toHaveCount(1);
  await input.press("Control+z");
  await expect(input).toHaveValue("@开发");
  await expect(composer.locator("mark")).toHaveCount(0);
  await input.press("Control+Shift+z");
  await expect(input).toHaveValue("@开发库 ");
  // A repeated target is deduplicated, and internal edits invalidate only one occurrence.
  await input.press("End");
  await input.pressSequentially("@");
  await expect(page.getByRole("option")).not.toHaveCount(0);
  await page.getByRole("option").filter({ hasText: "mysql" }).click();
  await expect(composer.locator("mark")).toHaveCount(2);
  await expect(composer.locator("summary")).toHaveCount(1);
  await input.evaluate((e) => {
    e.setSelectionRange(1, 2);
  });
  await input.press("X");
  await expect(composer.locator("mark")).toHaveCount(1);
  await input.press("Control+z");
  await expect(composer.locator("mark")).toHaveCount(2);
  // Commands preserve references and remain local.
  await input.press("End");
  await input.press("Shift+Enter");
  await input.pressSequentially("/help");
  await expect(page.getByRole("option")).toHaveCount(1);
  await input.press("Enter");
  await expect(page.getByText("输入帮助", { exact: true })).toBeVisible();
  assert.equal(await requests(), 0);
  await expect(composer.locator("mark")).toHaveCount(2);
  await input.pressSequentially("/explain");
  await expect(page.getByRole("option")).toHaveCount(1);
  await input.press("Enter");
  await expect(input).toHaveValue(/\/explain /);
  await expect(composer.locator("mark")).toHaveCount(3);
  await expect(composer).not.toContainText("请解释以下 SQL");
  assert.equal(await requests(), 0);
  // IME confirmation never selects/sends and native text remains visible during composition.
  await input.dispatchEvent("compositionstart", { data: "中" });
  await input.press("Enter");
  assert.equal(await requests(), 0);
  assert.notEqual(
    await input.evaluate((e) => getComputedStyle(e).color),
    "rgba(0, 0, 0, 0)",
  );
  await input.dispatchEvent("compositionend", { data: "中" });
  await input.press("Enter");
  await page.waitForFunction(() => window.requests.length === 1);
  await expect(input).toHaveValue("");
  let sent = await page.evaluate(() => window.requests[0]);
  assert.equal(sent.input.parts[0].references.targets[0].id, "profile-2");
  assert.equal(sent.input.parts[0].references.occurrences.length, 2);
  assert.equal(sent.input.parts[0].command.commandId, "explain");
  await expect(page.locator('[data-role="user"] mark')).toHaveCount(3);
  await expect(page.locator('[data-role="user"] details')).toHaveCount(0);
  await page.getByRole("button", { name: "切换渲染", exact: true }).click();
  await expect(page.locator('[data-role="user"] mark')).toHaveCount(3);
  await expect(page.locator('[data-role="user"] details')).toHaveCount(0);
  // History editing restores metadata; Escape dismisses menu before edit cancellation.
  await page.locator('[data-role="user"]').hover();
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  const edit = page.getByRole("combobox", { name: "编辑消息" });
  await expect(edit).toBeVisible();
  await expect(
    page.locator('[data-slot="aui_edit-composer-wrapper"] summary'),
  ).toHaveCount(1);
  await expect(
    page.locator('[data-slot="aui_edit-composer-wrapper"] mark'),
  ).toHaveCount(3);
  await edit.press("End");
  await edit.press("Shift+Enter");
  await edit.pressSequentially("/he");
  await page.getByRole("option").first().waitFor();
  await edit.press("Escape");
  await expect(edit).toBeVisible();
  await expect(page.getByRole("option")).toHaveCount(0);
  await edit.press("Control+z");
  await page
    .locator('[data-slot="aui_edit-composer-wrapper"]')
    .getByRole("button", { name: "发送", exact: true })
    .click();
  await page.waitForFunction(() => window.requests.length === 2);
  assert.ok(
    (await page.evaluate(() => window.requests[1])).replace_from_message_id,
  );
  // Deleted targets block form submit and retain the draft.
  await input.fill("@开发");
  await page.getByRole("option").first().waitFor();
  await input.press("Enter");
  await page.getByRole("button", { name: "切换删除", exact: true }).click();
  await page.getByRole("button", { name: "发送", exact: true }).click();
  assert.equal(await requests(), 2);
  await expect(input).toHaveValue("@开发库 ");
  await expect(composer.getByRole("alert")).toContainText("已删除");
  await page.getByRole("button", { name: "切换删除", exact: true }).click();
  // File attachment, HTTP rejection and recovery retain text, references and file identity.
  await page.evaluate(async () => {
    await window.aui
      .composer()
      .addAttachment(
        new File(["select 1"], "query.sql", { type: "text/plain" }),
      );
    window.fail = true;
  });
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await page.waitForFunction(() => window.requests.length === 3);
  await page.getByRole("button", { name: "恢复未发送草稿" }).click();
  await expect(input).toHaveValue("@开发库 ");
  await expect(composer.locator("mark")).toHaveCount(1);
  assert.equal(
    await page.evaluate(
      () => window.aui.composer().getState().attachments.length,
    ),
    1,
  );
  await page.evaluate(() => {
    window.fail = false;
  });
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await page.waitForFunction(() => window.requests.length === 4);
  sent = await page.evaluate(() => window.requests[3]);
  assert.equal(sent.input.parts.length, 2);
  assert.equal(sent.input.parts[1].attachment_id, "att_fixture");
  // Pending attachment send must not let later typing change the outgoing annotations.
  await input.fill("@开发");
  await page.getByRole("option").first().waitFor();
  await input.press("Enter");
  await page.evaluate(async () => {
    window.holdAttachments = true;
    await window.aui
      .composer()
      .addAttachment(new File(["x"], "later.sql", { type: "text/plain" }));
  });
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(input).toHaveValue("");
  await input.fill("下一条草稿");
  await page.evaluate(() => window.finishAttachment());
  await page.waitForFunction(() => window.requests.length === 5);
  assert.equal(
    (await page.evaluate(() => window.requests[4])).input.parts[0].references
      .targets[0].id,
    "profile-1",
  );
  await expect(input).toHaveValue("下一条草稿");
  // Long text, scroll, zoom and themes use identical textarea/mirror metrics.
  await input.fill(
    ("中文 😀 long words ".repeat(15) + "\n").repeat(12) + "@开发",
  );
  await page.getByRole("option").first().waitFor();
  await input.press("Enter");
  for (const zoom of [1, 1.25, 1.5]) {
    await page.evaluate((z) => (document.body.style.zoom = z), zoom);
    await input.evaluate((e) => {
      e.scrollTop = e.scrollHeight;
      e.dispatchEvent(new Event("scroll"));
    });
    const metrics = await input.evaluate((e) => {
      const m = e.previousElementSibling;
      const a = getComputedStyle(e),
        b = getComputedStyle(m);
      return [
        e.scrollTop,
        m.scrollTop,
        a.fontSize,
        b.fontSize,
        a.lineHeight,
        b.lineHeight,
        e.clientWidth,
        m.clientWidth,
      ];
    });
    assert.equal(metrics[0], metrics[1]);
    assert.equal(metrics[2], metrics[3]);
    assert.equal(metrics[4], metrics[5]);
    assert.equal(metrics[6], metrics[7]);
  }
  await page.getByRole("button", { name: "主题", exact: true }).click();
  if (process.env.COMPOSER_SCREENSHOT_DIR)
    await page.screenshot({
      path: require("node:path").join(
        process.env.COMPOSER_SCREENSHOT_DIR,
        "dark.png",
      ),
    });
  await page.evaluate(() => (document.body.style.zoom = "1"));
  await page.getByRole("button", { name: "主题", exact: true }).click();
  if (process.env.COMPOSER_SCREENSHOT_DIR)
    await page.screenshot({
      path: require("node:path").join(
        process.env.COMPOSER_SCREENSHOT_DIR,
        "light.png",
      ),
    });
  assert.equal(
    await composer
      .locator('[aria-hidden="true"]')
      .first()
      .getAttribute("aria-hidden"),
    "true",
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS keyboard, undo, duplicate refs, commands, IME events, both threads, edits, deletion, attachment rejection/recovery, scroll/zoom/theme metrics",
  );
  // No binding may leak from an identical new draft into a plain historical message.
  await page.reload();
  await input.fill("@开发库 ");
  await input.press("Escape");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await page.waitForFunction(() => window.requests.length === 1);
  await input.fill("@开发");
  await page.getByRole("option").first().waitFor();
  await input.press("Enter");
  await page.locator('[data-role="user"]').hover();
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  await expect(
    page.locator('[data-slot="aui_edit-composer-wrapper"] mark'),
  ).toHaveCount(0);
  await page
    .locator('[data-slot="aui_edit-composer-wrapper"]')
    .getByRole("button", { name: "取消", exact: true })
    .click();
  await expect(composer.locator("mark")).toHaveCount(1);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await input.press("Control+a");
  await input.press("Control+c");
  await input.fill("");
  await input.press("Control+v");
  await expect(input).toHaveValue("@开发库 ");
  await expect(composer.locator("mark")).toHaveCount(0);
  await expect(page.getByRole("option")).toHaveCount(0);
  console.log(
    "PASS pending-upload isolation, historical draft isolation and native plain-text clipboard",
  );
  // Restoring a rejected edit keeps the branch boundary only for that draft.
  for (const abandon of [false, true]) {
    await page.reload();
    await input.fill("原消息");
    await input.press("Enter");
    await page.waitForFunction(() => window.requests.length === 1);
    await page.evaluate(() => {
      window.fail = true;
    });
    await page.locator('[data-role="user"]').hover();
    await page.getByRole("button", { name: "编辑", exact: true }).click();
    await page.getByRole("combobox", { name: "编辑消息" }).fill("修改后的消息");
    await page
      .locator('[data-slot="aui_edit-composer-wrapper"]')
      .getByRole("button", { name: "发送", exact: true })
      .click();
    await page.waitForFunction(() => window.requests.length === 2);
    await page.getByRole("button", { name: "恢复未发送草稿" }).click();
    await expect(input).toHaveValue("修改后的消息");
    if (abandon) {
      await input.fill("");
      await input.fill("新的独立消息");
    }
    await page.evaluate(() => {
      window.fail = false;
    });
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await page.waitForFunction(() => window.requests.length === 3);
    assert.equal(
      !!(await page.evaluate(() => window.requests[2])).replace_from_message_id,
      !abandon,
    );
  }
  console.log(
    "PASS recovered edit boundaries and abandoning a recovered draft",
  );
  await page.reload();
  await input.fill("/compact");
  await page.getByRole("option").click();
  await expect(input).toHaveValue("/compact ");
  await expect(composer.locator("mark")).toHaveCount(1);
  assert.equal(await page.evaluate(() => window.compactions), 0);
  await input.pressSequentially("do not discard this");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(
    page.getByText("请单独发送此命令，不要混入正文、引用或附件"),
  ).toBeVisible();
  assert.equal(await page.evaluate(() => window.compactions), 0);
  await input.evaluate((element) =>
    element.setSelectionRange(9, element.value.length),
  );
  await input.press("Backspace");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(input).toHaveValue("");
  assert.equal(await page.evaluate(() => window.compactions), 1);
  assert.equal(await requests(), 0);
  await input.fill("压缩期间写下的新草稿");
  await expect(
    page.getByRole("button", { name: "发送", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "取消压缩", exact: true }).click();
  await expect(input).toHaveValue("压缩期间写下的新草稿");
  await expect(
    page.getByRole("button", { name: "发送", exact: true }),
  ).toBeEnabled();
  console.log(
    "PASS compact selection, mixed-content guard, separate operation, busy gate and cancellation draft retention",
  );
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
