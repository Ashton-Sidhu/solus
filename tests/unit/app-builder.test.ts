import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppBuildError, HostAppBuilder } from '@solus/server/apps/app-builder'
import { installTestIdentities } from './helpers/acting-identities'

/**
 * The host's build (docs/plans/apps.md decision 4) with a real Node and a
 * real npm, and a bundler of this test's own: it writes the build a project
 * asks for, so the test needs no esbuild and no network. A machine with no
 * Node 22 or no npm skips these.
 */
const node = spawnSync('node', ['-p', 'process.versions.node'], { encoding: 'utf8' })
const npm = spawnSync('npm', ['--version'], { encoding: 'utf8' })
const describeWithTools = node.status === 0 && Number(node.stdout.split('.')[0]) >= 22 && npm.status === 0 ? describe : describe.skip

const root = realpathSync(mkdtempSync(join(tmpdir(), 'solus-app-builder-')))
// A build is the host's own work: it runs as the host itself.
beforeAll(() => installTestIdentities())
afterAll(() => rmSync(root, { recursive: true, force: true }))

/** A bundler that builds what `build.json` of the project says, and fails when the project has a `fail.txt`. */
const BUNDLER = join(root, 'bundler.mjs')
writeFileSync(BUNDLER, `
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const folder = process.argv[2]
console.log('bundling for ' + (process.env.SOLUS_APP_BUILD ?? 'nobody'))
if (existsSync(join(folder, 'fail.txt'))) { console.error('app.ts(3,1): error TS1005: the source is wrong'); process.exit(1) }
const out = join(folder, 'dist', 'app')
mkdirSync(out, { recursive: true })
const descriptor = JSON.parse(readFileSync(join(folder, 'build.json'), 'utf8'))
writeFileSync(join(out, 'descriptor.json'), JSON.stringify(descriptor))
writeFileSync(join(out, 'ui.html'), '<!doctype html><title>' + descriptor.name + '</title>')
`)

const builder = () => new HostAppBuilder({ bundler: () => BUNDLER, root: () => join(root, 'builds') })

/** A checkout of one revision: it writes these files into the build folder. */
const revision = (files: { [path: string]: string }) => async (folder: string) => {
  for (const [path, text] of Object.entries(files)) writeFileSync(join(folder, path), text)
}
const descriptor = (extra: object = {}) => JSON.stringify({ solusApp: 3, name: 'Notes', ...extra })

describeWithTools('the host\'s build of a revision', () => {
  test('the host builds one revision in the app\'s folder, keeps what it installed, and builds nothing of the revision before', async () => {
    // WHY (decision 4): a deploy once read a build that an agent made, so
    // nothing tied a version's build to its source. The host now builds the
    // revision it runs, and a file of an earlier revision must not be in it.
    const host = builder()
    const first = await host.buildRevision('app-1', revision({ 'package.json': '{ "name": "notes" }', 'build.json': descriptor(), 'old.txt': 'of the first revision' }))
    expect(first.build.descriptor.name).toBe('Notes')
    expect(first.build.ui).toContain('<title>Notes</title>')
    // The bundler knows the host runs it, so it loads the backend under the permission model.
    expect(first.log).toContain('bundling for host')
    const folder = join(root, 'builds', 'app-1')
    const installedFrom = readFileSync(join(folder, '.solus-build'), 'utf8')
    mkdirSync(join(folder, 'node_modules', 'kept'), { recursive: true })

    const second = await host.buildRevision('app-1', revision({ 'package.json': '{ "name": "notes" }', 'build.json': descriptor({ name: 'Notes two' }) }))
    expect(second.build.descriptor.name).toBe('Notes two')
    expect(existsSync(join(folder, 'old.txt'))).toBe(false)
    // The dependencies did not change, so the build did not install again.
    expect(existsSync(join(folder, 'node_modules', 'kept'))).toBe(true)
    expect(readFileSync(join(folder, '.solus-build'), 'utf8')).toBe(installedFrom)

    await host.buildRevision('app-1', revision({ 'package.json': '{ "name": "notes", "version": "2.0.0" }', 'build.json': descriptor() }))
    expect(readFileSync(join(folder, '.solus-build'), 'utf8')).not.toBe(installedFrom)

    await host.remove('app-1')
    expect(existsSync(folder)).toBe(false)
  })

  test('a build that fails says why, with what the bundler printed', async () => {
    // WHY: the agent that wrote the app repairs it from the build's own words.
    const failure = await builder().buildRevision('app-2', revision({ 'package.json': '{}', 'build.json': descriptor(), 'fail.txt': '' })).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(AppBuildError)
    // SAFETY: the line above checked the class.
    const error = failure as AppBuildError
    expect(error.message).toBe('The build failed: app.ts(3,1): error TS1005: the source is wrong')
    expect(error.log).toContain('bundling for host')
    expect(error.ms).toBeGreaterThanOrEqual(0)
  })

  test('a build with a protocol this host does not run is refused, with the protocols it runs', async () => {
    // WHY (decision 22): a build names its protocol. A host must never run a build with a `ctx` it does not know.
    await expect(builder().buildRevision('app-3', revision({ 'package.json': '{}', 'build.json': descriptor({ solusApp: 9 }) })))
      .rejects.toThrow('This build has protocol 9. This host runs the protocols 2 and 3 and 4.')
  })

  test('two builds of one app run one after the other', async () => {
    const host = builder()
    const both = await Promise.all([
      host.buildRevision('app-4', revision({ 'package.json': '{}', 'build.json': descriptor({ name: 'First' }) })),
      host.buildRevision('app-4', revision({ 'package.json': '{}', 'build.json': descriptor({ name: 'Second' }) })),
    ])
    expect(both.map((result) => result.build.descriptor.name)).toEqual(['First', 'Second'])
  })

  test('a preview builds the project folder in place, and needs its dependencies there', async () => {
    const project = join(root, 'project')
    mkdirSync(project)
    writeFileSync(join(project, 'build.json'), descriptor())
    await expect(builder().buildProject(project)).rejects.toThrow('This project has no node_modules.')
    mkdirSync(join(project, 'node_modules'))
    expect((await builder().buildProject(project)).build.descriptor.name).toBe('Notes')
    expect(existsSync(join(project, 'dist', 'app', 'descriptor.json'))).toBe(true)
  })
})
