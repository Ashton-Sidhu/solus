import { describe, expect, test } from 'bun:test'
import { appMenuBarPageSize } from '@solus/contracts/apps'
import { NOTES, change, describeWithNode, installAppsHost, owner, project, ship } from './helpers/apps-host'

// The menu-bar page of an app (docs/plans/app-desktop-capabilities.md §9): a
// second page, menubar.html beside index.html, that the desktop shows in a
// popover under the app's menu-bar item. What matters: a client reads it by
// name, the main page says whether there is one and its size, so the desktop
// needs no second read to know, and a version without it has none.

const MENU = '<!doctype html><html><head><title>Notes</title><meta name="solus:menubar" content="width=360, height=240"></head><body>menu</body></html>'

describe('the size of a menu-bar page', () => {
  test('the meta names it, and each side stays in its range', () => {
    expect(appMenuBarPageSize(MENU)).toEqual({ width: 360, height: 240 })
    expect(appMenuBarPageSize('<meta content="height=9999,width=10" name="solus:menubar">')).toEqual({ width: 200, height: 720 })
    expect(appMenuBarPageSize('<title>No meta</title>')).toEqual({ width: 320, height: 400 })
    expect(appMenuBarPageSize('<meta name="solus:menubar" content="width=big">')).toEqual({ width: 320, height: 400 })
  })
})

installAppsHost()

describeWithNode('the menu-bar page on a host', () => {
  test('a client reads the page by name, and the main page gives its size', async () => {
    const apps = await (await import('./helpers/apps-host')).service()
    const folder = project({ ...NOTES, menuBar: MENU })
    const { app } = await ship(apps, folder)
    const main = await apps.ui(owner, app.id)
    expect(main?.menuBarPage).toEqual({ width: 360, height: 240 })
    expect((await apps.ui(owner, app.id, 'menubar'))?.html).toBe(MENU)

    // A new version with no menu-bar page has none, and its main page says so.
    await change(apps, folder, NOTES)
    expect((await apps.ui(owner, app.id))?.menuBarPage).toBeNull()
    expect(await apps.ui(owner, app.id, 'menubar')).toBeNull()
  })
})
