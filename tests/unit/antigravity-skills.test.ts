import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AGENT_PROFILE_ENTRIES, PROFILE_PROVIDERS, isAgentProfilePath } from '@solus/contracts/agent-profile'
import { antigravityProfileFilesHome, linkHostGeminiConfig, listAntigravitySkills } from '@solus/server/execution/agents/acp/antigravity-skills'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function root(): string {
  const directory = mkdtempSync(join(tmpdir(), 'agy-skills-'))
  roots.push(directory)
  return directory
}

function skill(folder: string, name: string, frontmatter: string, file = 'SKILL.md'): void {
  mkdirSync(join(folder, name), { recursive: true })
  writeFileSync(join(folder, name, file), `---\n${frontmatter}\n---\n\nBody.\n`)
}

describe('Antigravity skills in the slash menu', () => {
  test('a session lists its project’s skills first, then its profile’s, by the name agy uses', () => {
    const base = root()
    const project = join(base, 'project')
    const profile = join(base, 'profile')
    skill(join(project, '.gemini', 'skills'), 'review', 'name: review-pr\ndescription: "Review a pull request"')
    skill(join(project, '.agents', 'skills'), 'deploy', 'description: Deploy the app', 'SKILL.MD')
    skill(join(profile, 'config', 'skills'), 'notes', 'name: notes\ndescription: Keep notes')
    // A profile skill with a project skill's name is the project's.
    skill(join(profile, 'antigravity-cli', 'skills'), 'review-again', 'name: review-pr\ndescription: Shadowed')
    mkdirSync(join(project, '.agent', 'skills', 'empty'), { recursive: true })

    const commands = listAntigravitySkills(project, profile)
    expect(commands.project.map(({ name, description, kind }) => ({ name, description, kind }))).toEqual([
      { name: 'review-pr', description: 'Review a pull request', kind: 'skill' },
      { name: 'deploy', description: 'Deploy the app', kind: 'skill' },
    ])
    expect(commands.global.map((command) => command.name)).toEqual(['notes'])
  })

  test('the skills of each plugin agy loads follow the profile’s, and a plugin the person turned off has none', () => {
    const base = root()
    const profile = join(base, 'profile')
    const plugins = join(profile, 'config', 'plugins')
    skill(join(profile, 'config', 'skills'), 'notes', 'name: notes\ndescription: Keep notes')
    skill(join(plugins, 'figma', 'skills'), 'export', 'name: export-frames\ndescription: Export Figma frames')
    skill(join(plugins, 'old-plugin', 'skills'), 'legacy', 'name: legacy\ndescription: Off')
    // A plugin skill named as a profile skill is the profile's.
    skill(join(plugins, 'figma', 'skills'), 'notes-copy', 'name: notes\ndescription: Shadowed')
    writeFileSync(join(profile, 'config', 'config.json'), JSON.stringify({ plugins: { 'old-plugin': { enabled: false }, figma: { enabled: true } } }))

    const commands = listAntigravitySkills(join(base, 'project'), profile)
    expect(commands.global.map(({ name, description }) => ({ name, description }))).toEqual([
      { name: 'notes', description: 'Keep notes' },
      { name: 'export-frames', description: 'Export Figma frames' },
    ])
  })
})

describe('the host login’s Antigravity profile', () => {
  test('links the owner’s own ~/.gemini skills and rules, so the host login reads what agy reads in a terminal', () => {
    const base = root()
    const gemini = join(base, 'home', '.gemini')
    mkdirSync(join(gemini, 'config', 'skills'), { recursive: true })
    writeFileSync(join(gemini, 'GEMINI.md'), 'rules')
    const profile = join(base, 'profile')
    // agy made an empty folder at a start before the link existed.
    mkdirSync(join(profile, 'config', 'skills'), { recursive: true })

    linkHostGeminiConfig(profile, gemini)
    expect(readlinkSync(join(profile, 'config', 'skills'))).toBe(join(gemini, 'config', 'skills'))
    expect(readlinkSync(join(profile, 'GEMINI.md'))).toBe(join(gemini, 'GEMINI.md'))
    // Nothing to link where the person has nothing.
    expect(existsSync(join(profile, 'AGENTS.md'))).toBe(false)
  })

  test('never replaces a skills folder that holds the person’s files', () => {
    const base = root()
    const gemini = join(base, 'home', '.gemini')
    mkdirSync(join(gemini, 'config', 'skills'), { recursive: true })
    const profile = join(base, 'profile')
    skill(join(profile, 'config', 'skills'), 'mine', 'name: mine')

    linkHostGeminiConfig(profile, gemini)
    expect(lstatSync(join(profile, 'config', 'skills')).isSymbolicLink()).toBe(false)
    expect(existsSync(join(profile, 'config', 'skills', 'mine', 'SKILL.md'))).toBe(true)
  })
})

describe('Antigravity in the agent profile', () => {
  test('a person’s skills travel to Antigravity, into the folder agy reads, and nothing else does', () => {
    expect(PROFILE_PROVIDERS).toContain('antigravity')
    expect(AGENT_PROFILE_ENTRIES.antigravity).toEqual(['skills'])
    expect(isAgentProfilePath('antigravity', 'skills/review/SKILL.md')).toBe(true)
    expect(isAgentProfilePath('antigravity', 'settings.json')).toBe(false)
    expect(antigravityProfileFilesHome('/seats/antigravity/ada')).toBe('/seats/antigravity/ada/config')
  })
})
