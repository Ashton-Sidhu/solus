import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { resolveSettings, type SettingSource } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { ClaudeAutoRestriction } from '@solus/contracts/claude-auto-mode'
import type { PermissionMode } from '@solus/contracts/types'
import { isInsideRoot, realPathOf } from '../../../paths'
import { resolveHomePath } from '../../../platform/paths'

export const CLAUDE_TURN_SETTING_SOURCES: SettingSource[] = ['user', 'project']

const disable = z.literal('disable').optional().catch(undefined)
const autoSettingsSchema = z.object({
  disableAutoMode: disable,
  permissions: z.object({ disableAutoMode: disable }).optional().catch(undefined),
})
type AutoSettings = z.infer<typeof autoSettingsSchema>

function parseSettings(text: string): AutoSettings | undefined {
  try { return autoSettingsSchema.safeParse(JSON.parse(text)).data } catch { return undefined }
}

function disablesAuto(settings: AutoSettings | undefined): boolean {
  return settings?.disableAutoMode === 'disable' || settings?.permissions?.disableAutoMode === 'disable'
}

async function readSettings(path: string, ...roots: string[]): Promise<AutoSettings | undefined> {
  try {
    const file = await realpath(path)
    if (roots.length && !roots.some((root) => isInsideRoot(root, file))) return
    const settings = await open(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
    try {
      const info = await settings.stat()
      if (!info.isFile() || info.size > 1024 * 1024) return
      const buffer = Buffer.alloc(info.size)
      const { bytesRead } = await settings.read(buffer)
      return parseSettings(buffer.toString('utf8', 0, bytesRead))
    } finally {
      await settings.close()
    }
  } catch {
    return undefined
  }
}

function launchFlag(args: readonly string[], name: string): string | undefined {
  for (let index = args.length - 1; index >= 0; index--) {
    const arg = args[index]
    if (arg === name) return args[index + 1]
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1)
  }
}

export function claudeAutoFallsBack(mode: PermissionMode, args: readonly string[], reported: string | undefined): boolean {
  return mode === 'auto' && (launchFlag(args, '--permission-mode') ?? 'auto') === 'auto' && reported === 'default'
}

async function managedAutoSettings(cwd: string): Promise<AutoSettings> {
  // The seat's remote cache is read below. Do not consult the server login's cache.
  const settings = await resolveSettings({ cwd: resolveHomePath(cwd), settingSources: [], serverManagedSettings: {} })
  return settings.effective
}

function readLaunchSettings(flag: string | undefined, checkout: string | undefined, roots: string[]) {
  if (!flag) return undefined
  if (flag.trimStart().startsWith('{')) return parseSettings(flag)
  if (isAbsolute(flag)) return readSettings(flag, ...roots)
  if (checkout) return readSettings(resolve(checkout, flag), ...roots)
}

/** Inspect the same sources as a Claude turn, without starting Claude. */
export async function claudeAutoModeRestriction(
  cwd: string | undefined,
  home: string,
  args: readonly string[],
  defaultSources: readonly SettingSource[],
  readManaged = managedAutoSettings,
  scopeRoot?: string,
): Promise<ClaudeAutoRestriction | null> {
  const sources = launchFlag(args, '--setting-sources')?.split(',') ?? defaultSources
  const flag = launchFlag(args, '--settings')
  const [folder, settingsHome, scope] = await Promise.all([
    cwd ? realPathOf(cwd) : undefined,
    realPathOf(home),
    scopeRoot ? realPathOf(scopeRoot) : undefined,
  ])
  const checkout = folder && (!scope || isInsideRoot(scope, folder)) ? folder : undefined
  const projectRoots = scope ? [scope] : []
  const homeRoots = scope ? [settingsHome] : []
  const [managed, remote, user, launch, project, local] = await Promise.all([
    readManaged(checkout ?? settingsHome).catch(() => undefined),
    readSettings(join(settingsHome, 'remote-settings.json'), ...homeRoots),
    sources.includes('user') ? readSettings(join(settingsHome, 'settings.json'), ...homeRoots) : undefined,
    readLaunchSettings(flag, checkout, [...projectRoots, ...homeRoots]),
    checkout && sources.includes('project') ? readSettings(join(checkout, '.claude/settings.json'), ...projectRoots) : undefined,
    checkout && sources.includes('local') ? readSettings(join(checkout, '.claude/settings.local.json'), ...projectRoots) : undefined,
  ])
  const sourcesByRestriction = [
    ['managed-settings', [managed, remote]],
    ['user-settings', [user, launch]],
    ['project-settings', [project, local]],
  ] as const
  return sourcesByRestriction.find(([, settings]) => settings.some(disablesAuto))?.[0] ?? null
}
