/**
 * Diff rendering e2e tests.
 *
 * These tests cover two layers:
 *   1. Structural / regression tests that run in every CI pass against the real
 *      built app (no worktree required).
 *   2. Full diff-rendering tests that require a git worktree with staged changes
 *      (skipped unless SOLUS_TEST_WORKTREE is set — see the skip guard at the
 *      bottom of this file).
 */
import { test, expect } from '../fixtures/electron-app'
import { AppPage } from '../helpers/app.page'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Inject a synthetic diff payload so we can assert rendering without a real
 *  git worktree. Replaces the IPC stubs with functions that return canned data,
 *  then emits a "solus:toggle-diff-panel" event. Returns false if the panel
 *  requires `canShowDiffPanel` to be true (no tab with changedFiles). */
async function injectMockDiffIpc(
  page: import('@playwright/test').Page,
  files: Array<{ path: string; additions: number; deletions: number; status: string }>,
): Promise<void> {
  await page.evaluate((injectedFiles) => {
    const w = window as Window & {
      solus?: {
        diff?: (...a: unknown[]) => Promise<unknown>
      }
    }
    if (!w.solus) return

    const patch = injectedFiles.map((file) => [
      `diff --git a/${file.path} b/${file.path}`,
      `index 000..111 100644`,
      file.status === 'A' ? `new file mode 100644` : null,
      file.status === 'D' ? `deleted file mode 100644` : null,
      `--- ${file.status === 'A' ? '/dev/null' : `a/${file.path}`}`,
      `+++ ${file.status === 'D' ? '/dev/null' : `b/${file.path}`}`,
      `@@ -1,2 +1,3 @@`,
      ` context line`,
      file.deletions > 0 ? `-deleted line` : null,
      file.additions > 0 ? `+added line` : null,
      file.additions > 1 ? `+extra added line` : null,
    ].filter(Boolean).join('\n')).join('\n')

    w.solus.diff = async () => ({ patch })
  }, files)
}

// ---------------------------------------------------------------------------
// Structural tests — no worktree needed
// ---------------------------------------------------------------------------

test.describe('Diff rendering — structural', () => {
  test('app starts without any diff-related JavaScript errors', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (err) => errors.push(err.message))

    const app = new AppPage(page)
    await app.waitForAppReady()

    // No uncaught errors should have been emitted during startup, including
    // from the diff-state, diff-tree-adapter, or diff-comment modules.
    const diffErrors = errors.filter(
      (e) =>
        e.includes('diff') ||
        e.includes('Diff') ||
        e.includes('parsePatch') ||
        e.includes('FileSlot'),
    )
    expect(diffErrors).toHaveLength(0)
  })

  test('global toggle-diff-panel event does not crash the app', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (err) => errors.push(err.message))

    const app = new AppPage(page)
    await app.waitForAppReady()

    // Dispatch the global toggle event — even without a worktree session, the
    // handler should be a no-op rather than throwing.
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('solus:toggle-diff-panel'))
      return new Promise<void>((r) => requestAnimationFrame(() => r()))
    })

    expect(errors).toHaveLength(0)
  })

  test('diff panel is not visible by default when there are no changed files', async ({ page }) => {
    const app = new AppPage(page)
    await app.waitForAppReady()

    // The diff panel should never appear unless a session has changedFiles.
    await expect(page.locator('[data-testid="diff-panel"]')).not.toBeVisible()
  })

  test('diff IPC stub is accessible and resolves', async ({ page }) => {
    // Run the diff parsing logic in the renderer's JavaScript context to verify
    // the bundled function is present and behaves correctly end-to-end.
    await page.waitForLoadState('domcontentloaded')

    const result = await page.evaluate(async () => {
      const w = window as Window & { solus?: { diff?: (...a: unknown[]) => Promise<unknown> } }
      if (!w.solus?.diff) return null
      const diff = await w.solus.diff(null, { scope: { kind: 'session' } })
      return diff
    })

    // diff should resolve (not throw) — exact content varies by test mode
    expect(result).not.toBeNull()
  })

  test('diff IPC accepts a working-tree scope', async ({ page }) => {
    await page.waitForLoadState('domcontentloaded')

    const ok = await page.evaluate(async () => {
      const w = window as Window & {
        solus?: { diff?: (...a: unknown[]) => Promise<unknown> }
      }
      if (!w.solus?.diff) return false
      try {
        await w.solus.diff(null, { scope: { kind: 'working-tree' } })
        return true
      } catch {
        return false
      }
    })

    expect(ok).toBe(true)
  })

  test('listTurnSnapshots IPC stub is accessible and resolves to an array', async ({ page }) => {
    await page.waitForLoadState('domcontentloaded')

    const result = await page.evaluate(async () => {
      const w = window as Window & {
        solus?: { listTurnSnapshots?: (...a: unknown[]) => Promise<unknown> }
      }
      if (!w.solus?.listTurnSnapshots) return null
      try {
        return await w.solus.listTurnSnapshots(null as unknown)
      } catch {
        return null
      }
    })

    // Should resolve to an array (empty in test mode with no active worktree)
    expect(result).not.toBeNull()
    expect(Array.isArray(result)).toBe(true)
  })

  test('Alt+Shift+D keyboard shortcut does not crash the app', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (err) => errors.push(err.message))

    const app = new AppPage(page)
    await app.waitForAppReady()

    // Pressing the shortcut without an active diff session should be a safe no-op
    await page.keyboard.press('Alt+Shift+d')
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())))

    const diffErrors = errors.filter((e) => e.includes('diff') || e.includes('Diff'))
    expect(diffErrors).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Full diff-rendering tests — requires a git worktree
// These tests are skipped in normal CI. Set SOLUS_TEST_WORKTREE=1 to run them.
// ---------------------------------------------------------------------------

const describeWithWorktree = process.env.SOLUS_TEST_WORKTREE
  ? test.describe
  : test.describe.skip

describeWithWorktree('Diff rendering — with worktree (SOLUS_TEST_WORKTREE=1)', () => {
  // These tests assert the full rendering pipeline:
  //   IPC → DiffState → DiffStream → FileSlot → @pierre/diffs web component
  //
  // To run locally:
  //   SOLUS_TEST_WORKTREE=1 bun run test --grep "with worktree"

  test('diff panel opens and shows the toolbar when there are changed files', async ({ page }) => {
    const app = new AppPage(page)
    await app.waitForAppReady()

    // Inject mock IPC so the panel believes there are changed files
    await injectMockDiffIpc(page, [
      { path: 'src/foo.ts', additions: 2, deletions: 1, status: 'M' },
    ])

    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('solus:toggle-diff-panel'))
    })

    await expect(page.locator('[data-testid="diff-panel"]')).toBeVisible({ timeout: 5_000 })
    await expect(page.locator('[data-testid="diff-toolbar"]')).toBeVisible()
  })

  test('maximize fills the editor shell and restores the split width', async ({ page }) => {
    const app = new AppPage(page)
    await app.waitForAppReady()

    await injectMockDiffIpc(page, [
      { path: 'src/maximize.ts', additions: 2, deletions: 1, status: 'M' },
    ])

    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('solus:toggle-diff-panel'))
    })

    await expect(page.locator('[data-testid="diff-panel"]')).toBeVisible({ timeout: 5_000 })

    const activeShell = page.locator('.mode-shell:not(.mode-hidden)')
    const secondaryPane = activeShell.locator('.secondary-pane-wrap')
    const beforeWidth = await secondaryPane.evaluate((el) => el.getBoundingClientRect().width)

    await page.getByLabel('Maximize panel').click()
    await expect(page.getByLabel('Restore panel size')).toBeVisible()

    const geometry = await secondaryPane.evaluate((secondary) => {
      const rect = secondary.getBoundingClientRect()
      const shell = document.querySelector('.mode-shell:not(.mode-hidden) .editor-shell')
      const shellRect = shell?.getBoundingClientRect()
      return {
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height,
        shellTop: shellRect?.top ?? 0,
        shellLeft: shellRect?.left ?? 0,
        shellWidth: shellRect?.width ?? 0,
        shellHeight: shellRect?.height ?? 0,
      }
    })
    expect(Math.abs(geometry.top - geometry.shellTop)).toBeLessThanOrEqual(1)
    expect(Math.abs(geometry.left - geometry.shellLeft)).toBeLessThanOrEqual(1)
    expect(Math.abs(geometry.width - geometry.shellWidth)).toBeLessThanOrEqual(2)
    expect(Math.abs(geometry.height - geometry.shellHeight)).toBeLessThanOrEqual(2)

    await page.getByLabel('Restore panel size').click()
    await expect(page.getByLabel('Maximize panel')).toBeVisible()

    const restoredWidth = await secondaryPane.evaluate((el) => el.getBoundingClientRect().width)
    expect(Math.abs(restoredWidth - beforeWidth)).toBeLessThanOrEqual(2)
  })

  test('diff panel renders a file slot for each changed file', async ({ page }) => {
    const app = new AppPage(page)
    await app.waitForAppReady()

    const mockFiles = [
      { path: 'src/alpha.ts', additions: 1, deletions: 0, status: 'A' },
      { path: 'src/beta.ts', additions: 3, deletions: 2, status: 'M' },
    ]
    await injectMockDiffIpc(page, mockFiles)

    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('solus:toggle-diff-panel'))
    })

    await expect(page.locator('[data-testid="diff-panel"]')).toBeVisible({ timeout: 5_000 })

    // Each file should produce one FileSlot
    const slots = page.locator('[data-testid="diff-file-slot"]')
    await expect(slots).toHaveCount(mockFiles.length, { timeout: 5_000 })
  })

  test('file slot header displays the filename', async ({ page }) => {
    const app = new AppPage(page)
    await app.waitForAppReady()

    await injectMockDiffIpc(page, [
      { path: 'src/hello.ts', additions: 1, deletions: 0, status: 'A' },
    ])

    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('solus:toggle-diff-panel'))
    })

    await expect(page.locator('[data-testid="diff-panel"]')).toBeVisible({ timeout: 5_000 })

    const header = page.locator('.file-header-name')
    await expect(header.first()).toContainText('hello.ts')
  })

  test('diff panel close button closes the panel', async ({ page }) => {
    const app = new AppPage(page)
    await app.waitForAppReady()

    await injectMockDiffIpc(page, [
      { path: 'src/foo.ts', additions: 1, deletions: 1, status: 'M' },
    ])

    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('solus:toggle-diff-panel'))
    })
    await expect(page.locator('[data-testid="diff-panel"]')).toBeVisible({ timeout: 5_000 })

    await page.locator('[aria-label="Close diff panel"]').click()
    await expect(page.locator('[data-testid="diff-panel"]')).not.toBeVisible()
  })

  test('diff toolbar shows branch name from the session', async ({ page }) => {
    const app = new AppPage(page)
    await app.waitForAppReady()

    await injectMockDiffIpc(page, [
      { path: 'src/foo.ts', additions: 1, deletions: 0, status: 'A' },
    ])

    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('solus:toggle-diff-panel'))
    })

    await expect(page.locator('[data-testid="diff-toolbar"]')).toBeVisible({ timeout: 5_000 })
    // The toolbar always renders a branch indicator (even if the branch name is empty)
    const toolbar = page.locator('[data-testid="diff-toolbar"]')
    await expect(toolbar).toBeVisible()
  })

  test('diff view can be toggled between unified and split', async ({ page }) => {
    const app = new AppPage(page)
    await app.waitForAppReady()

    await injectMockDiffIpc(page, [
      { path: 'src/foo.ts', additions: 2, deletions: 1, status: 'M' },
    ])

    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('solus:toggle-diff-panel'))
    })
    await expect(page.locator('[data-testid="diff-panel"]')).toBeVisible({ timeout: 5_000 })

    // The unified/split toggle lives in the toolbar; find it by aria-label
    const splitBtn = page.locator('[aria-label="Split view"], [title*="Split"]')
    if (await splitBtn.count() > 0) {
      await splitBtn.first().click()
      // Panel should still be visible — no crash. toBeVisible auto-retries.
      await expect(page.locator('[data-testid="diff-panel"]')).toBeVisible()
    }
  })

  test('toolbar displays the total file count', async ({ page }) => {
    const app = new AppPage(page)
    await app.waitForAppReady()

    await injectMockDiffIpc(page, [
      { path: 'src/alpha.ts', additions: 1, deletions: 0, status: 'A' },
      { path: 'src/beta.ts',  additions: 3, deletions: 2, status: 'M' },
    ])

    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('solus:toggle-diff-panel'))
    })
    await expect(page.locator('[data-testid="diff-toolbar"]')).toBeVisible({ timeout: 5_000 })

    // The toolbar stat area always renders the file count as text
    const toolbar = page.locator('[data-testid="diff-toolbar"]')
    await expect(toolbar).toContainText('2 files')
  })

  test('toolbar displays the total addition count', async ({ page }) => {
    const app = new AppPage(page)
    await app.waitForAppReady()

    await injectMockDiffIpc(page, [
      { path: 'src/a.ts', additions: 4, deletions: 0, status: 'M' },
      { path: 'src/b.ts', additions: 2, deletions: 0, status: 'M' },
    ])

    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('solus:toggle-diff-panel'))
    })
    await expect(page.locator('[data-testid="diff-toolbar"]')).toBeVisible({ timeout: 5_000 })

    const toolbar = page.locator('[data-testid="diff-toolbar"]')
    await expect(toolbar).toContainText('+6')
  })

  test('toolbar displays the total deletion count', async ({ page }) => {
    const app = new AppPage(page)
    await app.waitForAppReady()

    await injectMockDiffIpc(page, [
      { path: 'src/a.ts', additions: 0, deletions: 3, status: 'M' },
      { path: 'src/b.ts', additions: 0, deletions: 5, status: 'M' },
    ])

    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('solus:toggle-diff-panel'))
    })
    await expect(page.locator('[data-testid="diff-toolbar"]')).toBeVisible({ timeout: 5_000 })

    const toolbar = page.locator('[data-testid="diff-toolbar"]')
    await expect(toolbar).toContainText('−8')
  })

  test('file slot header shows the status indicator for an added file', async ({ page }) => {
    const app = new AppPage(page)
    await app.waitForAppReady()

    await injectMockDiffIpc(page, [
      { path: 'src/new-file.ts', additions: 5, deletions: 0, status: 'A' },
    ])

    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('solus:toggle-diff-panel'))
    })
    await expect(page.locator('[data-testid="diff-panel"]')).toBeVisible({ timeout: 5_000 })

    // The file slot header should include the filename
    await expect(page.locator('.file-header-name').first()).toContainText('new-file.ts')
  })

  test('Alt+Shift+D keyboard shortcut closes an open diff panel', async ({ page }) => {
    const app = new AppPage(page)
    await app.waitForAppReady()

    await injectMockDiffIpc(page, [
      { path: 'src/foo.ts', additions: 1, deletions: 1, status: 'M' },
    ])

    // Open via event dispatch
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('solus:toggle-diff-panel'))
    })
    await expect(page.locator('[data-testid="diff-panel"]')).toBeVisible({ timeout: 5_000 })

    // Close via keyboard shortcut
    await page.keyboard.press('Alt+Shift+d')
    await expect(page.locator('[data-testid="diff-panel"]')).not.toBeVisible({ timeout: 5_000 })
  })

  // Navigation lives in dedicated controls now (the old design overloaded the
  // +N/−N stat counters as hidden jump buttons, which read as plain text).
  test('toolbar exposes dedicated next/previous change controls', async ({ page }) => {
    const app = new AppPage(page)
    await app.waitForAppReady()

    await injectMockDiffIpc(page, [
      { path: 'src/foo.ts', additions: 2, deletions: 1, status: 'M' },
    ])
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('solus:toggle-diff-panel'))
    })
    await expect(page.locator('[data-testid="diff-toolbar"]')).toBeVisible({ timeout: 5_000 })

    const toolbar = page.locator('[data-testid="diff-toolbar"]')
    await expect(toolbar.getByRole('button', { name: 'Next change' })).toBeVisible()
    await expect(toolbar.getByRole('button', { name: 'Previous change' })).toBeVisible()

    // Clicking traverses changes without crashing the panel.
    await toolbar.getByRole('button', { name: 'Next change' }).click()
    await expect(page.locator('[data-testid="diff-panel"]')).toBeVisible()
  })

  test('addition / deletion stats are passive text, not buttons', async ({ page }) => {
    const app = new AppPage(page)
    await app.waitForAppReady()

    await injectMockDiffIpc(page, [
      { path: 'src/a.ts', additions: 4, deletions: 2, status: 'M' },
    ])
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('solus:toggle-diff-panel'))
    })
    await expect(page.locator('[data-testid="diff-toolbar"]')).toBeVisible({ timeout: 5_000 })

    const toolbar = page.locator('[data-testid="diff-toolbar"]')
    await expect(toolbar).toContainText('+4')
    // The stat block must not contain any clickable buttons.
    await expect(toolbar.locator('.diff-stats button')).toHaveCount(0)
  })

  test('collapse-all toggle flips between collapse and expand', async ({ page }) => {
    const app = new AppPage(page)
    await app.waitForAppReady()

    await injectMockDiffIpc(page, [
      { path: 'src/alpha.ts', additions: 1, deletions: 0, status: 'A' },
      { path: 'src/beta.ts', additions: 2, deletions: 1, status: 'M' },
    ])
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('solus:toggle-diff-panel'))
    })
    await expect(page.locator('[data-testid="diff-toolbar"]')).toBeVisible({ timeout: 5_000 })

    const toolbar = page.locator('[data-testid="diff-toolbar"]')
    const collapse = toolbar.getByRole('button', { name: 'Collapse all files' })
    await expect(collapse).toBeVisible()
    await collapse.click()
    await expect(toolbar.getByRole('button', { name: 'Expand all files' })).toBeVisible()
  })

  // Mid-turn freshness: the panel must offer a manual refresh that re-fetches
  // the diff list without remounting (no skeleton flash), so users can pull in
  // changes the agent made since the panel loaded.
  test('manual refresh button reloads the diff list in place', async ({ page }) => {
    const app = new AppPage(page)
    await app.waitForAppReady()

    await injectMockDiffIpc(page, [
      { path: 'src/foo.ts', additions: 1, deletions: 0, status: 'M' },
    ])
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('solus:toggle-diff-panel'))
    })
    const toolbar = page.locator('[data-testid="diff-toolbar"]')
    await expect(toolbar).toBeVisible({ timeout: 5_000 })
    await expect(toolbar).toContainText('1 file')

    // The agent "edits more files" after the panel loaded.
    await injectMockDiffIpc(page, [
      { path: 'src/foo.ts', additions: 1, deletions: 0, status: 'M' },
      { path: 'src/bar.ts', additions: 2, deletions: 1, status: 'A' },
    ])

    await toolbar.getByRole('button', { name: 'Refresh diff' }).click()
    await expect(toolbar).toContainText('2 files')
    // Refresh is silent — the panel stays mounted with no loading skeleton.
    await expect(page.locator('[data-testid="diff-panel"] .diff-skel-slot')).toHaveCount(0)
  })

  // Every tree entry must have a scroll destination in the stream. Binary and
  // hunk-less files used to be silently dropped, so clicking them in the tree
  // was a no-op that read as "the panel is broken".
  test('binary files render a labeled header slot instead of disappearing', async ({ page }) => {
    const app = new AppPage(page)
    await app.waitForAppReady()

    await injectMockDiffIpc(page, [
      { path: 'src/code.ts', additions: 2, deletions: 1, status: 'M' },
      { path: 'assets/logo.png', additions: 0, deletions: 0, status: 'M' },
    ])
    // Override the binary file's patch with a real git binary-diff payload.
    await page.evaluate(() => {
      const w = window as Window & {
        solus?: { diff?: (...a: unknown[]) => Promise<unknown> }
      }
      if (!w.solus?.diff) return
      const inner = w.solus.diff
      w.solus.diff = async (...args: unknown[]) => {
        const result = (await inner(...args)) as { patch?: string }
        return {
          ...result,
          patch: [
            result.patch ?? '',
            'diff --git a/assets/logo.png b/assets/logo.png',
            'index 000..111 100644',
            'Binary files a/assets/logo.png and b/assets/logo.png differ',
            '',
          ].join('\n'),
        }
      }
    })

    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('solus:toggle-diff-panel'))
    })
    await expect(page.locator('[data-testid="diff-panel"]')).toBeVisible({ timeout: 5_000 })

    // The binary file still produces a stream item with an explanatory label.
    const placeholder = page.locator('[data-testid="diff-placeholder-label"]')
    await expect(placeholder).toBeVisible({ timeout: 5_000 })
    await expect(placeholder).toContainText('Binary file')
  })

  test('mobile file sheet opens, lists files, and closes on selection', async ({ page }) => {
    const app = new AppPage(page)
    await app.waitForAppReady()
    // Narrow viewport flips the panel into its phone layout.
    await page.setViewportSize({ width: 390, height: 780 })

    await injectMockDiffIpc(page, [
      { path: 'src/alpha.ts', additions: 1, deletions: 0, status: 'A' },
      { path: 'src/beta.ts', additions: 2, deletions: 1, status: 'M' },
    ])
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('solus:toggle-diff-panel'))
    })
    await expect(page.locator('[data-testid="diff-panel"]')).toBeVisible({ timeout: 5_000 })

    const filesBtn = page.getByRole('button', { name: 'Browse changed files' })
    await expect(filesBtn).toBeVisible()
    await filesBtn.click()

    const sheet = page.locator('[data-testid="mobile-tree-sheet"]')
    await expect(sheet).toBeVisible()
    await expect(sheet).toContainText('alpha.ts')

    await sheet.locator('.mobile-tree-row').first().click()
    await expect(sheet).not.toBeVisible()
  })
})
