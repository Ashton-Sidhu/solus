/**
 * Antigravity's skills and the files of its profile (docs/plans/antigravity-provider.md §7.1).
 *
 * The skill folders and the files linked into a private profile follow T3 Code
 * (`pingdotgg/t3code` commit b8ef0600, `apps/server/src/provider/Drivers/AntigravitySkills.ts`
 * and `apps/server/src/provider/antigravityAuthSupport.ts`):
 *
 *   MIT License. Copyright (c) 2026 T3 Tools Inc.
 *   Permission is hereby granted, free of charge, to any person obtaining a copy
 *   of this software and associated documentation files (the "Software"), to deal
 *   in the Software without restriction, including without limitation the rights
 *   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 *   copies of the Software, and to permit persons to whom the Software is
 *   furnished to do so, subject to the following conditions: The above copyright
 *   notice and this permission notice shall be included in all copies or
 *   substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS",
 *   WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED.
 */
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, rmdirSync, statSync, symlinkSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import type { PluginCommand, PluginCommandsResult } from '@solus/contracts/types'
import { createLogger } from '../../../logger'

const log = createLogger('AntigravitySkills', 'antigravity-skills.ts')

/** The folder of a profile that the agent profile copies a person's skills into: agy reads `config/skills` there. */
export function antigravityProfileFilesHome(profile: string): string {
  return join(profile, 'config')
}

/** Where agy reads global skills inside a profile (`GEMINI_HOME`). */
const GLOBAL_SKILL_FOLDERS = [['config', 'skills'], ['antigravity-cli', 'skills']] as const
/** Where agy reads a project's skills, in its order. */
const PROJECT_SKILL_FOLDERS = [['.gemini', 'skills'], ['.agents', 'skills'], ['.agent', 'skills']] as const
/**
 * The person's own rules, skill list, and MCP servers, linked into the host login's profile.
 * agy reads `config/mcp_config.json` under its `--gemini-dir`, so without the link a Solus run
 * would not have the servers the person set up for agy in a terminal (`~/.gemini/config`).
 */
const LINKED_FILES = [['AGENTS.md'], ['GEMINI.md'], ['config', 'skills.json'], ['config', 'mcp_config.json']] as const

const MAX_SKILLS = 500
const FRONTMATTER_BYTES = 4096

/**
 * The host login's profile is Solus's own folder (§7), so the owner's own
 * `~/.gemini` skills and rules are linked into it: the host login then reads
 * what `agy` reads in a terminal. A folder that holds files is never replaced.
 */
export function linkHostGeminiConfig(profile: string, userGemini = join(homedir(), '.gemini')): void {
  for (const segments of GLOBAL_SKILL_FOLDERS) ensureLink(join(profile, ...segments), join(userGemini, ...segments), 'dir')
  for (const segments of LINKED_FILES) ensureLink(join(profile, ...segments), join(userGemini, ...segments), 'file')
}

function ensureLink(link: string, target: string, type: 'dir' | 'file'): void {
  try {
    const current = lstatOrNull(link)
    if (!existsSync(target)) {
      // A link to a target the person removed would make agy fail to create its folder.
      if (current?.isSymbolicLink()) unlinkSync(link)
      return
    }
    if (current?.isSymbolicLink()) {
      if (resolve(dirname(link), readlinkSync(link)) === target) return
      unlinkSync(link)
    } else if (current?.isDirectory()) {
      // agy makes an empty folder at each start; one with files in it is the person's own.
      if (readdirSync(link).length > 0) return
      rmdirSync(link)
    } else if (current) {
      // agy makes an empty `mcp_config.json` at each start; a file with content is the person's own.
      if (!current.isFile() || current.size > 0) return
      unlinkSync(link)
    }
    mkdirSync(dirname(link), { recursive: true })
    symlinkSync(target, link, type)
  } catch (error) {
    log.warn('antigravity_link_failed', { link, error: error instanceof Error ? error.message : String(error) })
  }
}

function lstatOrNull(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path)
  } catch {
    return null
  }
}

/** The skills a session can call, for the slash menu: the project's first, then the profile's, then its plugins'. */
export function listAntigravitySkills(workingDirectory: string, profile: string): PluginCommandsResult {
  const seen = new Set<string>()
  const project = PROJECT_SKILL_FOLDERS.flatMap((segments) => skillsIn(join(workingDirectory, ...segments), seen))
  const global = GLOBAL_SKILL_FOLDERS.flatMap((segments) => skillsIn(join(profile, ...segments), seen))
  return { global: [...global, ...pluginSkills(profile, seen)], project }
}

const pluginPreferencesSchema = z.object({ plugins: z.record(z.string(), z.looseObject({ enabled: z.boolean().optional() })).optional() })
const MAX_CONFIG_BYTES = 256 * 1024

/** The plugins the profile's `config/config.json` turns off; agy loads every other plugin. */
function disabledPlugins(profile: string): Set<string> {
  const file = join(profile, 'config', 'config.json')
  try {
    if (statSync(file).size > MAX_CONFIG_BYTES) return new Set()
    const preferences = pluginPreferencesSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')))
    const plugins = preferences.success ? preferences.data.plugins ?? {} : {}
    return new Set(Object.entries(plugins).filter(([, plugin]) => plugin.enabled === false).map(([name]) => name))
  } catch {
    return new Set()
  }
}

/** The skills of each plugin agy loads: `config/plugins/<plugin>/skills`. */
function pluginSkills(profile: string, seen: Set<string>): PluginCommand[] {
  const folder = join(profile, 'config', 'plugins')
  let plugins: string[]
  try {
    plugins = readdirSync(folder).sort()
  } catch {
    return []
  }
  const disabled = disabledPlugins(profile)
  return plugins.filter((plugin) => !plugin.startsWith('.') && !disabled.has(plugin)).flatMap((plugin) => skillsIn(join(folder, plugin, 'skills'), seen))
}

function skillsIn(folder: string, seen: Set<string>): PluginCommand[] {
  let entries: string[]
  try {
    entries = readdirSync(folder).sort()
  } catch {
    return []
  }
  const skills: PluginCommand[] = []
  for (const entry of entries) {
    if (seen.size >= MAX_SKILLS || entry.startsWith('.')) continue
    const file = skillFileOf(join(folder, entry))
    if (!file) continue
    const { name, description } = frontmatterOf(file)
    const skillName = name ?? entry
    if (seen.has(skillName)) continue
    seen.add(skillName)
    skills.push({ name: skillName, description: description ?? '', kind: 'skill', path: file })
  }
  return skills
}

/** A skill folder's `SKILL.md`, in any case: agy reads `SKILL.MD` too. */
function skillFileOf(folder: string): string | null {
  try {
    const file = readdirSync(folder).find((name) => name.toLowerCase() === 'skill.md')
    return file ? join(folder, file) : null
  } catch {
    return null
  }
}

/** `name` and `description` from the front matter's first lines; the rest of the file is not read. */
interface SkillFrontmatter {
  name: string | null
  description: string | null
}

function frontmatterOf(file: string): SkillFrontmatter {
  const buffer = Buffer.alloc(FRONTMATTER_BYTES)
  let length = 0
  try {
    const descriptor = openSync(file, 'r')
    try {
      length = readSync(descriptor, buffer, 0, FRONTMATTER_BYTES, 0)
    } finally {
      closeSync(descriptor)
    }
  } catch {
    return { name: null, description: null }
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(buffer.subarray(0, length).toString('utf8'))
  const field = (key: string) => {
    const value = match ? new RegExp(`^${key}:[ \\t]*(.+)$`, 'm').exec(match[1]!)?.[1]?.trim() : undefined
    return value ? value.replace(/^(['"])(.*)\1$/, '$2') || null : null
  }
  return { name: field('name'), description: field('description') }
}
