import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MAX_APP_ICON_BYTES } from '@solus/contracts/apps'
import { appIconProblem } from '@solus/server/apps/app-icon'
import { NOTES, by, change, describeWithNode, host, installAppsHost, owner, project, save, service, ship } from './helpers/apps-host'

// The icon of an app (docs/app-shortcuts.md §4): an optional icon.svg beside
// app.ts. What matters: a client, a remote client, and a launcher get only a
// plain, self-contained SVG, which the host checked at the save and at the
// build; an app with no icon keeps its monogram; and a new icon gets a new
// hash, so a client and a launcher know to read it again.

const ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g"><stop offset="0" stop-color="#f60"/></linearGradient></defs><rect width="64" height="64" rx="14" fill="url(#g)"/><use href="#g"/></svg>'

function problemOf(svg: string): string | null {
  return appIconProblem(new TextEncoder().encode(svg))
}

describe('the check of an icon', () => {
  test('a plain SVG with a viewBox, its own gradients, and links inside it is an icon', () => {
    expect(problemOf(ICON)).toBeNull()
    expect(problemOf(`<?xml version="1.0" encoding="UTF-8"?>\n${ICON}`)).toBeNull()
    // An editor's own namespace is kept: an image does not show it.
    expect(problemOf('<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" viewBox="0 0 1 1" inkscape:version="1"><inkscape:grid/></svg>')).toBeNull()
  })

  // WHY: an icon shows in every client and in the launchers of the person's computer. It must not run code or reach outside itself.
  test.each([
    ['a script', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><script>alert(1)</script></svg>', '<script>'],
    ['an event attribute', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1" onload="alert(1)"/>', 'onload'],
    ['embedded HTML', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><foreignObject><div xmlns="http://www.w3.org/1999/xhtml"/></foreignObject></svg>', '<foreignObject>'],
    ['an image of another file', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><image href="logo.png"/></svg>', '<image>'],
    ['a link outside the icon', '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 1 1"><use xlink:href="https://example.com/a.svg#x"/></svg>', 'https://example.com'],
    ['a style that loads a file', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><style>@import url(https://example.com/a.css);</style></svg>', 'style'],
    ['a fill from another file', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect fill="url(https://example.com/p.svg#p)"/></svg>', 'fill'],
    ['an animation of a link', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><a href="#x"><set attributeName="href" to="javascript:alert(1)"/></a></svg>', 'animates'],
    ['a DOCTYPE', '<!DOCTYPE svg [<!ENTITY x "y">]><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>', 'DOCTYPE'],
    ['a stylesheet instruction', '<?xml-stylesheet href="a.css"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>', 'xml-stylesheet'],
  ])('%s is refused, and the reason says what to remove', (_kind, svg, named) => {
    expect(problemOf(svg)).toContain(named)
  })

  test('a file that is not an SVG icon is refused with a reason an agent can act on', () => {
    expect(problemOf('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1">')).toContain('not well-formed XML')
    expect(problemOf('<html xmlns="http://www.w3.org/1999/xhtml"/>')).toContain('must have one <svg xmlns=')
    expect(problemOf('<svg viewBox="0 0 1 1"/>')).toContain('must have one <svg xmlns=')
    // With no viewBox, the icon has no proportions to scale to each size.
    expect(problemOf('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>')).toContain('viewBox')
    expect(appIconProblem(new Uint8Array([0xff, 0xfe, 0x00]))).toContain('UTF-8')
  })

  test('an icon over 64 KiB is refused; one at the limit is an icon', () => {
    const open = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><!--'
    const close = '--></svg>'
    const atLimit = `${open}${'a'.repeat(MAX_APP_ICON_BYTES - open.length - close.length)}${close}`
    expect(problemOf(atLimit)).toBeNull()
    expect(problemOf(atLimit.replace('<!--', '<!--a'))).toContain(`at most ${MAX_APP_ICON_BYTES} bytes`)
  })
})

installAppsHost()

describeWithNode('the icon of an app on a host', () => {
  test('an app with no icon.svg has no icon hash, and a client reads no icon: the tile is the monogram', async () => {
    const apps = await service()
    const { app } = await ship(apps, project(NOTES))
    expect(app.iconHash).toBeNull()
    expect(await apps.icon(owner, app.id)).toBeNull()
  })

  test('a deploy keeps the icon of its revision; a new icon is a new hash, and a removed icon goes', async () => {
    // WHY: the hash is how a client and a launcher know the icon changed, without reading the icon each time.
    const apps = await service()
    const folder = project({ ...NOTES, source: { 'icon.svg': ICON } })
    const { app } = await ship(apps, folder)
    const hash = createHash('sha256').update(ICON).digest('hex')
    expect(app.iconHash).toBe(hash)
    expect(await apps.icon(owner, app.id)).toEqual({ hash, svg: ICON })

    const next = ICON.replace('rx="14"', 'rx="20"')
    const changed = await change(apps, folder, { ...NOTES, source: { 'icon.svg': next } })
    expect(changed.app.iconHash).toBe(createHash('sha256').update(next).digest('hex'))
    expect((await apps.icon(owner, app.id))?.svg).toBe(next)

    const removed = await change(apps, folder, NOTES)
    expect(removed.app.iconHash).toBeNull()
    expect(await apps.icon(owner, app.id)).toBeNull()
    // A rollback brings back the icon of the version it activates.
    await apps.activate(owner, app.id, 1)
    expect((await apps.icon(owner, app.id))?.hash).toBe(hash)
  })

  // WHY: an agent must learn at its save, with the reason, that the icon is not one; the host never stores an unsafe icon.
  test('a save with an unsafe icon.svg is refused, and makes no revision', async () => {
    const apps = await service()
    const folder = project({ ...NOTES, source: { 'icon.svg': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1" onload="x()"/>' } })
    await expect(save(apps, folder)).rejects.toThrow('icon.svg has an onload attribute')
    expect(await apps.list(owner)).toEqual([])
  })

  test('a deploy of a revision whose icon is not valid fails, and the version before it still runs', async () => {
    // A revision from before the check, or a build folder that differs from the save: the build checks again.
    const { apps, builder } = await host()
    const folder = project(NOTES)
    const { app } = await ship(apps, folder)
    const saved = await save(apps, folder)
    const buildRevision = builder.buildRevision.bind(builder)
    builder.buildRevision = (appId, checkout) => buildRevision(appId, async (into) => {
      await checkout(into)
      writeFileSync(join(into, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><script/></svg>')
    })
    const deployed = await apps.deploy(owner, { app: app.id, revision: saved.revision, createdBy: by })
    expect(deployed).toMatchObject({ active: false, version: 2 })
    expect(deployed.error).toContain('<script>')
    expect((await apps.read(owner, app.id)).app.activeVersion).toBe(1)
  })
})
