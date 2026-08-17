import { describe, expect, test } from 'bun:test'

import { EDITOR_APPS } from '../../src/main/editor-apps'
import { TERMINAL_APPS } from '../../src/main/terminal-apps'
import { APP_LOGOS } from '../../src/renderer/components/settings/lib/app-logos'
import { normalizeHostCapabilities } from '../../src/client-core/host-capabilities'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { EDITOR_IDS, TERMINAL_APP_IDS } from '../../src/shared/types'

describe('terminal catalog', () => {
  test('every terminal can be told to run a command on launch', () => {
    // WHY: the fallback has to come up already attached to the shared tmux
    // session. A terminal that ignores a startup command would open a plain
    // shell and silently strand the user away from their agent.
    for (const app of TERMINAL_APPS) {
      const macLaunchable = Boolean(app.macAppleScript) || Boolean(app.macOpenArgs && app.macAppBundle)
      expect({ id: app.id, macLaunchable }).toEqual({ id: app.id, macLaunchable: true })
      expect(app.linuxArgs('run me').join(' ')).toContain('run me')
    }
  })

  test('ids are unique across editors and terminals', () => {
    // WHY: one logo map is keyed by both, so a collision would show the wrong brand.
    const ids = [...EDITOR_APPS.map((app) => app.id), ...TERMINAL_APPS.map((app) => app.id)]
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('editor catalog', () => {
  test('GUI editors name a bundle so they are found without their shell command', () => {
    // WHY: most GUI editors ship their `code`-style command as an opt-in step.
    // Probing only the command is what hid installed apps from Settings.
    for (const app of EDITOR_APPS.filter((app) => !app.isTerminal)) {
      expect({ id: app.id, hasBundle: Boolean(app.macAppBundle) }).toEqual({ id: app.id, hasBundle: true })
    }
  })

  test('terminal editors have no bundle, because they are commands not apps', () => {
    for (const app of EDITOR_APPS.filter((app) => app.isTerminal)) {
      expect({ id: app.id, hasBundle: Boolean(app.macAppBundle) }).toEqual({ id: app.id, hasBundle: false })
    }
  })
})

describe('app logos', () => {
  test('only name apps that exist in a catalog', () => {
    // WHY: a stale key renders no logo and gives no error; the generic fallback
    // looks deliberate, so the mistake would survive review.
    const known = new Set([...EDITOR_APPS.map((app) => app.id), ...TERMINAL_APPS.map((app) => app.id)])
    for (const id of APP_LOGOS.keys()) expect(known).toContain(id)
  })
})

describe('editor and terminal ids', () => {
  test('every id has a catalog entry, and every entry an id', () => {
    expect(EDITOR_APPS.map((app) => app.id).sort()).toEqual([...EDITOR_IDS].sort())
    expect(TERMINAL_APPS.map((app) => app.id).sort()).toEqual([...TERMINAL_APP_IDS].sort())
  })

  test('the client keeps every editor id a host can advertise', () => {
    // WHY: this is the bug that shipped. A second hand-written copy of the id
    // list validated the host's capability advertisement and silently dropped
    // every id it had not heard of, so newly added editors reached the host and
    // never the Settings dropdown — with no error anywhere.
    const normalized = normalizeHostCapabilities({ editors: [...EDITOR_IDS] })

    expect(normalized.editors).toEqual([...EDITOR_IDS])
  })

  test('still drops an id from a newer host rather than blanking the record', () => {
    const normalized = normalizeHostCapabilities({ editors: ['vscode', 'editor-from-the-future'] })

    expect(normalized.editors).toEqual(['vscode'])
  })
})

describe('committed app icons', () => {
  const ICON_DIRECTORY = join(import.meta.dirname, '../../src/renderer/components/settings/app-icons')

  test('every file is named for an app in a catalog', () => {
    // WHY: the renderer looks icons up by id. A misnamed file is never read and
    // never errors — the app silently keeps its brand mark instead.
    const known = new Set<string>([
      ...EDITOR_APPS.map((app) => app.id),
      ...TERMINAL_APPS.map((app) => app.id),
    ])

    for (const file of readdirSync(ICON_DIRECTORY)) {
      expect({ file, known: known.has(file.replace(/\.png$/, '')) }).toEqual({ file, known: true })
    }
  })

  test('an app with no committed icon still has a brand mark to fall back to', () => {
    // WHY: only apps installed on a contributor's machine can be extracted, so
    // most ids ship without one. None of them may end up with no artwork at all.
    const committed = new Set(readdirSync(ICON_DIRECTORY).map((file) => file.replace(/\.png$/, '')))
    const withoutArtwork = EDITOR_APPS.filter(
      (app) => !committed.has(app.id) && !APP_LOGOS.has(app.id),
    )

    expect(withoutArtwork.map((app) => app.id)).toEqual([])
  })
})

describe('brand mark shape', () => {
  test('every mark is close to square', () => {
    // WHY: these render in a square slot ~14px wide. `logos:neovim` is a 512x148
    // wordmark, which came out as an illegible sliver — visible only by looking,
    // never by reading the code.
    const collections = {
      logos: require('@iconify-json/logos/icons.json'),
      'simple-icons': require('@iconify-json/simple-icons/icons.json'),
    }

    const lopsided: string[] = []
    for (const [id, name] of APP_LOGOS) {
      const [prefix, iconName] = name.split(':')
      const collection = collections[prefix as keyof typeof collections]
      const icon = collection.icons[iconName]
      const ratio = (icon.width ?? collection.width) / (icon.height ?? collection.height)
      if (ratio > 1.35 || ratio < 0.74) lopsided.push(`${id} (${name} at ${ratio.toFixed(2)}:1)`)
    }

    expect(lopsided).toEqual([])
  })
})
