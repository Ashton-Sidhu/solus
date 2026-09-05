import { beforeAll, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

let solusToolbox: typeof import('@solus/server/agents/tools/solus-toolbox')['solusToolbox']
let adaptClaudeTools: typeof import('@solus/server/agents/claude/claude-tool-adapter')['adaptClaudeTools']

beforeAll(async () => {
  ;({ solusToolbox } = await import('@solus/server/agents/tools/solus-toolbox'))
  ;({ adaptClaudeTools } = await import('@solus/server/agents/claude/claude-tool-adapter'))
})

const SKILL_PATH = join(
  import.meta.dir,
  '../../resources/plugins/solus/skills/visual-artifacts/SKILL.md',
)

function skillFrontmatterDescription(): string {
  const skill = readFileSync(SKILL_PATH, 'utf8')
  const match = /^description:\s*(.+)$/m.exec(skill)
  if (!match) throw new Error('visual-artifacts SKILL.md has no frontmatter description')
  return match[1]
}

/**
 * Solus writes no system prompt of its own. Everything the agent knows about
 * rendering HTML in Solus rides a tool description or the skill, so these
 * strings are the feature's contract with the model and get tests the way a
 * contract does.
 */
describe('HTML guidance without a system prompt', () => {
  test('render_artifact tells the agent a fence renders live, and how to force it either way', () => {
    // WHY: the agent decides between a fence and a tool call before it calls
    // anything. If the description does not say a fence renders, every visual
    // reply becomes a tool call, or worse, plain text.
    const description = solusToolbox.artifact.render.description
    expect(description).toContain('```html')
    expect(description).toContain('```html render')
    expect(description).toContain('```html source')
  })

  test('the tools carrying guidance are never deferred behind tool search', () => {
    // WHY: Claude Code defers MCP tool descriptions by default. A deferred tool
    // is a bare name in the prompt, and a bare name carries no rule.
    expect(solusToolbox.artifact.render.alwaysLoad).toBe(true)
    expect(solusToolbox.works.create.alwaysLoad).toBe(true)
    expect(solusToolbox.works.update.alwaysLoad).toBe(true)
    // Tools with no guidance stay deferrable, so the prompt does not grow by
    // sixty descriptions to keep three.
    expect(solusToolbox.works.list.alwaysLoad).toBeFalsy()
  })

  test('the Claude adapter passes alwaysLoad through to the SDK tool', () => {
    const { server } = adaptClaudeTools(
      [solusToolbox.artifact.render, solusToolbox.works.list],
      {
        provider: 'claude-code',
        cwd: '/tmp',
        sessionId: () => undefined,
        solusSessionId: () => undefined,
        abortSignal: new AbortController().signal,
        parentToolUseId: () => undefined,
        emit: () => {},
      },
      'auto',
    )
    // SAFETY: `_registeredTools` is the MCP server's private registry, keyed
    // by tool name, and `_meta` is where the SDK writes the flag. Reading it is
    // the only way to see what the CLI will be told without spawning one.
    interface RegisteredToolMeta {
      _meta?: { 'anthropic/alwaysLoad'?: boolean }
    }
    const registry = (server.instance as unknown as {
      _registeredTools: { render_artifact?: RegisteredToolMeta; list_works?: RegisteredToolMeta }
    })._registeredTools
    expect(registry.render_artifact?._meta?.['anthropic/alwaysLoad']).toBe(true)
    expect(registry.list_works?._meta?.['anthropic/alwaysLoad']).toBeUndefined()
  })

  test('the skill description names the fence path before its body is loaded', () => {
    // WHY: the frontmatter description is listed on every turn; the body is
    // not. The routing decision has to be visible in the part that is.
    const description = skillFrontmatterDescription()
    expect(description).toContain('```html')
    expect(description).toContain('render_artifact')
  })

  test('the skill body never makes the tool call unconditional', () => {
    // WHY: an earlier draft said "call render_artifact as your LAST step" in
    // three places while also saying a fence is often right. Two rules that
    // disagree are no rule.
    const skill = readFileSync(SKILL_PATH, 'utf8')
    expect(skill).not.toMatch(/As your LAST step, call/)
    expect(skill).not.toContain('do not have a stable update id')
    expect(skill).not.toContain('Do not fetch data at view time')
  })
})
