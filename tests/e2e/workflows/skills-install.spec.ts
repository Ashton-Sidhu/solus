import { test, expect } from '../fixtures/electron-app'
import { AppPage } from '../helpers/app.page'

/**
 * Settings → Skills lets users browse the skills.sh registry and opt in to
 * installing a skill across all active providers. In SOLUS_TEST_MODE the skills
 * handlers serve deterministic fixtures (see skills-handlers.ts) instead of
 * shelling out to `npx skills`, so these tests stay hermetic.
 *
 * Intent: the tab must (1) surface registry results for a query, (2) show an
 * empty state when nothing matches, and (3) install the skill the user picked —
 * the mock install only succeeds for a well-formed `owner/repo@skill` id, so the
 * "Installed" confirmation proves the UI passed the real registry id, not a
 * mangled one.
 */

// Both shells (pill + editor) stay mounted, so each Settings surface renders
// once per shell. Scope every locator to the visible shell to avoid matching
// the hidden duplicate. The full tabbed page only opens in editor mode.
const ACTIVE_SHELL = '.mode-shell:not(.mode-hidden)'

async function openSkillsTab(app: AppPage) {
  await app.switchToEditorMode()
  await app.page.keyboard.press('ControlOrMeta+Comma')
  const skillsTab = app.page.locator(ACTIVE_SHELL).getByRole('tab', { name: 'Skills' })
  await skillsTab.waitFor({ state: 'visible', timeout: 5_000 })
  await skillsTab.click()
}

test.describe('Skills install', () => {
  test('searches the registry and installs the selected skill across providers', async ({ page }) => {
    const app = new AppPage(page)
    await app.waitForAppReady()
    await openSkillsTab(app)

    const shell = page.locator(ACTIVE_SHELL)
    const search = shell.getByPlaceholder(/Search skills/)
    await expect(search).toBeVisible()
    await search.fill('react')

    // Only the react skill matches the query.
    const row = shell.getByTestId('skill-row')
    await expect(row).toHaveCount(1, { timeout: 5_000 })
    await expect(row).toContainText('mock-react-best-practices')

    // Installing succeeds (valid id) and flips the row to the "Installed" state.
    await shell.getByTestId('skill-install').click()
    await expect(shell.getByTestId('skill-installed')).toBeVisible({ timeout: 5_000 })
    await expect(shell.getByTestId('skill-install')).toHaveCount(0)
  })

  test('shows an empty state when the registry returns no matches', async ({ page }) => {
    const app = new AppPage(page)
    await app.waitForAppReady()
    await openSkillsTab(app)

    const shell = page.locator(ACTIVE_SHELL)
    await shell.getByPlaceholder(/Search skills/).fill('zzzznotarealskill')
    await expect(shell.getByText(/No skills found/)).toBeVisible({ timeout: 5_000 })
    await expect(shell.getByTestId('skill-row')).toHaveCount(0)
  })

  test('marks only the selected skill installed when results share a name', async ({ page }) => {
    const app = new AppPage(page)
    await app.waitForAppReady()
    await openSkillsTab(app)

    const shell = page.locator(ACTIVE_SHELL)
    await shell.getByPlaceholder(/Search skills/).fill('mock-testing')

    const rows = shell.getByTestId('skill-row')
    await expect(rows).toHaveCount(2, { timeout: 5_000 })
    await expect(rows.nth(0)).toContainText('mock-org/agent-skills')
    await expect(rows.nth(1)).toContainText('mock-org/other-skills')

    await rows.nth(0).getByTestId('skill-install').click()

    await expect(rows.nth(0).getByTestId('skill-installed')).toBeVisible({ timeout: 5_000 })
    await expect(rows.nth(1).getByTestId('skill-installed')).toHaveCount(0)
    await expect(rows.nth(1).getByTestId('skill-install')).toBeVisible()
  })
})
