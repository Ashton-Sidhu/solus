import { createInterface } from 'node:readline'
import { open, readdir, stat as fsStat } from 'node:fs/promises'
import { createReadStream, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { ClaudeAgent, SAFE_TOOLS } from './claude-agent'
import { TurnInputChannel } from './claude-turn-input'
import { adaptClaudeTools } from './claude-tool-adapter'
import { PermissionManager } from './claude-permissions'
import { BaseAgentBackend } from '../base-backend'
import { encodePathAsFolder } from '../utils'
import { loadAllAnnotations } from '../../plans/annotations'
import {
  isPlanIndexComplete,
  listIndexedPlans,
  loadIndexedPlanContent,
  replaceIndexedPlansForProvider,
  type IndexedPlanInput,
} from '../../plans/plan-index'
import { createLogger } from '../../logger'
import { resolveHomePath } from '../../platform/paths'
import { getHeadCommit } from '../../git/worktree-manager'
import { resolveRepoRoot } from '../../git/git-helpers'
import { initSessionBase, prepareTurnSnapshot, snapshotTurn } from '../../git/session-snapshots'
import type { AgentBackend, RunHandle } from '../agent-backend'
import type { AgentRunRequest, AgentRunSessionState } from '../agent-runner'
import { MODEL_PROFILES, SOLUS_WORKTREE_ENCODED_MARKER } from '@solus/contracts/types'
import type {
  AgentId,
  AgentMetadata,
  AgentSlashCommand,
  AgentUsageLimits,
  IpcContext,
  NormalizedEvent,
  PlanDescriptor,
  PluginCommandsResult,
  PromptOptions,
  SessionMeta,
} from '@solus/contracts/types'
import type { ClaudeRunResult } from './claude-agent'
import type { SessionLoadMessage, SessionPreviewResult } from '@solus/contracts/session-history'
import {
  _sessionListCache,
  _sessionScanInFlight,
  parseJsonlLine,
  findClaudeForkResumeId,
  resolveClaudeSessionFilePath,
  scanSessionsInDir,
} from './claude-session-helpers'
import {
  _planListCache,
  _planScanInFlight,
  scanPlansInDir,
  annotateScanned,
  groupBySession,
  type AnnotatedPlan,
  type ScannedPlan,
} from './claude-plan-helpers'
import { _pluginCmdCache, PLUGIN_CMD_TTL, resolvePluginCommands } from './claude-plugin-helpers'
import { SOLUS_PLUGINS_DIR } from '../plugins'
import { runBounded } from '../../lib/concurrency'
import { getIndexedSession, listIndexedSessions, sessionIndexComplete } from '../../db/session-indexer'
import { ClaudeCommandDiscovery } from './claude-command-discovery'
import { reviewSkillPrompt } from '../review-command'

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

/**
 * The model id the SDK is asked for. `[1m]` is a variant only some models have,
 * so the window alone cannot select it: a stale 1M riding a 200K model (a
 * restored tab, a switched model) asks for a variant that does not exist and
 * Claude answers `400 The long context beta is not yet available`, killing the
 * turn before it starts.
 */
function claudeModelId(baseModel: string, contextWindow: number | null | undefined): string {
  const offersLongContext = claudeProfiles[baseModel]?.contextWindows.includes(1_000_000) ?? false
  return contextWindow === 1_000_000 && offersLongContext ? `${baseModel}[1m]` : baseModel
}

type TurnBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }

/**
 * A user message for a turn — the opening one, or one steered into a turn that
 * is already running. Images become real content blocks; the base64 bytes
 * already live in memory (from the renderer preview), so this never touches the
 * filesystem and can't throw.
 */
function buildUserMessage(
  text: string,
  images: Array<{ mimeType: string; dataUrl: string }> | undefined,
): SDKUserMessage {
  // SAFETY: imageContent constructs only Anthropic text and base64 image content blocks.
  return {
    type: 'user',
    message: { role: 'user', content: imageContent(text, images) ?? text },
    parent_tool_use_id: null,
  } as SDKUserMessage
}

/** Content blocks for a turn carrying images, or null for a plain text turn. */
function imageContent(
  text: string,
  images: Array<{ mimeType: string; dataUrl: string }> | undefined,
): TurnBlock[] | null {
  if (!images || images.length === 0) return null

  const content: TurnBlock[] = []
  if (text) content.push({ type: 'text', text })
  for (const img of images) {
    const m = img.dataUrl.match(/^data:(.+?);base64,(.+)$/)
    if (!m) continue
    content.push({ type: 'image', source: { type: 'base64', media_type: img.mimeType || m[1], data: m[2] } })
  }
  // Every dataUrl was malformed — fall back to the plain text turn.
  return content.some((b) => b.type === 'image') ? content : null
}

interface ClaudeRunHandle extends RunHandle {
  /** The turn's open input stream — steering pushes into it while the run is live. */
  input: TurnInputChannel
}

export class ClaudeBackend extends BaseAgentBackend<ClaudeRunHandle> implements AgentBackend {
  readonly id: AgentId = 'claude-code'
  readonly metadata: AgentMetadata = CLAUDE_METADATA
  readonly permissions = new PermissionManager()

  private agent = new ClaudeAgent()
  private commandDiscovery = new ClaudeCommandDiscovery(
    (target) => this.agent.supportedCommands(target),
    PLUGIN_CMD_TTL,
  )

  constructor() {
    super()
    this.permissions.onPermissionEvent = (sessionId, event) => {
      const handle = sessionId ? this.activeRuns.get(sessionId) : this.pendingRuns[0]
      if (handle) handle.sawPermissionRequest = true
      // Use handle.agentSessionId (promoted after session_init) over the closure sessionId,
      // which is null for fresh sessions and would cause the control-plane to drop the event.
      this.emit('normalized', handle?.agentSessionId ?? sessionId, event)
    }
  }

  /** Resolve the current path without touching the index on the normal path. */
  private sessionFilePath(sessionId: string, projectPath?: string): string | null {
    return resolveClaudeSessionFilePath(
      join(homedir(), '.claude', 'projects'),
      sessionId,
      projectPath || process.cwd(),
      () => {
        const indexedSession = getIndexedSession(sessionId)
        return indexedSession?.provider === 'claude-code'
          ? indexedSession.projectPath
          : undefined
      },
    )
  }

  private async forkResumeId(sessionId: string, projectPath: string): Promise<string | null> {
    const filePath = this.sessionFilePath(sessionId, projectPath)
    if (!filePath) return null
    const lines: string[] = []
    await new Promise<void>((resolve) => {
      const rl = createInterface({ input: createReadStream(filePath) })
      rl.on('line', (line: string) => lines.push(line))
      rl.on('close', () => resolve())
    })
    return findClaudeForkResumeId(lines)
  }

  /** SDK-reported built-in commands for a working directory and model, fetched via a
   *  short-lived streaming query (the only mode that exposes `supportedCommands`)
   *  and serialized across cache misses. No persistent session is kept. */
  private builtinCommands(ctx: IpcContext): Promise<AgentSlashCommand[]> {
    const cwd = resolveHomePath(ctx.session.workingDirectory)
    const model = claudeModelId(ctx.statusBar.model, ctx.session.contextWindow)
    return this.commandDiscovery.get({ cwd, model })
  }

  startRun(request: AgentRunRequest, sessionState?: AgentRunSessionState): RunHandle {
    const providerPrompt = reviewSkillPrompt(request.prompt, 'claude-code')
    const abortController = new AbortController()
    const sessionId = request.sessionId ?? null
    const uiMode = request.permissionMode
    const sessionRef = { current: sessionId }
    const canUseTool = this.permissions.createCanUseTool(sessionRef, uiMode, request.unattended)

    let _resolveRun!: () => void
    let _rejectRun!: (err: Error) => void
    const runPromise = new Promise<void>((res, rej) => { _resolveRun = res; _rejectRun = rej })

    const handle: ClaudeRunHandle = {
      agentSessionId: sessionId,
      persistence: request.persistence,
      startedAt: Date.now(),
      toolCallCount: 0,
      sawPermissionRequest: false,
      permissionDenials: [],
      abortController,
      runPromise,
      _resolveRun,
      _rejectRun,
      input: new TurnInputChannel(
        buildUserMessage(providerPrompt, request.imageAttachments),
        providerPrompt,
      ),
    }

    const workTree = request.cwd
    const model = claudeModelId(request.model ?? this.metadata.defaultModel, request.contextWindow)
    const adaptedTools = adaptClaudeTools(request.tools, {
      provider: 'claude-code',
      cwd: resolveHomePath(request.cwd),
      sessionId: () => handle.agentSessionId ?? sessionRef.current ?? undefined,
      solusSessionId: () => handle.sessionId,
      abortSignal: abortController.signal,
      parentToolUseId: () => undefined,
      emit: (event) => this.emit('normalized', handle.agentSessionId, event),
    }, uiMode)

    this.pendingRuns.push(handle)
    void (async () => {
      const prepareSnapshots = async (providerSessionId: string) => {
        const repoRoot = await resolveRepoRoot(workTree)
        if (!repoRoot) return
        const head = getHeadCommit(workTree)
        if (!head) return
        await initSessionBase(repoRoot, providerSessionId, head)
        await prepareTurnSnapshot(workTree, repoRoot, providerSessionId)
      }
      const resumeSessionAt = request.forkSession && request.forkExcludeLatestTurn && sessionId
        ? await this.forkResumeId(sessionId, request.cwd)
        : null
      if (request.persistence === 'session' && sessionId && !request.forkSession) {
        await prepareSnapshots(sessionId)
      }
      const { events, result } = this.agent.run({
        prompt: handle.input,
        cwd: resolveHomePath(request.cwd),
        sessionId,
        forkSession: request.forkSession,
        resumeSessionAt: resumeSessionAt ?? undefined,
        model,
        reasoningEffort: request.reasoningEffort,
        fastMode: request.fastMode,
        permissionMode: uiMode,
        additionalDirectories: request.additionalDirectories,
        mcpServers: { solus: adaptedTools.server },
        allowedTools: [...SAFE_TOOLS, ...adaptedTools.allowedTools],
        systemPromptAppend: request.systemPrompt,
        maxTurns: request.maxTurns,
        maxBudgetUsd: request.maxBudgetUsd,
        canUseTool,
        enableFileCheckpointing: request.persistence === 'session',
        persistSession: request.persistence === 'session',
        abortController,
        onSessionInit: request.persistence === 'session'
          ? prepareSnapshots
          : undefined,
        onTurnComplete: request.persistence === 'session' ? async (sid, snapOpts) => {
          const repoRoot = await resolveRepoRoot(workTree)
          if (!repoRoot) return null
          const result = await snapshotTurn(workTree, repoRoot, sid, {
            ...snapOpts,
            sessionChangedFiles: [...new Set([...(sessionState?.changedFiles ?? []), ...snapOpts.editedFiles])],
            turnChangedFiles: snapOpts.editedFiles,
          })
          return result?.sessionChangedFiles ?? null
        } : undefined,
      })

      await this._runLoop(handle, events, result, sessionRef, workTree)
    })().catch((err: any) => {
      const sessionId = handle.agentSessionId
      log.error('run_start_failed', { sessionId: sessionId ?? 'pending', error: err?.message })
      // Emit before finishRun: a run that failed before session_init has no
      // agentSessionId, so the ControlPlane can only find its session through
      // the pending handles — which finishRun empties. See _runLoop's catch.
      this.emit('error', sessionId, err instanceof Error ? err : new Error(String(err)))
      this.finishRun(handle)
      handle._rejectRun(err instanceof Error ? err : new Error(String(err)))
    })
    return handle
  }

  private async _runLoop(
    handle: ClaudeRunHandle,
    events: AsyncIterable<NormalizedEvent>,
    result: Promise<ClaudeRunResult>,
    sessionRef: { current: string | null },
    cwd: string,
  ): Promise<void> {
    try {
      for await (const evt of events) {
        if (evt.type === 'session_init') {
          this.promoteToActive(handle, evt.sessionId)
          sessionRef.current = evt.sessionId
        }

        this.emit('normalized', handle.agentSessionId, evt)
      }

      // The event stream is done but `exit` is only emitted once `result`
      // settles. If it never does, the run stops being tracked with no exit and
      // the watchdog collects it 30s later; this line and `run_complete` bracket
      // that window, so an unpaired one names the stall.
      log.info('run_stream_ended', { sessionId: handle.agentSessionId ?? 'pending' })
      const final = await result
      handle.agentSessionId = final.sessionId
      handle.toolCallCount = final.toolCallCount
      handle.permissionDenials = final.permissionDenials
      const sessionId = handle.agentSessionId
      this.finishRun(handle)
      log.info('run_complete', { sessionId, denials: handle.permissionDenials.length })
      handle._resolveRun()
      this.emit('exit', sessionId, final.signal === 'SIGINT' ? null : 0, final.signal)
    } catch (err: any) {
      const sessionId = handle.agentSessionId
      // `cwdExists: false` here means the SDK's "binary … failed to launch" is
      // really a spawn ENOENT on the working directory — a worktree that went
      // away under a live session, not a broken Claude install.
      log.error('run_errored', {
        sessionId: sessionId ?? 'pending',
        error: err?.message,
        cwd,
        cwdExists: existsSync(cwd),
        pluginsDir: SOLUS_PLUGINS_DIR,
        pluginsDirExists: existsSync(SOLUS_PLUGINS_DIR),
      })
      // Emit before finishRun. With no session_init there is no agentSessionId,
      // so the ControlPlane resolves the failed session through the backend's
      // pending handles; finishRun removes this handle from them, and the error
      // then reaches no session at all. The record is left behind for the run
      // watchdog, which reports it as `exit null` with the real reason lost.
      this.emit('error', sessionId, err instanceof Error ? err : new Error(String(err)))
      this.finishRun(handle)
      handle._rejectRun(err instanceof Error ? err : new Error(String(err)))
    }
  }

  override cancelSession(sessionId: string): boolean {
    log.info('cancel_session', { sessionId })
    return super.cancelSession(sessionId)
  }

  /**
   * Push a message into the turn that is already running, so the model picks it
   * up at its next decision point and keeps going in the same turn.
   *
   * `priority: 'next'` is what makes this steering rather than an interrupt: the
   * in-flight request runs to completion and the message is read at the next
   * decision point, so the model keeps its partial work and folds the new
   * instruction into it. `'now'` instead aborts the request outright — the
   * partial response is discarded and `[Request interrupted by user]` is written
   * into the transcript, which reads to the model as "stop and do this instead".
   */
  async steerSession(
    sessionId: string,
    options: Pick<PromptOptions, 'prompt' | 'imageAttachments'>,
  ): Promise<RunHandle | null> {
    const handle = this.activeRuns.get(sessionId)
    if (!handle) return null
    // The turn can settle between the control-plane's busy check and this push.
    // A refused push means its agent loop will never read the message, so the
    // caller keeps the prompt for the next turn.
    const accepted = handle.input.push({
      ...buildUserMessage(options.prompt, options.imageAttachments),
      priority: 'next',
    })
    return accepted ? handle : null
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

    if (sessionIndexComplete()) {
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

    const scanStartedAt = Date.now()
    const scan = (async () => {
      const scanTasks = dirsToScan.map((d) => scanSessionsInDir(d.path, d.encodedPath, cwd, d.isWorktree, onBatch ? (s) => onBatch([s]) : undefined))
      const results = await Promise.all(scanTasks)
      const sessions = results.flat()
      sessions.sort((a, b) => new Date(b.lastTimestamp).getTime() - new Date(a.lastTimestamp).getTime())
      _sessionListCache.set(cacheKey, { sessions, latestDirMtime: currentMaxMtime })
      // The index could not answer, so this list came off the disk: a head-read
      // of every transcript in the project and its worktrees. Timed separately
      // from `list_sessions` so the two paths stay tellable apart.
      log.metric('session_list_disk_scan', Date.now() - scanStartedAt, { dirs: dirsToScan.length, sessions: sessions.length })
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
    const filePath = this.sessionFilePath(sessionId, projectPath)
    if (!filePath) return []

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
    const filePath = this.sessionFilePath(sessionId, projectPath)
    if (!filePath) return { head: [], tail: [], totalMessages: 0 }

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
    if (isPlanIndexComplete('claude-code')) {
      return listIndexedPlans('claude-code', projectPath, allProjects)
    }
    const cacheKey = `${allProjects ? 'all' : projectPath || process.cwd()}`

    const projectsRoot = join(homedir(), '.claude', 'projects')
    if (!existsSync(projectsRoot)) {
      if (allProjects) replaceIndexedPlansForProvider('claude-code', [])
      return []
    }

    // Dedup concurrent cold plan scans of the same scope, exactly as listSessions
    // does: the pill and editor windows both fire listPlans at launch, and each
    // walks every project's transcripts. Share one scan; later callers await it.
    const inFlight = _planScanInFlight.get(cacheKey)
    if (inFlight) return inFlight

    const scan = (async () => {
      const annotationIndex = await loadAllAnnotations()
      const allScanned: AnnotatedPlan[] = []
      const indexedPlans: IndexedPlanInput[] = []
      const collect = (scanned: ScannedPlan[]) => {
        for (const plan of scanned) {
          allScanned.push(annotateScanned(plan, annotationIndex))
          indexedPlans.push({
            provider: 'claude-code',
            sessionId: plan.sessionId,
            planToolUseId: plan.planToolUseId,
            projectPath: plan.projectPath,
            cwd: resolveHomePath(plan.cwd),
            timestamp: plan.timestamp,
            title: plan.title,
            excerpt: plan.excerpt,
            planFilePath: plan.planFilePath,
            content: plan.content,
            derivedStatus: plan.derivedStatus,
          })
        }
      }

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
          collect(await scanPlansInDir(full, dir, fallbackCwd))
        })
        await runBounded(tasks, 8)
      } else {
        const cwd = projectPath || process.cwd()
        const encodedPath = encodePathAsFolder(cwd)
        const mainDir = join(projectsRoot, encodedPath)
        collect(await scanPlansInDir(mainDir, encodedPath, cwd))

        const worktreePrefix = encodedPath + SOLUS_WORKTREE_ENCODED_MARKER
        const worktreeDirs = (await readdir(projectsRoot)).filter((d: string) => d.startsWith(worktreePrefix))
        const tasks = worktreeDirs.map((wt) => async () => {
          collect(await scanPlansInDir(join(projectsRoot, wt), wt, cwd))
        })
        await runBounded(tasks, 8)
      }

      const descriptors = groupBySession(allScanned)
      descriptors.sort((a, b) => b.timestamp - a.timestamp)
      if (allProjects) replaceIndexedPlansForProvider('claude-code', indexedPlans)
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

  invalidatePlanCache(sessionId: string): void {
    _planListCache.invalidateWhere(
      (_key, descriptors) => descriptors.some((descriptor) => descriptor.sessionId === sessionId),
    )
  }

  async loadPlanContent(sessionId: string, projectPath: string, planToolUseId: string): Promise<string | null> {
    const indexed = loadIndexedPlanContent('claude-code', sessionId, planToolUseId)
    if (indexed !== null) return indexed
    const filePath = this.sessionFilePath(sessionId, projectPath)
    if (!filePath) return null

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
      // The SDK reports a spawn ENOENT as "the binary exists but failed to
      // launch", naming the executable even when it is the working directory
      // that is missing. Record the directory so the two cannot be confused.
      log.warn('builtin_commands_failed', {
        error: e instanceof Error ? e.message : String(e),
        cwd: resolveHomePath(ctx.session.workingDirectory),
        cwdExists: existsSync(ctx.session.workingDirectory),
        // Every query passes this as a local plugin root, and in dev it is a
        // symlink into whichever build wrote it last. A dangling one raises the
        // same errno family the SDK renders as "the binary failed to launch".
        pluginsDir: SOLUS_PLUGINS_DIR,
        pluginsDirExists: existsSync(SOLUS_PLUGINS_DIR),
      })
      return []
    })
    return { ...result, builtin }
  }

  async refreshPluginCommands(): Promise<void> {
    _pluginCmdCache.clear()
    this.commandDiscovery.clear()
  }

  async readUsageLimits(): Promise<AgentUsageLimits | null> {
    const windows = await this.agent.readUsageReport()
    if (!windows) return null
    return {
      provider: this.id,
      ...windows,
      // `/usage` names no plan tier, only the two windows.
      planType: null,
      fetchedAt: Date.now(),
      stale: false,
    }
  }
}
