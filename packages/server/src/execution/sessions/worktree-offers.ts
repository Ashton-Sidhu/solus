import { realpath } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { z } from 'zod'
import type { Activity, ActivityKind, WorktreeOfferResolution } from '@solus/contracts/activity'
import type { ExecutionPreferences } from '@solus/contracts/settings'
import type { NormalizedEvent } from '@solus/contracts/types'
import type { Actor } from '../../admission/actor'
import { runAsync } from '../../git/exec'
import { resolveRepoRoot } from '../../git/git-helpers'
import { createLogger } from '../../logger'
import { resolveHomePath } from '../../platform/paths'
import { linkedWorktrees, worktreeOfRepository, type WorktreeMover } from './worktree-move'

const log = createLogger('worktree', 'worktree-offers.ts')

/**
 * Finds the agent working in a worktree the session is not bound to, and
 * offers the user a switch (docs/worktree-names.md, "Agent worktrees"). Solus does
 * not block the agent: Claude's `EnterWorktree` and a shell `git worktree add`
 * run as usual. When one succeeds, Solus asks git for the worktree, and records
 * a `worktree_offered` activity that the conversation draws as a card. The
 * answer is a `worktree_offer_decided` activity, so every client and every
 * reload shows the same state.
 */

/** Claude's tool, Claude's shell, and Codex's shell. */
const WATCHED_TOOLS = new Set(['EnterWorktree', 'Bash', 'exec_command'])

interface WatchedCall {
  toolName: string
  input: string
}

interface Offer {
  path: string
  resolution?: WorktreeOfferResolution
  deciding?: Promise<WorktreeOfferResolution>
}

export interface WorktreeOffersDeps {
  mover: WorktreeMover
  recordActivity(sessionId: string, actor: Actor, kind: ActivityKind): Promise<Activity>
  /** The session's stored activity, oldest first. */
  sessionActivity(sessionId: string): Promise<Activity[]>
  hostActor: Actor
}

export class WorktreeOffers {
  /** Watched tool calls in flight, by session and tool id. */
  private readonly calls = new Map<string, WatchedCall>()
  /** Claude reports a tool's input by content-block index, not by tool id. */
  private readonly toolIdByIndex = new Map<string, string>()
  /** Offers per session, read from the activity record once. */
  private readonly offers = new Map<string, Promise<Map<string, Offer>>>()
  /** One check at a time per session, so one worktree is offered once. */
  private readonly checks = new Map<string, Promise<void>>()

  constructor(private readonly deps: WorktreeOffersDeps) {}

  /** Watch one broadcast session event. A sub-agent's tools work elsewhere. */
  observe(sessionId: string, event: NormalizedEvent): void {
    if ('parentToolUseId' in event && event.parentToolUseId) return
    if (event.type === 'tool_call') this.onToolCall(sessionId, event)
    else if (event.type === 'tool_call_complete') this.onToolComplete(sessionId, event)
    else if (event.type === 'tool_result') this.onToolResult(sessionId, event)
    else if (event.type === 'turn_settled') this.forgetCalls(sessionId)
  }

  private onToolCall(sessionId: string, event: Extract<NormalizedEvent, { type: 'tool_call' }>): void {
    if (!WATCHED_TOOLS.has(event.toolName)) return
    this.calls.set(callKey(sessionId, event.toolId), { toolName: event.toolName, input: event.toolInput ?? '' })
    this.toolIdByIndex.set(callKey(sessionId, String(event.index)), event.toolId)
  }

  private onToolComplete(sessionId: string, event: Extract<NormalizedEvent, { type: 'tool_call_complete' }>): void {
    const toolId = event.toolId ?? this.toolIdByIndex.get(callKey(sessionId, String(event.index)))
    const call = toolId ? this.calls.get(callKey(sessionId, toolId)) : undefined
    if (!toolId || !call) return
    if (event.toolInput) call.input = event.toolInput
    // Without an outcome Claude only finished the input; its result follows.
    if (!event.outcome && event.completedAtMs === undefined) return
    this.calls.delete(callKey(sessionId, toolId))
    if (succeeded(event.outcome)) this.check(sessionId, call, '')
  }

  private onToolResult(sessionId: string, event: Extract<NormalizedEvent, { type: 'tool_result' }>): void {
    const call = this.calls.get(callKey(sessionId, event.toolUseId))
    if (!call) return
    this.calls.delete(callKey(sessionId, event.toolUseId))
    if (!event.isError) this.check(sessionId, call, event.content)
  }

  /** Wait for the checks started so far. For tests and orderly shutdown. */
  async settled(sessionId: string): Promise<void> {
    await this.checks.get(sessionId)
  }

  /**
   * Answer an offer. `switch` moves the session through the same path as the
   * `move_to_worktree` tool. An answered offer returns its answer; a failed
   * switch can be answered again.
   */
  async decide(
    sessionId: string,
    offerId: string,
    decision: 'switch' | 'keep',
    actor: Actor,
    request: { cwd: string; preferences?: ExecutionPreferences },
  ): Promise<WorktreeOfferResolution> {
    const offer = (await this.offersFor(sessionId)).get(offerId)
    if (!offer) throw new Error('This worktree offer no longer exists.')
    if (offer.resolution && offer.resolution.decision !== 'failed') return offer.resolution
    if (offer.deciding) return offer.deciding
    offer.deciding = (async () => {
      let resolution: WorktreeOfferResolution = { decision: 'kept' }
      if (decision === 'switch') {
        const moved = await this.deps.mover.move({
          sessionId,
          cwd: request.cwd,
          target: { kind: 'existing', path: offer.path },
          actor,
          preferences: request.preferences,
        })
        resolution = moved.success ? { decision: 'switched' } : { decision: 'failed', error: moved.error ?? 'The switch failed.' }
      }
      await this.deps.recordActivity(sessionId, actor, { kind: 'worktree_offer_decided', offerId, resolution })
      offer.resolution = resolution
      return resolution
    })().finally(() => { offer.deciding = undefined })
    return offer.deciding
  }

  private check(sessionId: string, call: WatchedCall, result: string): void {
    const previous = this.checks.get(sessionId) ?? Promise.resolve()
    const next = previous
      .then(() => this.offerFor(sessionId, call, result))
      .catch((error) => log.warn('worktree_offer_check_failed', { sessionId, error: error instanceof Error ? error.message : String(error) }))
    this.checks.set(sessionId, next)
    void next.finally(() => { if (this.checks.get(sessionId) === next) this.checks.delete(sessionId) })
  }

  private async offerFor(sessionId: string, call: WatchedCall, result: string): Promise<void> {
    const bound = this.deps.mover.boundDirectory(sessionId, '')
    if (!bound) return
    const worktree = await this.detectedWorktree(bound, call, result)
    if (!worktree || worktree === await realpath(bound).catch(() => null)) return
    const offers = await this.offersFor(sessionId)
    // One card per worktree: a pending, kept, or failed offer already speaks for it.
    for (const offer of offers.values()) {
      if (offer.path === worktree && offer.resolution?.decision !== 'switched') return
    }
    const branch = await runAsync('git', ['branch', '--show-current'], worktree).catch(() => '')
    const kind: Extract<ActivityKind, { kind: 'worktree_offered' }> = { kind: 'worktree_offered', path: worktree }
    if (branch) kind.branch = branch
    const activity = await this.deps.recordActivity(sessionId, this.deps.hostActor, kind)
    offers.set(activity.id, { path: worktree })
    log.info('worktree_offered', { sessionId, offerId: activity.id, worktreePath: worktree, toolName: call.toolName })
  }

  /** The verified worktree a successful call entered or created, or null. */
  private async detectedWorktree(bound: string, call: WatchedCall, result: string): Promise<string | null> {
    if (call.toolName === 'EnterWorktree') {
      // The result names the worktree's path. Pick the worktree git lists, not the text.
      const worktrees = await linkedWorktrees(bound)
      const named = worktrees.find((worktree) => result.includes(worktree))
      if (named) return named
      const name = enterWorktreeName(call.input)
      const repoRoot = name ? await resolveRepoRoot(bound) : null
      return repoRoot && name ? worktreeOfRepository(bound, join(repoRoot, '.claude', 'worktrees', name)) : null
    }
    for (const path of worktreeAddPaths(shellCommand(call.input), bound)) {
      const worktree = await worktreeOfRepository(bound, path)
      if (worktree) return worktree
    }
    return null
  }

  private offersFor(sessionId: string): Promise<Map<string, Offer>> {
    let offers = this.offers.get(sessionId)
    if (!offers) {
      offers = this.deps.sessionActivity(sessionId).then(offersFromActivity)
      offers.catch(() => this.offers.delete(sessionId))
      this.offers.set(sessionId, offers)
    }
    return offers
  }

  private forgetCalls(sessionId: string): void {
    const prefix = callKey(sessionId, '')
    for (const key of this.calls.keys()) if (key.startsWith(prefix)) this.calls.delete(key)
    for (const key of this.toolIdByIndex.keys()) if (key.startsWith(prefix)) this.toolIdByIndex.delete(key)
  }
}

type ToolOutcome = Extract<NormalizedEvent, { type: 'tool_call_complete' }>['outcome']

function succeeded(outcome: ToolOutcome): boolean {
  if (!outcome) return true
  if (outcome.error || outcome.declined || (outcome.exitCode ?? 0) !== 0) return false
  return outcome.status !== 'failed' && outcome.status !== 'declined'
}

function callKey(sessionId: string, id: string): string {
  return `${sessionId}\u0000${id}`
}

/** The offers a session's activity holds, with the answers given so far. */
export function offersFromActivity(activity: readonly Activity[]): Map<string, Offer> {
  const offers = new Map<string, Offer>()
  for (const row of activity) {
    if (row.kind === 'worktree_offered') offers.set(row.id, { path: row.path })
    else if (row.kind === 'worktree_offer_decided') {
      const offer = offers.get(row.offerId)
      if (offer) offer.resolution = row.resolution
    }
  }
  return offers
}

const commandInputSchema = z.object({ command: z.string() })
const enterWorktreeInputSchema = z.object({ name: z.string().min(1) })

/** `text` read as JSON of `schema`'s shape, or null. */
function parsedJson<T>(schema: z.ZodType<T>, text: string): T | null {
  try {
    const parsed = schema.safeParse(JSON.parse(text))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/** Claude's Bash input is JSON with a `command`; Codex sends the command itself. */
function shellCommand(input: string): string {
  return parsedJson(commandInputSchema, input)?.command ?? input
}

function enterWorktreeName(input: string): string | null {
  const name = parsedJson(enterWorktreeInputSchema, input)?.name
  // A name is a single directory name. Anything else is not trusted.
  return name && basename(name) === name ? name : null
}

type ShellToken = { word: string } | { operator: string }

/** Split a shell command into words and control operators. Quotes and
 *  backslashes are read as a POSIX shell reads them; nothing is expanded. */
function shellTokens(command: string): ShellToken[] {
  const tokens: ShellToken[] = []
  let word: string | null = null
  const push = () => { if (word !== null) tokens.push({ word }); word = null }
  let index = 0
  while (index < command.length) {
    const char = command[index]
    if (char === ' ' || char === '\t') {
      push()
      index++
    } else if (CONTROL_CHARACTERS.has(char)) {
      push()
      const pair = command.slice(index, index + 2)
      const operator = pair === '&&' || pair === '||' ? pair : char
      tokens.push({ operator })
      index += operator.length
    } else {
      const [text, next] = wordPart(command, index)
      word = (word ?? '') + text
      index = next
    }
  }
  push()
  return tokens
}

const CONTROL_CHARACTERS = new Set(['\n', ';', '&', '|'])

/** One quoted run, escaped character, or plain character from `index`, and the index after it. */
function wordPart(command: string, index: number): [string, number] {
  const char = command[index]
  if (char === "'") {
    const end = command.indexOf("'", index + 1)
    const stop = end === -1 ? command.length : end
    return [command.slice(index + 1, stop), stop + 1]
  }
  if (char === '"') return doubleQuoted(command, index + 1)
  if (char === '\\' && index + 1 < command.length) return [command[index + 1], index + 2]
  return [char, index + 1]
}

/** A double-quoted run that starts at `index`: `\` escapes only `"`, `\`, `$`, and a backtick. */
function doubleQuoted(command: string, index: number): [string, number] {
  let text = ''
  while (index < command.length && command[index] !== '"') {
    if (command[index] === '\\' && '"\\$`'.includes(command[index + 1] ?? '')) index++
    text += command[index]
    index++
  }
  return [text, index + 1]
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'fish'])
/** `git worktree add` options that take a value. */
const ADD_VALUE_OPTIONS = new Set(['-b', '-B', '--reason'])
/** Git's own options that take a value, before the subcommand. */
const GIT_VALUE_OPTIONS = new Set(['-c', '--git-dir', '--work-tree', '--namespace', '--exec-path'])

/**
 * The paths a shell command creates worktrees at with `git worktree add`, made
 * absolute from `cwd`. A `cd` earlier in the command, `git -C`, and a shell
 * started with `-c` are followed. These are candidates only: a caller asks git
 * whether each is a worktree of the session's repository.
 */
export function worktreeAddPaths(command: string, cwd: string): string[] {
  const paths: string[] = []
  let directory = cwd
  let words: string[] = []
  const finish = () => {
    if (words.length) directory = readSimpleCommand(words, directory, paths)
    words = []
  }
  for (const token of shellTokens(command)) {
    if ('operator' in token) finish()
    else words.push(token.word)
  }
  finish()
  return paths
}

/** Read one simple command; returns the directory the next command runs in. */
function readSimpleCommand(words: string[], directory: string, paths: string[]): string {
  let start = 0
  while (start < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[start])) start++
  const argv = words.slice(start)
  const program = argv[0] ? basename(argv[0]) : ''
  if (program === 'cd') return argv[1] && argv[1] !== '-' ? absolutePath(argv[1], directory) : directory
  if (SHELLS.has(program)) {
    const script = argv.findIndex((word, index) => index > 0 && /^-[a-z]*c[a-z]*$/.test(word))
    if (script !== -1 && argv[script + 1]) paths.push(...worktreeAddPaths(argv[script + 1], directory))
  } else if (program === 'git') {
    const path = gitWorktreeAddPath(argv, directory)
    if (path) paths.push(path)
  }
  return directory
}

/** The path a `git … worktree add …` command creates its worktree at, or null. */
function gitWorktreeAddPath(argv: string[], directory: string): string | null {
  let gitDirectory = directory
  let index = 1
  for (; index < argv.length && argv[index].startsWith('-'); index++) {
    if (argv[index] === '-C' && argv[index + 1]) gitDirectory = absolutePath(argv[++index], gitDirectory)
    else if (GIT_VALUE_OPTIONS.has(argv[index])) index++
  }
  if (argv[index] !== 'worktree' || argv[index + 1] !== 'add') return null
  const path = argv[firstAddOperand(argv, index + 2)]
  return path ? absolutePath(path, gitDirectory) : null
}

/** The index of `git worktree add`'s first operand, after its options. */
function firstAddOperand(argv: string[], index: number): number {
  for (; index < argv.length; index++) {
    const word = argv[index]
    if (word === '--') return index + 1
    if (!word.startsWith('-') || word === '-') return index
    if (ADD_VALUE_OPTIONS.has(word)) index++
  }
  return index
}

function absolutePath(path: string, from: string): string {
  const expanded = path === '~' || path.startsWith('~/') ? resolveHomePath(path) : path
  return isAbsolute(expanded) ? expanded : resolve(from, expanded)
}
