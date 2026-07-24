import { createInterface } from 'node:readline'
import { open, readdir, stat as fsStat } from 'node:fs/promises'
import { createReadStream, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { ClaudeAgent, SAFE_TOOLS } from './claude-agent'
import { createSolusMcpServer } from '../../folio/work-tools'
import { codexSubagentSdkTool } from '../codex/codex-subagent-tool'
import { CodexSubagentEventBridge } from '../codex/codex-subagent-event-bridge'
import { PermissionManager } from './claude-permissions'
import { BaseAgentBackend } from '../base-backend'
import { encodePathAsFolder } from '../utils'
import { loadAllAnnotations } from '../../plans/annotations'
import { createLogger } from '../../logger'
import { getHeadCommit } from '../../git/worktree-manager'
import { resolveRepoRoot } from '../../git/git-helpers'
import { initSessionBase, snapshotTurn } from '../../git/session-snapshots'
import type { AgentBackend, RunHandle } from '../agent-backend'
import { MODEL_PROFILES, SOLUS_WORKTREE_ENCODED_MARKER } from '../../../shared/types'
import type {
  AgentId,
  AgentMetadata,
  AgentSlashCommand,
  IpcContext,
  NormalizedEvent,
  PlanDescriptor,
  PluginCommandsResult,
  PromptOptions,
  SessionMeta,
  SessionRunInput,
} from '../../../shared/types'
import type { ClaudeRunResult } from './claude-agent'
import type { SessionLoadMessage, SessionPreviewResult } from '../../../shared/session-history'
import {
  _sessionListCache,
  _sessionScanInFlight,
  parseJsonlLine,
  scanSessionsInDir,
} from './claude-session-helpers'
import {
  _planListCache,
  _planScanInFlight,
  scanPlansInDir,
  annotateScanned,
  groupBySession,
  type AnnotatedPlan,
} from './claude-plan-helpers'
import { _pluginCmdCache, PLUGIN_CMD_TTL, resolvePluginCommands } from './claude-plugin-helpers'
import { MemoryCache } from '../../../shared/cache'
import { runBounded } from '../../lib/concurrency'
import { buildSystemPrompt } from '../system-hint'
import { isWorkspacePath } from '../../workspace'
import { listIndexedSessions, sessionIndexReady } from '../../db/session-indexer'

const claudeProfiles = MODEL_PROFILES['claude-code'] ?? {}

const CLAUDE_METADATA: AgentMetadata = {
  id: 'claude-code',
  label: 'Claude Code',
  models: Object.entries(claudeProfiles).map(([id, p]) => ({ id, label: p.label })),
  defaultModel: Object.entries(claudeProfiles).find(([, p]) => p.isDefault)?.[0] ?? '',
  capabilities: {
    planMode: true,
    permissions: true,
    fileRewind: true,
    terminalResume: true,
    transport: 'claude-sdk/stream-json',
  },
}

const log = createLogger('ClaudeBackend', 'claude-backend.ts')

type TurnBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }

/**
 * Build the prompt input for a turn. With no images it's a plain string (single
 * message input, unchanged). With images it's a one-shot async generator
 * (streaming input mode) that yields a single user message carrying real text +
 * image content blocks, then returns — closing the stream so the SDK runs
 * exactly one turn. The base64 bytes already live in memory (from the renderer
 * preview), so the generator never touches the filesystem and can't throw.
 */
function buildPromptInput(
  text: string,
  images: Array<{ mimeType: string; dataUrl: string }> | undefined,
): string | AsyncIterable<SDKUserMessage> {
  if (!images || images.length === 0) return text

  const content: TurnBlock[] = []
  if (text) content.push({ type: 'text', text })
  for (const img of images) {
    const m = img.dataUrl.match(/^data:(.+?);base64,(.+)$/)
    if (!m) continue
    content.push({ type: 'image', source: { type: 'base64', media_type: img.mimeType || m[1], data: m[2] } })
  }
  // Every dataUrl was malformed — fall back to the plain text turn.
  if (!content.some((b) => b.type === 'image')) return text

  return (async function* (): AsyncGenerator<SDKUserMessage> {
    yield { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null } as SDKUserMessage
  })()
}

/** Cache of SDK-reported built-in commands, keyed by working directory.
 *  Stores promises so concurrent calls for the same cwd share one subprocess. */
const _builtinCmdCache = new MemoryCache<string, Promise<AgentSlashCommand[]>>({ ttlMs: PLUGIN_CMD_TTL })

export class ClaudeBackend extends BaseAgentBackend implements AgentBackend {
  readonly id: AgentId = 'claude-code'
  readonly metadata: AgentMetadata = CLAUDE_METADATA
  readonly permissions = new PermissionManager()

  private agent = new ClaudeAgent()

  constructor() {
    super()
    this.permissions.onPermissionEvent = (sessionId, event) => {
      const handle = sessionId ? this.activeRuns.get(sessionId) : this.pendingRuns[0]
      if (handle) handle.sawPermissionRequest = true
      // Use handle.sessionId (promoted after session_init) over the closure sessionId,
      // which is null for fresh sessions and would cause the control-plane to drop the event.
      this.emit('normalized', handle?.sessionId ?? sessionId, event)
    }
  }

  /** SDK-reported built-in commands for a working directory, fetched via a
   *  short-lived streaming query (the only mode that exposes `supportedCommands`)
   *  and cached per-cwd. No persistent session is kept. */
  private builtinCommands(ctx: IpcContext): Promise<AgentSlashCommand[]> {
    const cwd = ctx.session.workingDirectory
    const cached = _builtinCmdCache.get(cwd)
    if (cached) return cached

    const baseModel = ctx.statusBar.model
    const model = ctx.session.contextWindow === 1_000_000 ? `${baseModel}[1m]` : baseModel
    const promise = this.agent.supportedCommands({ cwd, model }).catch((e) => {
      _builtinCmdCache.delete(cwd)
      throw e
    })
    _builtinCmdCache.set(cwd, promise)
    return promise
  }

  startRun(input: SessionRunInput, options: PromptOptions): RunHandle {
    const abortController = new AbortController()
    const sessionId = input.agentSessionId
    const uiMode = input.permissionMode
    const sessionRef = { current: sessionId }
    const canUseTool = this.permissions.createCanUseTool(sessionRef, uiMode)

    let _resolveRun!: () => void
    let _rejectRun!: (err: Error) => void
    const runPromise = new Promise<void>((res, rej) => { _resolveRun = res; _rejectRun = rej })

    const handle: RunHandle = {
      sessionId,
      startedAt: Date.now(),
      toolCallCount: 0,
      sawPermissionRequest: false,
      permissionDenials: [],
      abortController,
      runPromise,
      _resolveRun,
      _rejectRun,
    }

    const workTree = input.gitContext?.worktreePath ?? input.workingDirectory
    const baseModel = input.model
    const model = input.contextWindow === 1_000_000 ? `${baseModel}[1m]` : baseModel
    const codexSubagentEvents = new CodexSubagentEventBridge()

    // In-process MCP server giving the agent list/read/create/update access to
    // works plus render_artifact. onWorkCreated/onWorkUpdated/onArtifact fire
    // mid-turn so the streaming card, open viewers, and the gallery live-update.
    const solusServer = createSolusMcpServer({
      onWorkCreated: (work) => {
        this.emit('normalized', handle.sessionId, {
          type: 'work_created',
          workId: work.workId,
          title: work.title,
          docType: work.docType,
          content: work.content,
        })
      },
      onWorkUpdated: (work) => {
        this.emit('normalized', handle.sessionId, {
          type: 'work_updated',
          workId: work.workId,
          title: work.title,
          docType: work.docType,
          content: work.content,
          updatedAt: work.updatedAt,
        })
      },
      onArtifact: (artifact) => {
        this.emit('normalized', handle.sessionId, {
          type: 'artifact_created',
          kind: 'html',
          html: artifact.html,
        })
      },
      onAutomationSaved: (automation) => {
        this.emit('normalized', handle.sessionId, {
          type: 'automation_saved',
          automationId: automation.id,
          name: automation.name,
          trigger: automation.trigger,
          enabled: automation.enabled,
        })
      },
      onSessionCreated: (created) => {
        this.emit('normalized', handle.sessionId, {
          type: 'session_created',
          agentSessionId: created.agentSessionId,
          title: created.title,
          provider: created.provider,
          cwd: created.cwd,
        })
      },
      onSessionPrompted: (prompted) => {
        this.emit('normalized', handle.sessionId, {
          type: 'session_prompted',
          agentSessionId: prompted.agentSessionId,
          promptPreview: prompted.promptPreview,
          provider: prompted.provider,
          cwd: prompted.cwd,
        })
      },
      onSessionStopped: (stopped) => {
        this.emit('normalized', handle.sessionId, {
          type: 'session_stopped',
          agentSessionId: stopped.agentSessionId,
          provider: stopped.provider,
          cwd: stopped.cwd,
        })
      },
      onTaskCreated: (task) => {
        this.emit('normalized', handle.sessionId, {
          type: 'task_created',
          taskId: task.taskId,
          title: task.title,
          url: task.url,
        })
      },
      createCtx: {
        agentProvider: 'claude-code',
        cwd: input.workingDirectory,
        sessionId: () => handle.sessionId ?? sessionRef.current ?? undefined,
      },
      includeAutomationTools: input.toolProfile !== 'automation',
      // Built here (outside the work-tools import cycle) with the run's worktree cwd
      // and abort signal, so stopping the session interrupts the Codex turn.
      codexSubagentTool: codexSubagentSdkTool({
        cwd: workTree,
        abortSignal: abortController.signal,
        claimParentToolUseId: (args) => codexSubagentEvents.claim(args),
        onEvent: (_parentToolUseId, event) => this.emit('normalized', handle.sessionId, event),
      }),
    })

    this.pendingRuns.push(handle)
    void (async () => {
      const general = isWorkspacePath(input.workingDirectory)
      const baseSystemPromptAppend = buildSystemPrompt({
        agent: 'claude',
        general,
        extraInstructions: input.extraInstructions,
        modelInstructions: input.modelInstructions,
        prReview: input.prReview,
      })
      const systemPromptAppend = !input.agentSessionId && input.handoff
        ? `${baseSystemPromptAppend}\n\n${input.handoff.seedSystemAppend}`
        : baseSystemPromptAppend

      const { events, result } = this.agent.run({
        prompt: buildPromptInput(options.prompt, options.imageAttachments),
        cwd: input.workingDirectory,
        sessionId,
        forkSession: input.forked,
        model,
        reasoningEffort: input.reasoningEffort,
        fastMode: input.fastMode,
        permissionMode: uiMode,
        additionalDirectories: input.additionalDirs,
        mcpServers: { 'solus': solusServer },
        // Reads + create + render are pre-approved; update_work falls through to the prompt.
        // Automation reads are pre-approved; mutating/triggering ones (create/update/delete/set_enabled/run) fall through to the permission prompt.
        // create_session is pre-approved — spawning a session is a first-class agent action.
        // codex_subagent is pre-approved like create_session — delegating to a Codex subagent is a first-class agent action.
        // Session/task reads are pre-approved; writes fall through to the prompt.
        allowedTools: [...SAFE_TOOLS, 'mcp__solus__list_works', 'mcp__solus__search_works', 'mcp__solus__read_work', 'mcp__solus__create_work', 'mcp__solus__render_artifact', 'mcp__solus__list_automations', 'mcp__solus__read_automation', 'mcp__solus__list_automation_runs', 'mcp__solus__read_automation_run', 'mcp__solus__create_session', 'mcp__solus__codex_subagent', 'mcp__solus__list_sessions', 'mcp__solus__read_session', 'mcp__solus__wait_for_session', 'mcp__solus__search_sessions', 'mcp__solus__get_task', 'mcp__solus__list_tasks', 'mcp__solus__list_prs', 'mcp__solus__read_pr', 'mcp__solus__list_pr_threads'],
        systemPromptAppend,
        maxTurns: options.maxTurns,
        maxBudgetUsd: options.maxBudgetUsd,
        canUseTool,
        enableFileCheckpointing: true,
        abortController,
        onSessionInit: async (sid) => {
          const repoRoot = await resolveRepoRoot(workTree)
          if (!repoRoot) return
          const head = getHeadCommit(workTree)
          if (!head) return
          await initSessionBase(repoRoot, sid, head)
        },
        onTurnComplete: async (sid, snapOpts) => {
          const repoRoot = await resolveRepoRoot(workTree)
          if (!repoRoot) return null
          const result = await snapshotTurn(workTree, repoRoot, sid, {
            ...snapOpts,
            sessionChangedFiles: [...new Set([...input.sessionChangedFiles, ...snapOpts.editedFiles])],
          })
          return result?.sessionChangedFiles ?? null
        },
      })

      await this._runLoop(handle, events, result, sessionRef, codexSubagentEvents)
    })().catch((err: any) => {
      const sessionId = handle.sessionId
      log.error(`Run failed to start [${sessionId ?? 'pending'}]: ${err?.message}`)
      this.finishRun(handle)
      handle._rejectRun(err instanceof Error ? err : new Error(String(err)))
      this.emit('error', sessionId, err instanceof Error ? err : new Error(String(err)))
    })
    return handle
  }

  private async _runLoop(
    handle: RunHandle,
    events: AsyncIterable<NormalizedEvent>,
    result: Promise<ClaudeRunResult>,
    sessionRef: { current: string | null },
    codexSubagentEvents?: CodexSubagentEventBridge,
  ): Promise<void> {
    try {
      for await (const evt of events) {
        codexSubagentEvents?.observe(evt)
        if (evt.type === 'session_init') {
          this.promoteToActive(handle, evt.sessionId)
          sessionRef.current = evt.sessionId
        }

        this.emit('normalized', handle.sessionId, evt)
      }

      const final = await result
      handle.sessionId = final.sessionId
      handle.toolCallCount = final.toolCallCount
      handle.permissionDenials = final.permissionDenials
      const sessionId = handle.sessionId
      this.finishRun(handle)
      log.info(`Run complete [${sessionId}]: denials=${handle.permissionDenials.length}`)
      handle._resolveRun()
      this.emit('exit', sessionId, final.signal === 'SIGINT' ? null : 0, final.signal)
    } catch (err: any) {
      const sessionId = handle.sessionId
      log.error(`Run errored [${sessionId ?? 'pending'}]: ${err?.message}`)
      this.finishRun(handle)
      handle._rejectRun(err instanceof Error ? err : new Error(String(err)))
      this.emit('error', sessionId, err instanceof Error ? err : new Error(String(err)))
    }
  }

  override cancelSession(sessionId: string): boolean {
    log.info(`Cancelling session ${sessionId}`)
    return super.cancelSession(sessionId)
  }

  rewindFiles(sessionId: string, checkpointId: string, projectPath: string): Promise<void> {
    return this.agent.rewindFiles(sessionId, checkpointId, projectPath)
  }

  async listSessions(projectPath?: string, onBatch?: (sessions: SessionMeta[]) => void, limit?: number): Promise<SessionMeta[]> {
    const cwd = projectPath || process.cwd()
    const encodedPath = encodePathAsFolder(cwd)
    const cacheKey = encodedPath + ':with-worktrees'

    const projectsRoot = join(homedir(), '.claude', 'projects')
    const mainDir = join(projectsRoot, encodedPath)

    const dirsToScan: { path: string; encodedPath: string; isWorktree: boolean; }[] = [
      { path: mainDir, encodedPath, isWorktree: false },
    ]
    if (existsSync(projectsRoot)) {
      const worktreeDirs = (await readdir(projectsRoot))
        .filter((d) => d.startsWith(encodedPath + SOLUS_WORKTREE_ENCODED_MARKER))
      for (const wtDir of worktreeDirs) {
        dirsToScan.push({ path: join(projectsRoot, wtDir), encodedPath: wtDir, isWorktree: true })
      }
    }

    if (sessionIndexReady()) {
      const sessions = listIndexedSessions(dirsToScan.map((dir) => dir.encodedPath), limit)
      onBatch?.(sessions)
      return sessions
    }

    let currentMaxMtime = 0
    for (const dir of dirsToScan) {
      try {
        const s = await fsStat(dir.path)
        currentMaxMtime = Math.max(currentMaxMtime, s.mtimeMs)
      } catch {
        // directory doesn't exist yet; treat mtime as 0
      }
    }

    const cached = _sessionListCache.get(cacheKey)
    if (cached && cached.latestDirMtime === currentMaxMtime) {
      const sessions = limit === undefined ? cached.sessions : cached.sessions.slice(0, limit)
      onBatch?.(sessions)
      return sessions
    }

    // Dedup concurrent cold scans of the same project. When two callers (e.g. the
    // pill and editor windows at launch) miss the cache at once, the first drives
    // the scan and its streaming batches; later callers await the same promise and
    // still get the full list from its return value — the history store treats the
    // RPC result as authoritative, so they only forgo the incremental `onBatch`
    // stream, not the data.
    const inFlight = _sessionScanInFlight.get(cacheKey)
    if (inFlight) {
      const sessions = await inFlight
      return limit === undefined ? sessions : sessions.slice(0, limit)
    }

    const scan = (async () => {
      const scanTasks = dirsToScan.map((d) => scanSessionsInDir(d.path, d.encodedPath, cwd, d.isWorktree, onBatch ? (s) => onBatch([s]) : undefined))
      const results = await Promise.all(scanTasks)
      const sessions = results.flat()
      sessions.sort((a, b) => new Date(b.lastTimestamp).getTime() - new Date(a.lastTimestamp).getTime())
      _sessionListCache.set(cacheKey, { sessions, latestDirMtime: currentMaxMtime })
      return sessions
    })()
    _sessionScanInFlight.set(cacheKey, scan)
    try {
      const sessions = await scan
      return limit === undefined ? sessions : sessions.slice(0, limit)
    } finally {
      _sessionScanInFlight.delete(cacheKey)
    }
  }

  async loadSession(sessionId: string, projectPath?: string, limit?: number): Promise<SessionLoadMessage[]> {
    const folderName = projectPath?.startsWith('-')
      ? projectPath
      : encodePathAsFolder(projectPath || process.cwd())
    const filePath = join(homedir(), '.claude', 'projects', folderName, `${sessionId}.jsonl`)
    if (!existsSync(filePath)) return []

    if (limit && limit > 0) return this.loadSessionWindow(filePath, limit)

    const messages: SessionLoadMessage[] = []
    await new Promise<void>((resolve) => {
      const rl = createInterface({ input: createReadStream(filePath) })
      rl.on('line', (line: string) => {
        const msg = parseJsonlLine(line)
        if (msg) messages.push(msg)
      })
      rl.on('close', () => resolve())
    })
    return messages
  }


  /**
   * Read only the tail of a transcript: enough bytes to yield the last `limit`
   * messages without parsing the whole (potentially multi-MB) file. Grows the
   * read window until it captures more than `limit` messages or reaches the start
   * of the file. A returned length of exactly `limit` signals to the caller that
   * older messages exist on disk (they can be fetched later via an unbounded load).
   */
  private async loadSessionWindow(filePath: string, limit: number): Promise<SessionLoadMessage[]> {
    const TAIL_WINDOW_BYTES = 512 * 1024
    const fh = await open(filePath, 'r')
    try {
      const { size } = await fh.stat()
      if (size === 0) return []
      let windowBytes = Math.min(size, TAIL_WINDOW_BYTES)
      while (true) {
        const from = size - windowBytes
        const buf = Buffer.allocUnsafe(windowBytes)
        await fh.read(buf, 0, windowBytes, from)
        let text = buf.toString('utf8')
        // When we start mid-file the first line is a fragment of a larger JSON
        // object — drop everything up to the first newline.
        if (from > 0) {
          const nl = text.indexOf('\n')
          text = nl >= 0 ? text.slice(nl + 1) : ''
        }
        const messages: SessionLoadMessage[] = []
        for (const line of text.split('\n')) {
          if (!line) continue
          const msg = parseJsonlLine(line)
          if (msg) messages.push(msg)
        }
        // Enough to fill the window, or we've already read the whole file.
        if (messages.length > limit || from <= 0) {
          return messages.length > limit ? messages.slice(-limit) : messages
        }
        windowBytes = Math.min(size, windowBytes * 4)
      }
    } finally {
      await fh.close()
    }
  }

  async loadSessionPreview(sessionId: string, projectPath?: string): Promise<SessionPreviewResult> {
    const folderName = projectPath?.startsWith('-')
      ? projectPath
      : encodePathAsFolder(projectPath || process.cwd())
    const filePath = join(homedir(), '.claude', 'projects', folderName, `${sessionId}.jsonl`)
    if (!existsSync(filePath)) return { head: [], tail: [], totalMessages: 0 }

    const HEAD_PREVIEW_BYTES = 16384
    const TAIL_PREVIEW_BYTES = 8192
    const MAX_HEAD_MESSAGES = 4

    const fh = await open(filePath, 'r')
    try {
      const fileStat = await fh.stat()
      if (fileStat.size < 100) return { head: [], tail: [], totalMessages: 0 }

      const headSize = Math.min(HEAD_PREVIEW_BYTES, fileStat.size)
      const headBuf = Buffer.allocUnsafe(headSize)
      await fh.read(headBuf, 0, headSize, 0)

      const headLines = headBuf.toString('utf8').split('\n').filter(Boolean)
      const head: SessionLoadMessage[] = []
      let totalLines = 0
      for (const line of headLines) {
        totalLines++
        if (head.length >= MAX_HEAD_MESSAGES) continue
        const msg = parseJsonlLine(line)
        if (msg && (msg.role === 'user' || msg.role === 'assistant')) head.push(msg)
      }

      const tail: SessionLoadMessage[] = []
      const tailStart = Math.max(headSize, fileStat.size - TAIL_PREVIEW_BYTES)
      if (tailStart < fileStat.size) {
        const tailSize = fileStat.size - tailStart
        const tailBuf = Buffer.allocUnsafe(tailSize)
        await fh.read(tailBuf, 0, tailSize, tailStart)

        const tailLines = tailBuf.toString('utf8').split('\n').filter(Boolean)
        for (let i = tailLines.length - 1; i >= 0; i--) {
          const msg = parseJsonlLine(tailLines[i])
          if (msg && msg.role === 'assistant') {
            tail.push(msg)
            break
          }
        }
      }

      const avgLineSize = headSize / Math.max(totalLines, 1)
      const totalMessages = avgLineSize > 0 ? Math.round(fileStat.size / avgLineSize) : totalLines

      return { head, tail, totalMessages }
    } finally {
      await fh.close()
    }
  }

  async listPlans(projectPath: string | undefined, allProjects: boolean): Promise<PlanDescriptor[]> {
    const cacheKey = `${allProjects ? 'all' : projectPath || process.cwd()}`
    const cached = _planListCache.get(cacheKey)
    if (cached) return cached

    const projectsRoot = join(homedir(), '.claude', 'projects')
    if (!existsSync(projectsRoot)) return []

    // Dedup concurrent cold plan scans of the same scope, exactly as listSessions
    // does: the pill and editor windows both fire listPlans at launch, and each
    // walks every project's transcripts. Share one scan; later callers await it.
    const inFlight = _planScanInFlight.get(cacheKey)
    if (inFlight) return inFlight

    const scan = (async () => {
      const annotationIndex = await loadAllAnnotations()
      const allScanned: AnnotatedPlan[] = []

      if (allProjects) {
        const dirs = await readdir(projectsRoot)
        const tasks = dirs.map((dir) => async () => {
          const full = join(projectsRoot, dir)
          try {
            if (!(await fsStat(full)).isDirectory()) return
          } catch {
            return
          }
          const fallbackCwd = dir.startsWith('-') ? dir.replaceAll('-', '/') : dir
          const scanned = await scanPlansInDir(full, dir, fallbackCwd)
          for (const s of scanned) allScanned.push(annotateScanned(s, annotationIndex))
        })
        await runBounded(tasks, 8)
      } else {
        const cwd = projectPath || process.cwd()
        const encodedPath = encodePathAsFolder(cwd)
        const mainDir = join(projectsRoot, encodedPath)
        const scanned = await scanPlansInDir(mainDir, encodedPath, cwd)
        for (const s of scanned) allScanned.push(annotateScanned(s, annotationIndex))

        const worktreePrefix = encodedPath + SOLUS_WORKTREE_ENCODED_MARKER
        const worktreeDirs = (await readdir(projectsRoot)).filter((d: string) => d.startsWith(worktreePrefix))
        const tasks = worktreeDirs.map((wt) => async () => {
          const wtScanned = await scanPlansInDir(join(projectsRoot, wt), wt, cwd)
          for (const s of wtScanned) allScanned.push(annotateScanned(s, annotationIndex))
        })
        await runBounded(tasks, 8)
      }

      const descriptors = groupBySession(allScanned)
      descriptors.sort((a, b) => b.timestamp - a.timestamp)
      _planListCache.set(cacheKey, descriptors)
      return descriptors
    })()
    _planScanInFlight.set(cacheKey, scan)
    try {
      return await scan
    } finally {
      _planScanInFlight.delete(cacheKey)
    }
  }

  async loadPlanContent(sessionId: string, projectPath: string, planToolUseId: string): Promise<string | null> {
    const folderName = projectPath.startsWith('-') ? projectPath : encodePathAsFolder(projectPath)
    const filePath = join(homedir(), '.claude', 'projects', folderName, `${sessionId}.jsonl`)
    if (!existsSync(filePath)) return null

    let content: string | null = null
    await new Promise<void>((resolve) => {
      const rl = createInterface({ input: createReadStream(filePath) })
      rl.on('line', (line: string) => {
        if (content) return
        try {
          const obj = JSON.parse(line)
          if (obj.type !== 'assistant') return
          const blocks = obj.message?.content
          if (!Array.isArray(blocks)) return
          for (const block of blocks) {
            if (block?.type === 'tool_use' && block?.name === 'ExitPlanMode' && block.id === planToolUseId) {
              content = block.input?.plan || ''
              rl.close()
              return
            }
          }
        } catch {}
      })
      rl.on('close', () => resolve())
    })
    return content
  }

  async listPluginCommands(workingDirectory: string, ctx?: IpcContext): Promise<PluginCommandsResult> {
    const cacheKey = `claude-code:${workingDirectory}`
    let result = _pluginCmdCache.get(cacheKey)
    if (!result) {
      result = await resolvePluginCommands(workingDirectory)
      _pluginCmdCache.set(cacheKey, result)
    }

    // Built-in commands come live from the warm session — fetched fresh (not
    // cached) so the session is warmed and the list reflects the current tab.
    if (!ctx) return result
    const builtin = await this.builtinCommands(ctx).catch((e) => {
      log.warn(`builtinCommands failed: ${e}`)
      return [] as AgentSlashCommand[]
    })
    return { ...result, builtin }
  }

  async refreshPluginCommands(): Promise<void> {
    _pluginCmdCache.clear()
    _builtinCmdCache.clear()
  }
}
