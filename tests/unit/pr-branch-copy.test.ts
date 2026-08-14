import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const readComponent = (path: string) =>
  readFileSync(join(import.meta.dir, '../../src/renderer/components', path), 'utf8')

describe('pull request branch copy controls', () => {
  test('copies the full branch from the list context menu', () => {
    // WHY: the branch action must not take permanent row space. A context menu
    // keeps the full ref available from wide, split, and inbox list rows.
    const page = readComponent('prs/PrsPage.svelte')
    expect(page).not.toContain('CopyButton')
    expect(page.match(/openPrContextMenu\(event, pr\)/g)).toHaveLength(3)

    const menu = readComponent('prs/PrContextMenu.svelte')
    expect(menu).toContain('Copy branch name')
    expect(menu).toContain('copy(pr.headRef ?? "", "Branch name")')
  })

  test('copies the head branch from both PR detail shapes', () => {
    // WHY: the PR can open as a full page or as a panel beside the list. The
    // same branch action must remain available in either layout.
    for (const component of [
      'pr-review/PrDetailMasthead.svelte',
      'pr-review/PrPanelHeader.svelte',
    ]) {
      const source = readComponent(component)
      expect(source).toContain(
        '<CopyButton text={headRef} title="Copy branch name" iconOnly />',
      )
    }
  })
})
