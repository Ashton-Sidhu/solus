import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { KeybindingsContext } from '@solus/workspace-ui/lib/keybindings/dispatcher.svelte'
import { isMac } from '@solus/workspace-ui/lib/keybindings/match'

// The dispatcher checks editable targets with HTMLElement. Bun has no DOM, and
// these focused tests use a null event target so only scope dispatch is tested.
const globals = globalThis as { HTMLElement?: unknown }
globals.HTMLElement ??= class {}

function keyEvent(code: string, modifiers: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    code,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
    repeat: false,
    target: null,
    preventDefault: () => {},
    ...modifiers,
  } as unknown as KeyboardEvent
}

function modKeyEvent(code: string): KeyboardEvent {
  return keyEvent(code, isMac ? { metaKey: true } : { ctrlKey: true })
}

describe('global shortcuts with a secondary document pane', () => {
  test('inline document shells do not make their scope exclusive', () => {
    // WHY: an inline plan or document can sit in a secondary pane. Treating it
    // as a modal blocks every global shortcut in the leading pane.
    const source = readFileSync(
      join(import.meta.dir, '../../packages/workspace-ui/src/components/document-shell/DocumentShell.svelte'),
      'utf8',
    )

    expect(source).toContain(
      'useScope(() => scope, { exclusive: !untrack(() => inline), pre: true })',
    )
    expect(source).toContain('import { tick, untrack } from "svelte";')
  })

  test('Settings reaches the global scope while a pane scope is active', () => {
    // WHY: opening a document beside a conversation must not disable Command+,.
    const keybindings = new KeybindingsContext()
    keybindings.pushScope('global')
    keybindings.pushScope('document-modal')
    let settingsOpened = 0
    keybindings.register('global.settings', () => { settingsOpened += 1 })

    keybindings.dispatch(modKeyEvent('Comma'))

    expect(settingsOpened).toBe(1)
  })

  test('the pane scope still wins when it owns the same shortcut', () => {
    // WHY: making an inline pane non-exclusive must not send Command+F to the
    // conversation when the document owns Find.
    const keybindings = new KeybindingsContext()
    keybindings.pushScope('global')
    keybindings.pushScope('document-modal')
    let documentFindOpened = 0
    let conversationFindOpened = 0
    keybindings.register('document-modal.find', () => { documentFindOpened += 1 })
    keybindings.register('conversation.find', () => { conversationFindOpened += 1 })

    keybindings.dispatch(modKeyEvent('KeyF'))

    expect([documentFindOpened, conversationFindOpened]).toEqual([1, 0])
  })

  test('all main pages clear a companion page before targeting the leading pane', () => {
    // WHY: page-group exclusivity replaces a page where it already lives. The
    // shared page path must honor the leading target for Settings, Tasks,
    // Workspace, Pull Requests, Insights, Automations, and future main pages.
    const source = readFileSync(
      join(import.meta.dir, '../../packages/workspace-ui/src/contexts/workspace/workspace.context.svelte.ts'),
      'utf8',
    )
    const showPage = source.slice(
      source.indexOf('  private showPage('),
      source.indexOf('  private togglePage('),
    )

    expect(showPage).toContain("ROUTES[pane.base.name].exclusiveGroup === 'page'")
    expect(showPage).toContain('target: NavTarget = this.router.leadingPane.id')
    expect(showPage).toContain("target !== 'focused' && existingPage.id !== target")
    expect(showPage).toContain("this.router.closeGroup('page')")
  })
})
