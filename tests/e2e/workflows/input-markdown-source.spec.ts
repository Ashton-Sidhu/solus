import { test, expect } from "../fixtures/electron-app";
import { AppPage } from "../helpers/app.page";

const ACTIVE_SHELL = ".mode-shell:not(.mode-hidden)";
const INPUT_EDITOR = `${ACTIVE_SHELL} [data-testid="message-input"] .cm-content`;

async function clearInput(page: import("@playwright/test").Page) {
  const input = page.locator(INPUT_EDITOR);
  await input.click();
  await page.keyboard.press(
    process.platform === "darwin" ? "Meta+A" : "Control+A",
  );
  await page.keyboard.press("Backspace");
  return input;
}

test.describe("Source-first markdown input", () => {
  test("Shift+Enter continues a bullet list", async ({ page }) => {
    // WHY: source-first editing should keep CodeMirror's native markdown
    // niceties even though plain Enter belongs to the send action.
    const app = new AppPage(page);
    await app.waitForAppReady();
    const input = await clearInput(page);

    await page.keyboard.type("- first");
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type("second");

    expect(await input.evaluate((element) => element.innerText)).toBe(
      "- first\n- second",
    );
  });

  test("backspace removes one code-fence character, not a rich code block", async ({
    page,
  }) => {
    // WHY: code fences are prompt source, so editing their delimiter must be
    // ordinary character editing without an atomic rich-block edge case.
    const app = new AppPage(page);
    await app.waitForAppReady();
    const input = await clearInput(page);

    await page.keyboard.type("```js");
    await page.keyboard.press("Backspace");

    await expect(input).toHaveText("```j");
  });

  test("renders a file token as a chip and reveals its source on Backspace", async ({
    page,
  }) => {
    // WHY: chip rendering is visual sugar over durable markdown. Moving back
    // into a chip must expose the @path source so it remains directly editable.
    const app = new AppPage(page);
    await app.waitForAppReady();
    const input = await clearInput(page);

    await page.keyboard.type("@src/main/index.ts ");
    const chip = input.locator('[data-reference-kind="file"]');
    await expect(chip).toBeVisible();

    await page.keyboard.press("Backspace");

    await expect(chip).not.toBeVisible();
    await expect(input).toHaveText("@src/main/index.ts");
  });
});
