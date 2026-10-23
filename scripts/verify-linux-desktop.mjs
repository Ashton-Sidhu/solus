/** Explicit native verification. Uses temporary data and closes only its own app. */
import { chromium, expect } from '@playwright/test'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { createServer } from 'node:net'
import { existsSync, readFileSync } from 'node:fs'

const backend = process.argv[2] || 'x11'
if (!['x11', 'wayland'].includes(backend)) throw new Error('Choose x11 or wayland.')
const executable = process.argv[3] && resolve(process.argv[3])
const appImage = executable?.endsWith('.AppImage')
const scratch = await mkdtemp(join(tmpdir(), 'solus-linux-verify-'))
const evidence = resolve('.solus-local/linux-verification', executable ? (appImage ? 'appimage-' : 'packaged-') + backend : backend)
await mkdir(evidence, { recursive: true })
await Promise.all(['result.json', 'failure.png', 'failure.txt'].map(name => rm(join(evidence, name), { force: true })))
async function unusedPort() {
  const probe = createServer()
  await new Promise((done, fail) => { probe.once('error', fail); probe.listen(0, '127.0.0.1', done) })
  const port = probe.address().port
  await new Promise(done => probe.close(done))
  return port
}
// The host's session paths when it has them (a desktop login); a private one on a headless runner.
const runtimeDir = process.env.XDG_RUNTIME_DIR || (existsSync(`/run/user/${process.getuid()}`) ? `/run/user/${process.getuid()}` : join(scratch, 'runtime'))
await mkdir(runtimeDir, { recursive: true, mode: 0o700 })
const sessionBus = process.env.DBUS_SESSION_BUS_ADDRESS || (existsSync(join(runtimeDir, 'bus')) ? `unix:path=${join(runtimeDir, 'bus')}` : undefined)
const env = {
  PATH: process.env.PATH, HOME: process.env.HOME, USER: process.env.USER, LANG: 'en_US.UTF-8',
  DISPLAY: process.env.DISPLAY || ':0', WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY || 'wayland-1',
  XDG_RUNTIME_DIR: runtimeDir,
  XDG_SESSION_TYPE: backend === 'wayland' ? 'wayland' : 'x11',
  XDG_CURRENT_DESKTOP: process.env.XDG_CURRENT_DESKTOP || 'Hyprland',
  XDG_CONFIG_HOME: join(scratch, 'config'), XDG_CACHE_HOME: join(scratch, 'cache'), XDG_DATA_HOME: join(scratch, 'data'),
  CODEX_HOME: join(scratch, 'codex'), CLAUDE_CONFIG_DIR: join(scratch, 'claude'),
  SOLUS_SKIP_ONBOARDING: '1', SOLUS_TEST_MODE: '0', SOLUS_DATA_DIR: join(scratch, 'server'), SOLUS_DEV_LOG: join(evidence, 'server.log'),
  SOLUS_PORT: String(await unusedPort()), SOLUS_TUNNEL_PORT: String(await unusedPort()), SOLUS_DB: 'sqlite', SOLUS_NO_LAN_DISCOVERY: '1',
  ELECTRON_ENABLE_LOGGING: '1',
}
if (sessionBus) env.DBUS_SESSION_BUS_ADDRESS = sessionBus
if (appImage && process.env.APPIMAGE_EXTRACT_AND_RUN) env.APPIMAGE_EXTRACT_AND_RUN = process.env.APPIMAGE_EXTRACT_AND_RUN
await mkdir(env.CODEX_HOME, { recursive: true })
await mkdir(env.CLAUDE_CONFIG_DIR, { recursive: true })
let browser, owned, page, second
let desktopPid
const errors = []
const checks = []
function belongsToApp(pid) {
  while (pid > 1) {
    if (pid === owned.pid) return true
    try { pid = Number(readFileSync(`/proc/${pid}/status`, 'utf8').match(/^PPid:\s+(\d+)/m)?.[1]) } catch { return false }
  }
  return false
}
try {
  const args = ['--ozone-platform=' + backend, '--user-data-dir=' + join(scratch, 'user-data')]
  {
    const port = await unusedPort()
    owned = spawn(executable || resolve('node_modules/electron/dist/electron'), [...args, '--remote-debugging-port=' + port, ...(executable ? [] : [resolve('.')])], { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    owned.stderr.on('data', chunk => errors.push(chunk.toString()))
    desktopPid = owned.pid
    owned.stdout.on('data', chunk => errors.push(chunk.toString()))
    await expect.poll(async () => {
      try { return (await fetch(`http://127.0.0.1:${port}/json/version`)).ok } catch { return false }
    }, { timeout: 45000 }).toBe(true)
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
    await expect.poll(() => browser.contexts()[0]?.pages().length ?? 0, { timeout: 30000 }).toBeGreaterThan(0)
    page = browser.contexts()[0].pages()[0]
  }
  page.on('pageerror', error => errors.push('PAGE: ' + error.message))
  const input = page.getByTestId('message-input').locator('.cm-content').first()
  await input.waitFor({ state: 'visible', timeout: 60000 })
  await input.click()
  await page.keyboard.type('Linux desktop verification')
  await expect(input).toContainText('Linux desktop verification')
  checks.push('launch', 'renderer ready', 'composer typing')
  await page.screenshot({ animations: 'disabled', path: join(evidence, 'workspace.png') })
  await page.keyboard.press('Control+a')
  await page.keyboard.press('Backspace')
  await expect(input).not.toContainText('Linux desktop verification')
  await page.getByRole('button', { name: 'Add', exact: true }).first().click()
  await expect(page.getByRole('menuitem', { name: /screenshot/i })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: /Design mode/i })).toHaveCount(0)
  checks.push('screenshot menu available', 'design mode absent')
  await page.screenshot({ animations: 'disabled', path: join(evidence, 'capture-menu.png') })
  await page.keyboard.press('Escape')
  if (process.env.SOLUS_VERIFY_CAPTURE_POINTER) {
    await page.getByRole('button', { name: 'Add', exact: true }).first().click()
    await page.getByRole('menuitem', { name: /screenshot/i }).click()
    await expect.poll(() => execFileSync('hyprctl', ['-j', 'layers'], { encoding: 'utf8', env: process.env }).includes('selection'), { timeout: 15000 }).toBe(true)
    execFileSync(resolve(process.env.SOLUS_VERIFY_CAPTURE_POINTER), [], { env: process.env, timeout: 5000 })
    await expect(page.getByRole('img', { name: 'screenshot 1.png' })).toBeVisible({ timeout: 30000 })
    checks.push('real portal region capture', 'screenshot uploaded to local host', 'composer restored after capture')
    await page.screenshot({ animations: 'disabled', path: join(evidence, 'screenshot-attached.png') })
    await page.getByRole('button', { name: 'Add', exact: true }).first().click()
    await page.getByRole('menuitem', { name: /screenshot/i }).click()
    await expect.poll(() => execFileSync('hyprctl', ['-j', 'layers'], { encoding: 'utf8', env: process.env }).includes('selection'), { timeout: 15000 }).toBe(true)
    execFileSync('wtype', ['-k', 'Escape'], { env: process.env, timeout: 5000 })
    await expect.poll(() => execFileSync('hyprctl', ['-j', 'layers'], { encoding: 'utf8', env: process.env }).includes('selection'), { timeout: 10000 }).toBe(false)
    await expect.poll(() => JSON.parse(execFileSync('hyprctl', ['-j', 'clients'], { encoding: 'utf8', env: process.env })).some(window => belongsToApp(window.pid)), { timeout: 10000 }).toBe(true)
    await expect(page.getByRole('img', { name: 'screenshot 2.png' })).toHaveCount(0)
    await expect(input).toBeFocused()
    checks.push('real portal cancellation restores composer without attachment')
  }
  // Close hides the workspace. A second launch must show the existing app again.
  await writeFile(join(evidence, 'stderr.log'), errors.join(''))
  console.log(JSON.stringify({ phase: 'before recovery', pid: owned.pid, exitCode: owned.exitCode, signal: owned.signalCode }))
  if (owned.exitCode !== null || owned.signalCode) throw new Error('App exited before recovery.')
  if (process.env.HYPRLAND_INSTANCE_SIGNATURE) {
    let window
    await expect.poll(() => {
      const windows = JSON.parse(execFileSync('hyprctl', ['-j', 'clients'], { encoding: 'utf8', env: process.env }))
      window = windows.find(window => belongsToApp(window.pid))
      if (window) desktopPid = window.pid
      return !!window
    }, { timeout: 10000 }).toBe(true)
    execFileSync('hyprctl', ['dispatch', `hl.dsp.window.close({ window = "address:${window.address}" })`], { env: process.env })
    await expect.poll(() => JSON.parse(execFileSync('hyprctl', ['-j', 'clients'], { encoding: 'utf8', env: process.env })).some(window => belongsToApp(window.pid)), { timeout: 10000 }).toBe(false)
    checks.push('native close hides window')
  }
  second = spawn(executable || resolve('node_modules/electron/dist/electron'), [...args, ...(executable ? [] : [resolve('.')])], { env, stdio: 'ignore' })
  const secondExit = await new Promise((done, fail) => {
    const deadline = setTimeout(() => { second.kill('SIGTERM'); fail(new Error('Second launch did not return within 10 seconds.')) }, 10000)
    second.once('error', error => { clearTimeout(deadline); fail(error) })
    second.once('exit', code => { clearTimeout(deadline); done(code) })
  })
  if (secondExit !== 0) throw new Error('Second launch did not exit cleanly.')
  await input.click()
  await page.keyboard.type('Restored by second launch')
  await expect(input).toContainText('Restored by second launch')
  checks.push('second launch reuses and restores app')
  await page.screenshot({ animations: 'disabled', path: join(evidence, 'restored.png') })
  if (executable?.endsWith('/solus')) {
    await page.keyboard.press('Control+,')
    const update = page.getByRole('button', { name: 'Download Linux update', exact: true })
    await expect(update).toBeVisible({ timeout: 15000 })
    await update.scrollIntoViewIfNeeded()
    await expect(page.getByRole('switch', { name: 'Toggle automatic update downloads' })).toHaveCount(0)
    checks.push('manual package update shown accurately')
    await page.screenshot({ animations: 'disabled', path: join(evidence, 'manual-updates.png') })
  }
  if (appImage) {
    await page.keyboard.press('Control+,')
    await expect(page.getByRole('switch', { name: 'Toggle automatic update downloads' })).toBeVisible({ timeout: 15000 })
    await expect(page.getByRole('button', { name: 'Download Linux update', exact: true })).toHaveCount(0)
    checks.push('AppImage automatic update controls available')
    await page.screenshot({ animations: 'disabled', path: join(evidence, 'appimage-updates.png') })
  }
  if (errors.some(error => error.startsWith('PAGE:'))) throw new Error('Renderer error: ' + errors.filter(error => error.startsWith('PAGE:')).join('\n'))
  await writeFile(join(evidence, 'result.json'), JSON.stringify({ ok: true, backend, executable, pid: owned.pid, checks }, null, 2))
  console.log(JSON.stringify({ ok: true, backend, evidence, checks }))
} catch (error) {
  console.error(error)
  // The app's own output says why it did not start; CI shows only this log.
  console.error('--- app output (last 200 lines) ---\n' + errors.join('').split('\n').slice(-200).join('\n'))
  if (page) {
    await page.screenshot({ animations: 'disabled', timeout: 5000, path: join(evidence, 'failure.png') }).catch(() => {})
    await writeFile(join(evidence, 'failure.txt'), await page.locator('body').innerText({ timeout: 2000 }).catch(() => 'No renderer'))
  }
  process.exitCode = 1
} finally {
  await writeFile(join(evidence, 'stderr.log'), errors.join(''))
  if (second?.exitCode === null) {
    const ended = new Promise(done => second.once('exit', done))
    const deadline = setTimeout(() => second.kill('SIGKILL'), 5000)
    second.kill('SIGTERM')
    await ended
    clearTimeout(deadline)
  }
  if (owned?.exitCode === null) {
    const ended = new Promise(done => owned.once('exit', done))
    // The group was created by this harness. AppImage may have a launcher parent.
    const deadline = setTimeout(() => { try { process.kill(-owned.pid, 'SIGKILL') } catch {} }, 5000)
    try {
      process.kill(desktopPid, 'SIGTERM')
      await ended
    } catch {
      // It exited before its exit event arrived.
    }
    clearTimeout(deadline)
  }
  if (browser) await browser.close().catch(() => {})
  console.log(JSON.stringify({ phase: 'closed', pid: owned?.pid, exitCode: owned?.exitCode, signal: owned?.signalCode }))
  await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
