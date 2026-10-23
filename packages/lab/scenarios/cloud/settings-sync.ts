import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import { accountAgentProfileResponseSchema, agentProfileKeyOf, type AgentProfileFileEntry } from '@solus/contracts/agent-profile'
import { ACCOUNT_SETTINGS_PATH, accountSettingsConflictBodySchema, accountSettingsResponseSchema } from '@solus/contracts/settings'
import { cloudModeScenario } from '../../src/cloud-mode'
import { accountApi, ownedRegisteredHost } from '../../src/cloud-fixtures'
import type { SignedIn } from '../../src/cloud-sign-in'

/**
 * Settings and profile sync (plans/018 §4, plans/020 §2, §5): alice is signed in on two
 * clients, `solus-desktop` and `solus-mobile`. A personal setting one client patches
 * through the account route, the other reads. A patch against a revision that moved is
 * refused with the current document (409 `settings_conflict`), so neither edit is lost
 * in silence. A file the account's agent profile holds, a host applies at its next
 * `agentProfilePull`, into the homes of the host's own login: in the Lab that is the
 * host's own `HOME` in its data directory, never the developer's.
 */

const PROFILE_PATH = '/v1/agent-profile'

export default cloudModeScenario('settings sync: one client\'s setting reaches the other, a stale write is refused, the profile reaches a host', async (ctx) => {
  const desktop = await ctx.signIn('alice')
  const mobile = await ctx.signIn('alice', 'mobile')

  ctx.step('the desktop patches a personal setting through the account route')
  const first = await accountApi(ctx.stack, desktop, ACCOUNT_SETTINGS_PATH)
  const original = accountSettingsResponseSchema.parse(await first.json())
  const wasSet = original.settings.themeMode !== undefined
  const next = original.settings.themeMode === 'dark' ? 'light' : 'dark'
  const patched = await accountApi(ctx.stack, desktop, ACCOUNT_SETTINGS_PATH, { method: 'PATCH', body: { generation: original.generation, expectedRevision: original.revision, set: { themeMode: next }, reset: [] } })
  const afterPatch = accountSettingsResponseSchema.safeParse(await patched.json().catch(() => null))
  ctx.check('the account takes the patch', patched.ok && afterPatch.success && afterPatch.data.settings.themeMode === next, `${patched.status} ${JSON.stringify(afterPatch.success ? afterPatch.data.settings.themeMode : afterPatch.error.message)}`)
  if (!afterPatch.success) return
  ctx.check('the revision moved', afterPatch.data.revision !== null && afterPatch.data.revision !== original.revision, `${original.revision} → ${afterPatch.data.revision}`)
  ctx.defer('alice\'s setting goes back as it was', async () => {
    const current = accountSettingsResponseSchema.parse(await (await accountApi(ctx.stack, mobile, ACCOUNT_SETTINGS_PATH)).json())
    const body = wasSet ? { set: { themeMode: original.settings.themeMode }, reset: [] } : { set: {}, reset: ['themeMode'] }
    const restored = await accountApi(ctx.stack, mobile, ACCOUNT_SETTINGS_PATH, { method: 'PATCH', body: { generation: current.generation, expectedRevision: current.revision, ...body } })
    if (!restored.ok) throw new Error(`Restoring the setting answered ${restored.status}`)
  })

  ctx.step('the mobile client reads it')
  const onMobile = await accountApi(ctx.stack, mobile, ACCOUNT_SETTINGS_PATH)
  const mobileView = accountSettingsResponseSchema.safeParse(await onMobile.json().catch(() => null))
  ctx.check('mobile reads the desktop\'s setting', mobileView.success && mobileView.data.settings.themeMode === next, JSON.stringify(mobileView.success ? mobileView.data.settings.themeMode : onMobile.status))
  ctx.check('at the same revision', mobileView.success && mobileView.data.revision === afterPatch.data.revision)

  ctx.step('a patch against the revision before the desktop\'s is refused')
  const stale = await accountApi(ctx.stack, mobile, ACCOUNT_SETTINGS_PATH, { method: 'PATCH', body: { generation: original.generation, expectedRevision: original.revision, set: { themeMode: 'system' }, reset: [] } })
  const conflict = accountSettingsConflictBodySchema.safeParse(await stale.json().catch(() => null))
  ctx.check('the stale patch answers 409 settings_conflict', stale.status === 409 && conflict.success && conflict.data.error === 'settings_conflict', `${stale.status} ${conflict.success ? conflict.data.error : conflict.error.message}`)
  ctx.check('with the current document, which keeps the desktop\'s edit', conflict.success && conflict.data.current.revision === afterPatch.data.revision && conflict.data.current.settings.themeMode === next)
  const unchanged = accountSettingsResponseSchema.parse(await (await accountApi(ctx.stack, desktop, ACCOUNT_SETTINGS_PATH)).json())
  ctx.check('the refused patch changed nothing', unchanged.settings.themeMode === next && unchanged.revision === afterPatch.data.revision)

  ctx.step('the mobile client adds a file to the agent profile; alice\'s host applies it at its next pull')
  const { host, owner } = await ownedRegisteredHost(ctx)
  const skill = `lab-skill-${randomBytes(3).toString('hex')}`
  const content = `# ${skill}\n\nA skill from alice's account, applied by the Lab.\n`
  const entry: AgentProfileFileEntry = { kind: 'file', provider: 'claude-code', path: `skills/${skill}/SKILL.md`, contentBase64: Buffer.from(content).toString('base64'), hash: createHash('sha256').update(content).digest('hex') }
  const key = agentProfileKeyOf(entry)
  const readProfile = async (as: SignedIn) => accountAgentProfileResponseSchema.parse(await (await accountApi(ctx.stack, as, PROFILE_PATH)).json())
  const profile = await readProfile(mobile)
  const added = await accountApi(ctx.stack, mobile, PROFILE_PATH, { method: 'PATCH', body: { generation: profile.generation, expectedRevision: profile.revision, set: { [key]: entry }, reset: [] } })
  ctx.check('the account takes the profile patch', added.ok, String(added.status))
  ctx.defer('the file leaves alice\'s profile', async () => {
    const current = await readProfile(mobile)
    const removed = await accountApi(ctx.stack, mobile, PROFILE_PATH, { method: 'PATCH', body: { generation: current.generation, expectedRevision: current.revision, set: {}, reset: [key] } })
    if (!removed.ok) throw new Error(`Removing the file from the profile answered ${removed.status}`)
  })
  ctx.check('the desktop reads the same profile entry', (await readProfile(desktop)).entries[key]?.kind === 'file')

  // The host learns its owner from the cloud a moment after registration; a pull before that is refused.
  const pulled = await ctx.until(() => owner.rpc('agentProfilePull').then(() => 'ok', (error: unknown) => error instanceof Error ? error.message : String(error)), (answer) => answer === 'ok', 20_000)
  ctx.check('the host pulls the profile with alice\'s delegation', pulled === 'ok', pulled)
  const hostHome = join(host.dataDir, 'home')
  const applied = join(hostHome, '.claude', 'skills', skill, 'SKILL.md')
  ctx.check('the file is in the host login\'s Claude home', existsSync(applied) && readFileSync(applied, 'utf8') === content, applied)
  const resolvedDataDir = realpathSync(host.dataDir)
  ctx.check('that home is inside the host\'s data directory', existsSync(applied) && realpathSync(applied).startsWith(`${resolvedDataDir}${sep}`), existsSync(applied) ? realpathSync(applied) : 'missing')
  ctx.check('the developer\'s own home did not get it', !existsSync(join(homedir(), '.claude', 'skills', skill)), join(homedir(), '.claude', 'skills', skill))
})
