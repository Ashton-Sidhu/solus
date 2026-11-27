import { describe, expect, test } from 'bun:test'
import {
  hostShortcutsOfferMessage,
  removalMessage,
  removeAllConfirmText,
  removedCountMessage,
  shortcutCommandLabel,
  shortcutCountText,
  trashName,
} from '@solus/workspace-ui/contexts/apps/app-shortcut-messages'
import { appGoneTitle, appUnavailableTitle } from '../../apps/desktop/src/renderer/shell/app-window-host'

// The text of the app shortcut commands (docs/app-shortcuts.md §5). What
// matters: a label never says a change is done while it runs, a removed
// launcher's text says where to get it back, and a launcher that stayed is
// never reported as gone.

describe('the shortcut command label', () => {
  test('the label says which change runs, and then the command that is next', () => {
    expect(shortcutCommandLabel(false, null)).toBe('Add app shortcut')
    expect(shortcutCommandLabel(true, null)).toBe('Remove app shortcut')
    expect(shortcutCommandLabel(false, 'adding')).toBe('Adding shortcut…')
    expect(shortcutCommandLabel(true, 'removing')).toBe('Removing shortcut…')
    expect(shortcutCommandLabel(true, 'updating')).toBe('Updating shortcut…')
  })
})

describe('where a removed launcher is', () => {
  test('each operating system names its own Trash, and Linux has none', () => {
    expect(trashName('mac')).toBe('Trash')
    expect(trashName('windows')).toBe('Recycle Bin')
    expect(trashName('linux')).toBeNull()
  })

  test('a launcher in the Trash says where to restore it from', () => {
    expect(removalMessage('Notes', { launcher: 'trashed' }, 'Recycle Bin').description).toBe('Its launcher is in the Recycle Bin. You can restore it from there.')
    expect(removalMessage('Notes', { launcher: 'removed' }, null)).toEqual({ message: 'The shortcut of Notes was removed from this computer.' })
  })

  // WHY: "removed" while the launcher is still in the folder is a lying label. The person must learn that it stays, and where.
  test('a launcher that the Trash refused is named as staying, with its path', () => {
    const text = removalMessage('Notes', { launcher: 'kept', launcherPath: '/Users/sam/Applications/Solus Apps/Notes.app' }, 'Trash')
    expect(text.message).toContain('its launcher stays')
    expect(text.description).toContain('/Users/sam/Applications/Solus Apps/Notes.app')
  })
})

describe('the removal of every shortcut', () => {
  // WHY: the person must know how much goes before it goes.
  test('the question names the count and where the launchers go', () => {
    expect(removeAllConfirmText(3, 'Trash')).toBe('Remove all 3 app shortcuts from this computer? The launchers go to the Trash. The apps stay on their hosts.')
    expect(removeAllConfirmText(1, null)).toBe('Remove the 1 app shortcut from this computer? Its launcher is deleted. The app stays on its host.')
  })

  test('the result names the launchers that stayed', () => {
    expect(removedCountMessage(3, 0, 'Trash')).toEqual({ message: '3 app shortcuts removed from this computer.', description: 'The launchers are in the Trash.' })
    expect(removedCountMessage(2, 1, 'Trash').description).toContain('could not move 1 launcher to the Trash')
  })

  test('the Settings row reads a failed list as an error, not as no shortcuts', () => {
    expect(shortcutCountText(0, null)).toBe('No app has a shortcut on this computer.')
    expect(shortcutCountText(2, null)).toBe('2 apps have a shortcut on this computer.')
    expect(shortcutCountText(0, 'The desktop app did not answer.')).toContain('could not read')
  })
})

describe('an app that cannot open', () => {
  test('the offer after a host removal names the host and the count', () => {
    expect(hostShortcutsOfferMessage('Studio Mac', 2).message).toBe('Studio Mac has 2 app shortcuts on this computer.')
  })

  test('the app window names the app it cannot open', () => {
    expect(appUnavailableTitle('Notes')).toBe('Notes is unavailable.')
    expect(appGoneTitle('Notes')).toBe('Notes is no longer available.')
    expect(appUnavailableTitle('')).toBe('This app is unavailable.')
  })
})
