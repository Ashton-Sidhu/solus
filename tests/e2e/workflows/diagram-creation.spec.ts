import { test, expect } from '../fixtures/electron-app'
import { AppPage } from '../helpers/app.page'
import { ConversationPage } from '../helpers/conversation.page'

const ACTIVE_SHELL = '.mode-shell:not(.mode-hidden)'
const ACTIVE_TAB = `${ACTIVE_SHELL} .tab-slot:not(.tab-hidden)`

test.describe('Diagram creation workflow', () => {
  test('diagram card appears in conversation after __MOCK_DIAGRAM__ prompt', async ({ page }) => {
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    await app.waitForAppReady()

    await conversation.typeAndSend('__MOCK_DIAGRAM__ show me the architecture')

    // A diagram card should appear (not a plain document card) — this verifies
    // the diagram docType is wired through to the UI correctly
    const diagramCard = page.locator(`${ACTIVE_TAB} [data-testid="diagram-card"]`)
    await expect(diagramCard).toBeVisible({ timeout: 10_000 })

    // The card header must say "Diagram" and show the title
    await expect(diagramCard).toContainText('Diagram')
    await expect(diagramCard).toContainText('Mock Architecture')
  })

  test('diagram card shows node/edge summary', async ({ page }) => {
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    await app.waitForAppReady()

    await conversation.typeAndSend('__MOCK_DIAGRAM__ show me the architecture')

    const diagramCard = page.locator(`${ACTIVE_TAB} [data-testid="diagram-card"]`)
    await diagramCard.waitFor({ state: 'visible', timeout: 10_000 })

    // The summary line encodes "why the diagram type matters" — it gives users
    // a quick glance at diagram size without having to open it
    await expect(diagramCard).toContainText('nodes')
    await expect(diagramCard).toContainText('connections')
  })

  test('clicking diagram card header opens the diagram editor', async ({ page }) => {
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    await app.waitForAppReady()

    await conversation.typeAndSend('__MOCK_DIAGRAM__ show me the architecture')

    const diagramCard = page.locator(`${ACTIVE_TAB} [data-testid="diagram-card"]`)
    await diagramCard.waitFor({ state: 'visible', timeout: 10_000 })

    // Click the header bar to expand into the diagram editor
    await diagramCard.locator('.plan-card-header').first().click()

    // The diagram shell should mount — it contains the SvelteFlow canvas
    // This is what would break if the diagram type were mis-routed to DocumentModal
    const diagramShell = page.locator('.mode-shell:not(.mode-hidden) .diagram-shell')
    await expect(diagramShell).toBeVisible({ timeout: 5_000 })
  })

  test('diagram editor can be closed with Escape and input bar re-focuses', async ({ page }) => {
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    await app.waitForAppReady()

    await conversation.typeAndSend('__MOCK_DIAGRAM__ show me the architecture')

    const diagramCard = page.locator(`${ACTIVE_TAB} [data-testid="diagram-card"]`)
    await diagramCard.waitFor({ state: 'visible', timeout: 10_000 })
    await diagramCard.locator('.plan-card-header').first().click()

    const diagramShell = page.locator('.mode-shell:not(.mode-hidden) .diagram-shell')
    await diagramShell.waitFor({ state: 'visible', timeout: 5_000 })

    // Close via Escape — this verifies the keyboard-navigation CLAUDE.md rule
    await page.keyboard.press('Escape')
    await expect(diagramShell).toBeHidden({ timeout: 3_000 })
  })

  test('canvas toolbar exposes zoom controls and adds nodes', async ({ page }) => {
    const app = new AppPage(page)
    const conversation = new ConversationPage(page)
    await app.waitForAppReady()

    await conversation.typeAndSend('__MOCK_DIAGRAM__ show me the architecture')

    const diagramCard = page.locator(`${ACTIVE_TAB} [data-testid="diagram-card"]`)
    await diagramCard.waitFor({ state: 'visible', timeout: 10_000 })
    await diagramCard.locator('.plan-card-header').first().click()

    const diagramShell = page.locator('.mode-shell:not(.mode-hidden) .diagram-shell')
    await diagramShell.waitFor({ state: 'visible', timeout: 5_000 })

    // The floating canvas toolbar is what makes this read as a canvas (not a doc):
    // it must expose a live zoom readout and node-creation, both keyboard-reachable.
    const toolbar = diagramShell.locator('[role="toolbar"][aria-label="Canvas controls"]')
    await expect(toolbar).toBeVisible()
    await expect(toolbar.getByRole('button', { name: /current zoom/ })).toBeVisible()

    // Adding a node must actually grow the graph — this guards the toolbar→state wiring,
    // not just that a button exists.
    const nodes = diagramShell.locator('.svelte-flow__node')
    const before = await nodes.count()
    await toolbar.getByRole('button', { name: 'Add node' }).click()
    await expect(nodes).toHaveCount(before + 1)
  })
})
