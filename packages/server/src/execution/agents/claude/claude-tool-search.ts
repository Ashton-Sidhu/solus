import { readFile } from 'fs/promises'
import { join } from 'path'
import { z } from 'zod'

/**
 * Claude Code's auto tool search sends every MCP tool schema in full while the
 * schemas fit under a share of the context window, which Solus's tools do on 1M
 * models. An MCP server that connects after the first request then changes the
 * tool list, and the prompt cache misses. `auto:0` already means on and
 * `auto:100` off, so only the modes between them become `true`, Claude Code's
 * default.
 */
export function claudeToolSearchOverride(value: string | undefined): 'true' | undefined {
  if (value === undefined) return undefined
  if (value === 'auto') return 'true'
  if (!value.startsWith('auto:')) return undefined
  const percent = parseClaudeInteger(value.slice('auto:'.length))
  // Claude Code treats an unparsable auto:N as auto, and clamps N to 0..100.
  if (Number.isNaN(percent)) return 'true'
  const clamped = Math.min(100, Math.max(0, percent))
  return clamped > 0 && clamped < 100 ? 'true' : undefined
}

// Claude Code 2.1.310's integer parsing for auto:N. Scientific notation counts only when it is an
// integer, grouped digits (1_000, 1,000, or 1 000) are joined, and anything else uses parseInt.
const SCIENTIFIC_INTEGER = /^[+-]?(\d+(\.\d*)?|\.\d+)[eE][+-]?\d+$/
const GROUPED_INTEGER = /^[+-]?\d{1,3}([_,   ])\d{3}(?:\1\d{3})*$/
function parseClaudeInteger(text: string): number {
  const value = text.trim()
  if (value.length <= 32 && SCIENTIFIC_INTEGER.test(value)) {
    const number = Number(value)
    return Number.isInteger(number) ? number : Number.NaN
  }
  if (value.length <= 32 && GROUPED_INTEGER.test(value)) {
    return Number.parseInt(value.replace(/[_,   ]/g, ''), 10)
  }
  return Number.parseInt(value, 10)
}

const toolSearchSettingsSchema = z.object({ env: z.object({ ENABLE_TOOL_SEARCH: z.string() }) })

async function readToolSearchSetting(settingsFile: string): Promise<string | undefined> {
  try {
    const parsed = toolSearchSettingsSchema.safeParse(JSON.parse(await readFile(settingsFile, 'utf8')))
    return parsed.success ? parsed.data.env.ENABLE_TOOL_SEARCH : undefined
  } catch {
    return undefined
  }
}

/**
 * The override for a turn that loads user and project settings. A settings env
 * beats the launch env, and project beats user, so the first one that sets the
 * value decides. The override goes in the flag settings, which beat both.
 */
export async function resolveClaudeToolSearchOverride(
  cwd: string,
  configDir: string,
  launchEnv: NodeJS.ProcessEnv | undefined,
): Promise<'true' | undefined> {
  for (const settingsFile of [join(cwd, '.claude', 'settings.json'), join(configDir, 'settings.json')]) {
    const value = await readToolSearchSetting(settingsFile)
    if (value !== undefined) return claudeToolSearchOverride(value)
  }
  return claudeToolSearchOverride(launchEnv?.ENABLE_TOOL_SEARCH)
}
