import rawModelProfiles from './model-profiles.json'
import type { GitIdentity, GitState } from './git-types'
import type { TaskProviderId, TaskSnapshot } from './task-types'
import type { PrReviewTarget, PullRequest } from './providers'
import type { BrowserSnapshotRef } from './browser-types'
import type { WorkExternalLink } from './docs'
import { z } from 'zod'

// ─── Agent ID (needed by ModelProfile below) ───

export type AgentId = 'claude-code' | 'codex' | 'opencode'

export type AgentTaskLifecyclePolicy = 'none' | 'moderate' | 'autonomous'

export const AGENT_BIN = {
  'claude-code': 'claude',
  'codex': 'codex',
  'opencode': 'opencode',
} satisfies Record<AgentId, string>

/**
 * The port a Solus server listens on unless it is told otherwise. Shared with
 * the clients: an address a user types without a port means this one, not 80.
 */
export const DEFAULT_SERVER_PORT = 3000

export interface ServerCapabilities {
  headless: boolean
  desktopHandlers: boolean
  agents: {
    claude: boolean
    codex: boolean
  }
  dictation: boolean
  platform: string
  version: string
  projectCount: number
  agentAuth: {
    claude: boolean
  }
  gitAuth: {
    github: boolean
  }
  serverName?: string
  /** Where this host's folder picker starts when opening a new project. */
  projectsBaseDirectory?: string
  /** How much control agents have over task lifecycle status. */
  agentTaskLifecyclePolicy?: AgentTaskLifecyclePolicy
  /** This host's general-purpose workspace — the app's default working directory. */
  workspacePath?: string
}

/** Feature surface advertised by one authenticated host. Missing keys are
 * unsupported so newer clients remain safe when connected to older hosts. */
export interface HostCapabilities {
  /** The host build's version, for the per-host skew notice. */
  version?: string
  attachUpload?: boolean
  /** The host reads `PromptOptions.imageAttachmentRefs` from its own attachment
   *  store. Without it a client sends image bytes inline on every turn. */
  promptImageRefs?: boolean
  assetUrls?: boolean
  skillsInstall?: boolean
  skillsSearch?: boolean
  voiceModel?: boolean
  automations?: boolean
  editors?: EditorId[]
  githubProvider?: boolean
  /** This host runs the browser domain: it can discover dev-server targets and
   *  hold browser pages. Whether a page can actually be *rendered* is a client
   *  fact (a native surface), not a host one. */
  browser?: boolean
  atlassianProvider?: boolean
}

export type SetupAgent = 'claude' | 'codex'
/** `signin-*` reuse the install streaming machinery — same log/status topics. */
export type SetupStreamStep =
  | 'install-claude' | 'install-codex' | 'install-git' | 'install-gh' | 'clone'
  | 'signin-claude' | 'signin-codex'
export type SetupStepStatus = 'running' | 'done' | 'failed'

export interface SetupLogEvent {
  step: SetupStreamStep
  line: string
}

/** The browser prompt an agent sign-in is blocked on. Some CLIs require a returned code. */
export interface SetupVerification {
  url: string
  code?: string
  requiresCodeInput?: boolean
}

export interface SetupStatusEvent {
  step: SetupStreamStep
  status: SetupStepStatus
  error?: string
  /** Present while an agent sign-in waits on the user to open the URL. */
  verification?: SetupVerification
}

export interface SetupStepResult {
  step: SetupStreamStep
  status: Exclude<SetupStepStatus, 'running'>
  error?: string
}

export interface SetupAgentAuthCheckResult {
  agent: SetupAgent
  installed: boolean
  /** null means this agent does not have a cheap credential probe yet. */
  authenticated: boolean | null
}

export interface SetupGithubRepo {
  name: string
  fullName: string
  private: boolean
  cloneUrl: string
  updatedAt: string
}

export type SetupGithubReposResult =
  | { connected: false }
  | { connected: true; repos: SetupGithubRepo[] }

/**
 * How a clone authenticated — and therefore whether this host can also push. An
 * `anonymous` clone read a public repo with no credentials at all, so it works
 * right up until the push.
 */
export type CloneAuth = 'ssh' | 'token' | 'anonymous'

export interface SetupCloneProjectResult {
  path: string
  projectKey: string
  auth: CloneAuth
}

/**
 * A GitHub credential lent to another host so a dispatched session clones,
 * fetches and pushes as the person who dispatched it rather than as the host.
 */
export interface GithubDelegatedCredential {
  accessToken: string
  login: string
}

/** Asks a host to materialize a repository in the calling device's dispatch namespace. */
export interface SetupPrepareProjectRequest {
  cloneUrl: string
  /** Present only for a Run-on dispatch: clone as the caller, not as the host. */
  credential?: GithubDelegatedCredential
  /** Exact existing worktree to use after the target repository is ready. */
  worktreePath?: string
  /** Origin branch to materialize as an isolated target worktree. */
  baseBranch?: string
}

export interface SetupPrepareProjectResult {
  path: string
  projectKey: string
  action: 'updated' | 'cloned'
}

/** Fast-forwards a checkout that already exists on the selected host. */
export interface SetupSyncProjectRequest {
  path: string
  /** Refuses to update the path when its origin names a different repository. */
  cloneUrl: string
}

/** Registering a checkout the host already had, instead of cloning a new one. */
export interface SetupAdoptProjectResult {
  path: string
  projectKey: string
}

/** How a clone reaches the code host. HTTPS rides the host's stored token; SSH needs a key on the host. */
export type CloneProtocol = 'https' | 'ssh'

export interface SetupCloneProjectRequest {
  cloneUrl: string
  /** Overrides the directory name derived from the repo. */
  name?: string
  /** Absolute (or `~`-rooted) destination on the host; defaults under its projects root. */
  destination?: string
  protocol?: CloneProtocol
  /** Removes the partial directory a previous clone on this host left behind. */
  clean?: boolean
  /** Present only for a Run-on dispatch: clone as the caller, not as the host. */
  credential?: GithubDelegatedCredential
}

/** The command that installs a package on a host, and whether Solus may run it unattended. */
export interface PackageInstallCommand {
  display: string
  /** False when the command needs sudo we don't have — the client shows it to copy instead. */
  autoRunnable: boolean
}

/** The `user.name`/`user.email` a host commits under. */
export interface GitCommitIdentity {
  name: string
  email: string
}

/**
 * Everything a host needs before it can clone and then push: the git binary, a
 * commit identity, GitHub credentials, and any SSH keys it holds. Probed on the
 * host itself — a remote host inherits none of this from the client.
 */
export interface HostReadiness {
  platform: string
  home: string
  /** Where a clone lands when no destination is given. */
  projectsRoot: string
  git: {
    installed: boolean
    identity: GitCommitIdentity | null
    /** True when git is configured to fetch github.com credentials from Solus. */
    credentialHelper: boolean
  }
  github: {
    /** A GitHub OAuth token is stored in this host's keyring. */
    solusToken: boolean
    solusLogin: string | null
    /** Omitted by older hosts; callers must treat omission as unknown. */
    solusScopes?: string[]
    ghCli: boolean
    ghAuthenticated: boolean
  }
  ssh: {
    /** Basenames of `~/.ssh/*.pub`. Presence only — nothing is dialled. */
    publicKeys: string[]
  }
  /** Folded in so readiness is one answer to "can this host take a session?". */
  agents: Record<SetupAgent, { installed: boolean; signedIn: boolean }>
  /** Null when git is already installed, or when no installer is known here. */
  installGit: PackageInstallCommand | null
  /** Null when the GitHub CLI is already installed, or when no installer is known here. */
  installGh: PackageInstallCommand | null
}

export interface SetupSshAccessResult {
  host: string
  ok: boolean
  /** The host's own words — shown verbatim so an unfamiliar failure isn't hidden. */
  message: string
}

export type HostOperatingSystem = 'macos' | 'windows' | 'linux'

export interface DiscoveredServer {
  host: string
  port: number
  name: string
  installationId: string
  os?: HostOperatingSystem
  source: 'lan' | 'tailnet'
}

export interface SshBootstrapCredential {
  sessionToken: string
  installationId: string
  fingerprint: string
}

export interface SshTargetCandidate {
  target: string
  label: string
  source: 'ssh-config' | 'known-hosts'
}

export type SshBootstrapResult =
  | { status: 'connected'; credential: SshBootstrapCredential }
  | { status: 'needs-target'; candidates: SshTargetCandidate[]; defaultTarget: string; message: string }
  | { status: 'needs-auth'; sshTarget: string; attempt: number; message: string }

export interface WebPushSubscriptionJSON {
  endpoint: string
  expirationTime?: number | null
  keys: {
    p256dh: string
    auth: string
  }
}

// ─── Shared primitive types used by NormalizedEvent and multiple layers ───

export interface UsageData {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
  reasoningTokens?: number
  contextWindowTokens?: number
}

/**
 * What occupies the model's context window right now — the provider's latest
 * context snapshot, not a running total. Providers report cumulative spend for
 * a whole thread too (Claude's result usage, Codex's `tokenUsage.total`); that
 * belongs in `UsageData`, and mixing the two overstates the window by an order
 * of magnitude once a turn makes several tool calls.
 */
export interface ContextUsage {
  /** Tokens currently retained in the model context. */
  usedTokens: number
  /** The window the run is actually using. Absent until a provider reports it. */
  windowTokens?: number
  /** Where the provider auto-compacts. Absent when it doesn't (Codex). */
  compactAtTokens?: number
  /** Composition of `usedTokens`, for the meter's breakdown rows. */
  inputTokens?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
  outputTokens?: number
}

/** A selectable response for a permission or plan prompt (main→renderer form). */
export interface PermissionOption {
  id: string
  label: string
  kind?: string
}

// ─── Model Configuration ───

export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra' | 'ultracode'

export const REASONING_EFFORT_LABELS = {
  none: 'None',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  max: 'Max',
  ultra: 'Ultra',
  ultracode: 'Ultra Code'
} satisfies Record<ReasoningEffort, string>

export interface ModelConfig {
  modelId: string | null
  reasoningEffort: ReasoningEffort
  contextWindow: number | null
  fastMode: boolean
}

/** A background agent session created without any tab ownership or routing state. */
export interface HeadlessSessionRequest {
  prompt: string
  provider: AgentId
  modelId: string | null
  reasoningEffort: ReasoningEffort
  contextWindow: number | null
  cwd: string
  /** Background work that is not a piece of the user's own work — automation
   *  drafting — sets this so no task is minted for the session. */
  skipTaskCreation?: boolean
}

// ─── Model Profiles ───

export interface ModelProfile {
  label: string
  isDefault?: boolean
  reasoningLevels: ReasoningEffort[]
  defaultReasoningEffort: ReasoningEffort
  supportsFastMode: boolean
  contextWindows: number[]
  defaultContextWindow: number
}

const reasoningEffortSchema = z.enum(['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'ultracode'])
const modelProfileSchema = z.object({
  label: z.string(),
  isDefault: z.boolean().optional(),
  reasoningLevels: z.array(reasoningEffortSchema),
  defaultReasoningEffort: reasoningEffortSchema,
  supportsFastMode: z.boolean(),
  contextWindows: z.array(z.number()),
  defaultContextWindow: z.number(),
})
const providerModelProfilesSchema = z.record(z.string(), modelProfileSchema)
const modelProfilesSchema = z.object({
  'claude-code': providerModelProfilesSchema.optional(),
  codex: providerModelProfilesSchema.optional(),
  opencode: providerModelProfilesSchema.optional(),
})

export const MODEL_PROFILES = modelProfilesSchema.parse(rawModelProfiles)

/**
 * The window a model runs with unless the user picks another. Every site that
 * builds a run must resolve it the same way: a session that starts on 1M and is
 * later resumed with `null` silently drops to the provider's default and loses
 * the tail of its own history.
 */
export function defaultContextWindowFor(
  provider: AgentId | null | undefined,
  modelId: string | null | undefined,
): number | null {
  if (!provider || !modelId) return null
  return MODEL_PROFILES[provider]?.[modelId]?.defaultContextWindow ?? null
}

// ─── Session Status ───

export type SessionStatus =
  | 'connecting'
  | 'idle'
  | 'running'
  | 'awaiting_input'
  | 'awaiting_plan'
  | 'rate_limited'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'dead'

export function isSteerableStatus(status: SessionStatus): boolean {
  return status === 'running'
}

export function isSessionBusyStatus(status: SessionStatus): boolean {
  return status === 'connecting'
    || status === 'running'
    || status === 'awaiting_input'
    || status === 'awaiting_plan'
    || status === 'rate_limited'
}

export interface PermissionRequest {
  questionId: string
  toolTitle: string
  toolDescription?: string
  toolInput?: PermissionToolInput
  options: Array<{ optionId: string; kind?: string; label: string }>
}

/** Fields the permission UI and policy inspect from provider tool payloads. */
export interface PermissionToolInput {
  command?: unknown
  cwd?: unknown
  description?: unknown
  plan?: unknown
  planFilePath?: unknown
  url?: unknown
  old_string?: unknown
  new_string?: unknown
  changes?: unknown
}

export interface QuestionOption {
  label: string
  description?: string
  preview?: string
}

export interface QuestionItem {
  id?: string
  question: string
  header?: string
  options: QuestionOption[]
  multiSelect: boolean
}

export interface QuestionRequest {
  questionId: string
  questions: QuestionItem[]
  kind?: 'standard' | 'mcp_form' | 'mcp_url'
  message?: string
  url?: string
  serverName?: string
  canDecline?: boolean
  canCancel?: boolean
}

/** An image the host already holds on disk, named by the absolute path
 *  `attachUpload` minted for it. A turn carries this instead of the bytes, so
 *  base64 stops crossing the transport, entering the transcript, and fanning
 *  out to every other mounted client. */
export interface PromptImageRef {
  mimeType: string
  hostPath: string
  name?: string
}

export interface Attachment {
  id: string
  type: 'image' | 'file' | 'design-selection'
  name: string
  path: string
  /** Absolute path written by the session's host after a byte upload. The
   *  client-local `path` remains available only for local preview/readback. */
  hostPath?: string
  /** Host that owns `hostPath`; prevents a later run-host change from sending
   *  a valid path to the wrong machine. */
  hostServerId?: string
  mimeType?: string
  /** Base64 data URL for image previews */
  dataUrl?: string
  /** File size in bytes */
  size?: number
  /** Rich metadata for design mode selections */
  designData?: DesignModeSelection
}

/**
 * A composer draft parked for later: the prompt text plus its attachments,
 * scoped to one project. Restoring drops both into the current tab's composer;
 * sending the restored draft deletes the saved prompt.
 */
export interface SavedPrompt {
  id: string
  /** Repo root, or the working directory when the composer isn't in a checkout. */
  projectRoot: string
  text: string
  attachments: Attachment[]
  createdAt: number
}

export interface DesignAnnotation {
  id: string
  type: 'rectangle' | 'arrow' | 'pin' | 'text'
  /** Coordinates relative to the screenshot (0-1 normalized) */
  x: number
  y: number
  width?: number
  height?: number
  /** End point for arrows (normalized) */
  endX?: number
  endY?: number
  /** Marker number for pins, or text content for text annotations */
  label?: string
}

export interface VoiceModelStatus {
  state: 'checking' | 'downloading' | 'installing' | 'ready' | 'error'
  receivedBytes?: number
  totalBytes?: number
  error?: string
}

export interface DesignModeSelection {
  /** Cropped element screenshot as data URL */
  screenshot: string
  /** Element's outer HTML (truncated if large) */
  outerHTML?: string
  /** Unique CSS selector path */
  cssSelector?: string
  /** Key computed CSS properties */
  computedStyles?: Record<string, string>
  /** Framework component name (React/Svelte/Vue) */
  componentName?: string
  /** Source file path from source maps */
  componentFile?: string
  /** Page URL where element was selected */
  pageURL?: string
  /** Viewport dimensions */
  viewport?: { width: number; height: number }
  /** User-drawn annotations */
  annotations?: DesignAnnotation[]
  /** Complete agent-facing context for a browser annotation attachment.
   *
   * Browser annotations use the existing design-selection attachment lane so
   * they persist with a draft and render with the other composer attachments.
   * This text keeps the page, viewport, and source locations
   * together instead of flattening them into the user's editable prompt. */
  annotationContext?: string
  /** The marks a browser annotation carries, one per chip, in pin order.
   *
   * This holds what a chip has to say about one mark — which tool made it, its
   * pin, and what it landed on. A chip
   * derives nothing from array position: the pin is a name the page overlay,
   * the prompt, and the agent's reply all share. */
  browserMarks?: BrowserMark[]
  /** The colour scheme the page was marked up under, recorded only when it was
   *  not the app's own. A chip appends it to its page and size, because a mark
   *  read months later cannot otherwise say which of the two themes it meant. */
  browserAppearance?: 'light' | 'dark'
}

/**
 * One mark from the browser, as the chip row states it.
 *
 * The tool union is written out rather than imported from `browser-types` so a
 * generic attachment stays independent of the browser domain's contract.
 */
export interface BrowserMark {
  id: string
  /** Which annotation tool made it — decides the chip's glyph. */
  tool: 'pick' | 'region' | 'draw'
  /** The mark's stable ordinal. Never renumbers when a chip is removed. */
  pin: number
  /** Shortest identifying form of what the mark landed on, when one resolved. */
  selector?: string
  /** The user's words about this mark; the chip's label when nothing resolved. */
  note?: string
}

/**
 * What you typed: the unsent message. A document, not a widget — there is no
 * caret, selection, focus or IME state here. Those belong to whichever editor is
 * rendering this prompt, and several may render the same one.
 */
export interface Prompt {
  text: string
  /** Images are attachments with type: 'image'. */
  attachments: Attachment[]
  planRefs: PlanReference[]
  workRefs: WorkReference[]
  sessionRefs: SessionReference[]
}

/**
 * How a session will run, as a composer proposes it. Resolves into
 * `SessionRunInput` at dispatch, which is the contract the backend actually
 * consumes; once a session exists, `BackendSession.runInput` is the authority
 * and this is no longer the thing being edited.
 */
export interface RunConfig {
  workingDirectory: string
  /** The checkout the session adopts before its own Git refresh answers. Null
   *  when nothing is inherited, which is not the same as "not a repo". */
  gitContext: GitCheckout | null
  /**
   * How this run will branch, or null when it works directly in its checkout.
   *
   * One field rather than a request flag beside a base branch, because the two
   * always move together and a pair can express the contradiction "not branching,
   * from `main`" — which is exactly how a toggle bug hid. `baseBranch` is null
   * while the branch to fork from is still unresolved: the decision is made
   * before the answer is known, since choosing a project drops the old checkout
   * and the new host has yet to reply.
   *
   * Says nothing about *where* the run happens; `serverId`/`taskServerId` own
   * that. A dispatch can clear this by selecting an existing target worktree.
   */
  worktree: { baseBranch: string | null } | null
  modelConfig: ModelConfig
  permissionMode: 'ask' | 'auto' | 'plan'
  /** null = "use the default", resolved at dispatch. */
  provider: AgentId | null
  /** The host that runs the agent. */
  serverId: string
  /**
   * The host that owns this run's task record — the machine where the *project*
   * was opened, which is not always the machine the agent runs on.
   *
   * Dispatch carries the repository, not the project (ADR-0002): sending a
   * session to another host gives that host a clone, so the task stays with the
   * host you opened the project from. Opening a folder on a host makes that host
   * the project's own, so its tasks are minted there. `serverId !== taskServerId`
   * is therefore the definition of a dispatch. Dispatches always operate in a
   * worktree, either one created for the session or one selected on the target.
   */
  taskServerId: string
  /**
   * Stable sidebar grouping path when this checkout runs on another host: the
   * project root as the *user* knows it, not the borrowed machine's clone path.
   * Part of the run — not the session — so a draft opened from a dispatched
   * session inherits its grouping the same way it inherits the hosts.
   */
  projectGroupPath: string | null
  sessionSkills: string[]
  /** Inert until Send; then connection and repo preparation begin. */
  pendingHostDispatch: PendingHostDispatch | null
}

/**
 * Where the session a composer starts will be filed. A union rather than an id
 * plus a pair of booleans because "no task" is a choice the user made, not the
 * absence of one — a shape that cannot represent the difference invites code
 * that silently overrules them.
 *
 * Never reaches the backend: `SessionRunInput` has no task field, because task
 * membership is a `task_session_links` row written once the session exists.
 */
export type TaskTarget =
  | { kind: 'existing'; taskId: string }
  | { kind: 'new'; parentTaskId?: string }
  | { kind: 'none' }

/**
 * Everything a composer holds. There is no session and no tab behind it — this
 * is what exists *instead*, until `createSession` reads it and makes both.
 *
 * Mutated in place: retargeting a composer to a different task is
 * `spec.task = …`, never a destroy-and-rebuild that has to carry state across
 * its own seam.
 */
export interface SessionSpec {
  prompt: Prompt
  run: RunConfig
  task: TaskTarget
  boundWorkId: string | null
}

/** UI-only state. One per open tab in the renderer. */
export interface Tab {
  id: string
  sessionId: string
  hasUnread: boolean
}

export interface SessionHandoffLineage {
  provider: AgentId
  sessionId: string
}

/** One provider transcript in a session's lineage. */
export interface SessionLineageMember {
  position: number
  provider: AgentId
  providerSessionId: string | null
  cwd: string
  startedAt: number
  endedAt: number | null
}

/** The ordered provider chain behind any member transcript. Every session has one;
 *  `members.length > 1` is what makes it a handoff. */
export interface SessionLineageResolution {
  /** The stable Solus session id. Registered at session_init; never re-pointed. */
  sessionId: string
  members: SessionLineageMember[]
  active: SessionLineageMember
  /** Changes whenever membership or a provider session binding changes. */
  lineageToken: string
}

export type TurnStartKind = 'fresh' | 'follow_up' | 'steer'

/**
 * A picker choice waiting for the first prompt to prepare and enter its host.
 *
 * A union rather than one shape with an `intent` beside a repo key only half of
 * it uses: a dispatch cannot exist without a repository to clone, and an opened
 * project has none to name. The host's display name and locality are not stored
 * — they are registry lookups, and a copy taken at pick time goes stale the
 * moment that host is renamed or forgotten.
 */
export type PendingHostDispatch =
  /** Send this session to another machine, which is first given a clone of
   *  `repoKey`. The project — and every task it files — stays behind. A selected
   *  worktree is an exact path on the target host, never a local checkout. */
  | {
      serverId: string
      intent: 'dispatch'
      repoKey: string
      worktree?: Pick<WorktreeEntry, 'path' | 'branch'>
      /** Origin branch used to create a new isolated worktree on the target. */
      baseBranch?: string
    }
  /** Work in a directory that host already has, which makes it that host's
   *  project outright. Nothing to prepare. */
  | { serverId: string; intent: 'open-project' }

/**
 * Backend-driven session state. Shared across tabs watching the same session.
 *
 * A session *has* run configuration rather than being one: `session.run` and
 * `composer.run` are the same type in the same position, so one composer chrome
 * edits either by taking a `RunConfig` and never asking which it came from.
 * Once a session has started, its `run` is the live target — editing the model
 * mid-conversation moves the session, not a copy of it.
 */
export interface Session {
  id: string
  run: RunConfig
  agentSessionId: string | null
  /** Present only when this session belongs to a new Solus handoff chain. */
  handoffId?: string
  handoffFrom?: SessionHandoffLineage
  status: SessionStatus
  messages: Message[]
  currentActivity: string
  /** Renderer-only context for wording the live activity row without making an
   *  established session sound like it reconnects before every turn. */
  currentTurnStart: TurnStartKind | null
  /** Renderer-local start of the turn in flight. Set optimistically on Send so
   *  elapsed UI does not wait for host preparation or a provider echo. */
  currentTurnStartedAt: number | null
  isStreamingText: boolean
  isReconnecting: boolean
  permissionQueue: PermissionRequest[]
  questionQueue: QuestionRequest[]
  permissionDenied: { tools: Array<{ toolName: string; toolUseId: string }> } | null
  /** Prompts submitted while a turn cannot start immediately. Client-only
   *  optimistic state is reconciled with server queue snapshots and events. */
  outboundPrompts: OutboundPrompt[]
  rateLimitInfo: RateLimitInfo | null
  rateLimitStrategy: 'queue' | 'ask' | 'stop' | 'continue'
  lastResult: RunResult | null
  /** What currently occupies the context window. Drives the context meter. */
  contextUsage: ContextUsage | null
  /** Cumulative token spend for the completed run (from task_complete). Not in
   *  the window — reported separately so neither number reads as the other. */
  runUsage: UsageData | null
  latestCheckpointId: string | null
  /** Attempts at the current turn — 1 until a retry re-runs the last prompt.
   *  Printed on the turn's activity rail so a re-run never reads as a first try. */
  retryAttempt: number
  /** Last failed terminal notice synthesized by the renderer. Provider
   * transcripts do not consistently persist these, so open tabs retain it
   * separately for reload/rehydration. Cleared when a new attempt starts. */
  terminalFailure: { content: string; timestamp: number } | null
  sessionModel: string | null
  /**
   * The unsent message for this conversation. It lives on the session, not the
   * tab, because it is addressed *to* the session: two views of one conversation
   * share the one thing you are about to say to it, rather than each holding a
   * separate draft only one of which could ever be sent.
   */
  prompt: Prompt
  pluginCommands: PluginCommandsResult
  progress: SessionProgress | null
  /** Persisted goal for this thread. Codex owns its native record; Solus owns
   *  Claude's create-once record. Both refresh when an existing thread rebinds. */
  goal?: ThreadGoal | null
  /** A fresh tab has no provider thread id yet. `/goal <objective>` stores the
   *  objective here until the first prompt initializes the thread. */
  pendingGoalObjective?: string | null
  /** Live inline progress card for the current multi-step action (worktree
   *  setup, etc.). Live-only — not persisted to the transcript. */
  statusCard: StatusCardState | null
  /** Files changed since this Solus session began. Committing does not clear
   * these paths; uncommitted files come from live Git state instead. */
  sessionChangedFiles: string[]
  additionalDirs: string[]
  readOnlyReason: string | null
  loadingHistory: boolean
  /** True when only a recent window of the transcript was hydrated and older
   *  messages still live on disk (fetched on demand via expandHistory). */
  historyTruncated: boolean
  /** Agent session ID this session was forked from. */
  forkedFromSessionId: string | null
  /** True until the first prompt is sent, so the provider starts from a fork of agentSessionId. */
  forked: boolean
  /** True when the fork was requested during an active source turn. The provider
   *  must omit that latest turn when it creates the fork, if it supports a cutoff. */
  forkExcludeLatestTurn?: boolean
  /** Work this session is actively collaborating on. Its current content is
   *  injected into each prompt so the agent revises the live version. */
  boundWorkId: string | null
  /**
   * Where this session will be filed until a durable `task_session_links` row
   * exists. A taskless session keeps `{ kind: 'new' }` through its first turn so
   * the agent can link an existing task before fallback minting runs.
   *
   * A fork carries `{ kind: 'new', parentTaskId }`: its own task is minted as a
   * subtask after its first turn, so until then it has no task of its own — only
   * the parent it will hang under.
   */
  task: TaskTarget
  /** Set when this session is the chat tab of a PR review (worktree = PR head).
   *  Drives the PR-context system hint and the `'pr'` diff scope. */
  prReview: PrReviewContext | null
  /**
   * Review feedback queued against this conversation's changes, and the comment
   * being typed. On the session rather than a tab because it is the diff of one
   * conversation that is being reviewed: two views of it queue into one set, and
   * whichever one submits sends all of it.
   */
  diffComments: DiffComment[]
  diffGeneralComment: string
  diffCommentDraft: DiffCommentDraft | null
  /** What this conversation is called. `'New Tab'` means unnamed — `sessionTitle`
   *  falls back to the first user message. On the session, not a tab, so a rename
   *  reaches every view of it instead of only the one that was renamed. */
  title: string
  /** Someone named this session (or accepted a generated name), so nothing —
   *  auto-titling included — may overwrite it. */
  titleCustom: boolean
}

export interface PinnedSessionManifest {
  sessions: Record<string, PinnedSession>
}

export interface PinnedSession {
  /** Agent session id — the key used to dedupe and resume. */
  sessionId: string
  /** Host holding the session. Missing only on pins saved before scoped refs. */
  serverId?: string
  provider: AgentId
  title: string
  /** Real working directory; the backend re-encodes this to locate the transcript. */
  cwd: string
  /** Epoch ms when the session was pinned; drives ordering. */
  pinnedAt: number
}

export interface DiffCommentDraft {
  filePath: string
  startLine: number
  endLine: number
  side: 'old' | 'new'
  /** If set, the draft is editing an existing comment instead of creating a new one */
  editingCommentId: string | null
  value: string
}

export interface TodoItem {
  content: string
  status: 'completed' | 'in_progress' | 'pending'
}

export interface SessionProgress {
  todos: TodoItem[]
  currentStep: number
  totalSteps: number
}

/** Who wrote a thread message. Absent on anything written before threads had
 *  authors, which is why every read goes through `commentAuthor()`. */
export type CommentAuthor = 'you' | 'solus'

/** Which agent wrote a 'solus' thread message. `CommentAuthor` alone cannot say
 *  which one, and several agents can be reviewing the same document. Absent on
 *  everything written before agents could comment. */
export interface CommentAgentAuthor {
  sessionId: string
  /** The session's name, when it has one — absent until it is slugged, and the
   *  thread signs as plain "Solus" until then. */
  title?: string
  provider: AgentId
}

export interface PlanCommentReply {
  id: string
  author: CommentAuthor
  authorAgent?: CommentAgentAuthor
  text: string
  /** Epoch ms. */
  createdAt: number
}

export interface PlanComment {
  id: string
  /** The anchor's display text: the quoted selection (docs/plans) or the node label (diagrams). */
  selectedText: string
  comment: string
  textOffset?: number
  /** For diagram works: id of the node this comment is anchored to. Absent = whole diagram. */
  nodeId?: string
  /** For diagram works: id of the edge this comment is anchored to. Mutually exclusive with nodeId. */
  edgeId?: string
  /** Absent = 'you' — every comment written before threads had authors. */
  author?: CommentAuthor
  authorAgent?: CommentAgentAuthor
  /** Epoch ms. Absent on pre-existing comments, which render without a time. */
  createdAt?: number
  /** Epoch ms the thread was resolved. Absent = open. */
  resolvedAt?: number
  resolvedBy?: CommentAuthor
  replies?: PlanCommentReply[]
  /** Epoch ms the thread was last read. A Solus message newer than this is unread. */
  readAt?: number
}

export interface DiffComment {
  id: string
  filePath: string
  startLine: number
  endLine: number
  side: 'old' | 'new'
  selectedCode: string
  comment: string
  /** Epoch ms when the comment was first created. */
  createdAt: number
}

/**
 * Per-session context for reviewing an incoming GitHub PR. Carried on the tab
 * alongside `diffComments`. The worktree is the PR head checked out locally, so
 * the agent's reads see the real post-change files.
 */
export interface PrCheckoutContext {
  /** Checkout holding the PR head; often `.git/solus/worktrees/pr-<n>`. */
  worktreePath: string
  /** The real PR head branch, or a local `solus/pr-<n>` review branch for a fork. */
  branch: string
  /** Exact local revisions. Callers reject a checkout for an older host head. */
  baseSha: string
  headSha: string
}

/** Source-grounded PR context stored on agent sessions. Host-only review uses
 * `PrReviewTarget` and creates this combined object only after lazy checkout. */
export interface PrReviewContext extends PrReviewTarget, PrCheckoutContext {}

export type MergeMethod = 'merge' | 'squash' | 'rebase'

export interface PrMergeResult {
  merged: boolean
  message?: string
  detail?: PullRequest
}

export interface PrConflictResolutionResult {
  success: boolean
  review?: PrReviewContext
  conflictFiles?: string[]
  headRef?: string
  error?: string
}

export interface Message {
  id: string
  role: 'user' | 'assistant' | 'tool' | 'system' | 'plan'
  content: string
  toolName?: string
  toolId?: string
  toolIndex?: number
  toolInput?: string
  /** For a sub-agent card this tracks the *agent*, not the tool call: it stays
   *  'running' until the agent's own result or background-settle event lands. */
  toolStatus?: 'running' | 'completed' | 'error'
  /** A subagent's final answer. Ordinary tool output never reaches the client. */
  report?: string
  /** Bounded head of a failed tool's output. */
  errorHead?: string
  /** UTF-8 byte size of tool output that the server did not ship. */
  contentBytes?: number
  /** Epoch ms the tool's result landed. `toolCompletedAt - timestamp` is the
   *  duration the activity block prints in its right-hand rail; absent means the
   *  rail stays empty rather than showing a made-up figure. */
  toolCompletedAt?: number
  /** Milliseconds the agent spent thinking immediately before this tool call.
   *  Thinking never gets a row of its own once the tools have finished — it
   *  folds into the block's summary as "Thought for 6s". */
  thinkingMs?: number
  /** Set when this tool launched an async sub-agent. Its settle event carries
   *  only the task id, so this is the sole link back from settle to the card. */
  backgroundTaskId?: string
  /** When the background task actually finished. A run_in_background tool answers
   *  its call at launch, so `toolCompletedAt` records the spawn and would report a
   *  four-minute poll as 0s; this is the only honest end time such a tool gets.
   *  Its absence on a tagged message is also what "still in flight" means. */
  backgroundTaskSettledAt?: number
  /** Latest SDK heartbeat for a background sub-agent. This is activity metadata,
   *  not a todo plan: it has no trustworthy total-step denominator. */
  backgroundTaskProgress?: {
    description?: string
    toolUses?: number
    totalTokens?: number
    durationMs?: number
    lastToolName?: string
  }
  /** Nested transcript for a sub-agent (Agent/Task) tool call: every child event
   *  (tool calls + assistant text) diverted out of the main thread by
   *  `parentToolUseId`. Presence === "render this tool as a sub-agent card." */
  subMessages?: Message[]
  /** The sub-agent's own todo list (its TodoWrite / plan update), kept off the
   *  session tracker the main agent owns. Latest list wins — a todo write is a
   *  wholesale replacement, not an append. */
  subTodos?: TodoItem[]
  /** Renderer-only marker for a nested assistant block receiving live deltas. */
  isStreaming?: boolean
  /** Resolved `subagent_type` from the Agent tool input, for the card's chip. */
  subagentType?: string
  timestamp: number
  /** Reference to Plan entity in PlanStore */
  planId?: string
  /** Stable ExitPlanMode tool_use id — used for scroll-to-plan targeting */
  planToolUseId?: string
  /** Reference to a Work (folio document) */
  workRef?: { workId: string; title: string; workType?: WorkType }
  /** A rendered visual artifact (render_artifact tool) shown flush in the
   *  conversation. `pending` is true while the tool call is still in flight.
   *  An HTML artifact also carries `workRef` once it is persisted as an
   *  `artifact` work, so the frame can open it in a pane and link it. */
  artifact?: { kind: 'html' | 'image'; html?: string; path?: string; pending?: boolean }
  /** Reference to an automation the agent created or updated in this thread,
   *  rendered as a card with an Open action. */
  automationRef?: { automationId: string; name: string; trigger: AutomationTrigger; enabled: boolean }
  /** Reference to a task the agent created in this thread, rendered as a card
   *  that opens the task board focused on the new task. */
  taskRef?: { taskId: string; title: string; url: string | null }
  /** A capture the agent took of a browser page, rendered as the picture it saw
   *  rather than a line saying it looked. */
  browserSnapshot?: BrowserSnapshotRef
  /** Agent-conversation card for another agent this thread is driving
   *  (create_session / prompt_session / wait_for_session). One message per
   *  agent per turn, mutated in place as `agent_conversation_update` events land;
   *  reconstructed from the transcript
   *  on history reload. */
  agentConversationRef?: AgentConversationRef
  /** Durable anchor for a queued or generated review guide. */
  reviewGuideRef?: import('./review').ReviewGuideReference
  /** Attachments submitted with this user message. The composing client holds a
   *  browser `dataUrl`; every other client gets `hostPath` and resolves it to a
   *  signed asset URL, so the bytes are fetched once, on demand. */
  attachments?: Attachment[]
  /** Plan references attached via # autocomplete */
  planRefs?: PlanReference[]
  /** Work references attached via the work reference picker */
  workRefs?: WorkReference[]
  /** Session references attached via & autocomplete */
  sessionRefs?: SessionReference[]
  /** Set on the fork-divider system message to identify it. */
  forkSourceSessionId?: string
  /** Snapshot of the source session title at fork time. */
  forkSourceTitle?: string
  /** Set when the source was mid-turn at fork time, so the copied transcript
   *  stops at the last settled turn. */
  forkSourceRunning?: boolean
  /** Set on the divider system message when a session is moved into a worktree;
   *  holds the new worktree branch name. */
  worktreeMovedTo?: string
  /** Set on the divider system message inserted after a successful agent
   *  handoff. Holds the destination agent's display label. */
  agentChangedTo?: string
  /** Model labels shown on the two sides of an agent-handoff divider. */
  agentChangedFromModel?: string
  agentChangedToModel?: string
  /** Providers select the same model glyphs used by the model picker. */
  agentChangedFromProvider?: AgentId
  agentChangedToProvider?: AgentId
  /** Set on the divider system message inserted when accepting a plan starts a
   *  fresh agent session to implement it. Holds the accepted plan's id, so the
   *  divider can name the plan the new session carries over. */
  newSessionForPlanId?: string
  /** Set on a user message that an automation injected into this thread, so the
   *  bubble can render a "Sent via automation" badge. Live-only (not persisted to
   *  the transcript), so it's lost on a history reload. */
  via?: PromptVia
  automationId?: string
  automationName?: string
  /** Correlates the committed transcript entry with its optimistic outbox row. */
  clientPromptId?: string
  /** How this message entered an already-running session. */
  delivery?: PromptDelivery
  /** Set on the system message announcing a provider rate limit. The notice is a
   *  statement about the run, not a step the turn took, so a trailing one must
   *  not be mistaken for the end of the turn's answer. Live-only, like `via`. */
  rateLimitNotice?: boolean
  /** Milliseconds this prompt spent held by a rate limit before it went out.
   *  Present only on a bubble that drained from the queue, so its caption can
   *  state the wait as a fact instead of counting to a time that has passed.
   *  Live-only — lost on a history reload, like `via`. */
  queuedWaitMs?: number
}

// ─── Folio / Works ───

/** How a work's `content` renders: markdown for `doc` and `slides`, serialized
 *  diagram JSON for `diagram`, and a self-contained HTML document for
 *  `artifact` (the `render_artifact` tool's output, shown in a sandbox). */
export type WorkType = 'doc' | 'slides' | 'diagram' | 'artifact'

export type WorkStorage =
  | { kind: 'local' }
  | { kind: 'project'; projectRoot?: string; relativePath: string }

export interface WorkMeta {
  title: string
  preview: string
  type: WorkType
  createdAt: string
  updatedAt: string
  /** Origin session (kept for back-compat). Prefer `sessionIds` for resume. */
  sessionId?: string
  /** Every session that has collaborated on this work, oldest→newest. */
  sessionIds?: string[]
  agentProvider: AgentId
  cwd: string
  /** Where this work is persisted. Missing means legacy local storage. */
  storage?: WorkStorage
  /** Pinned works sort to the top of the gallery. */
  pinned?: boolean
  /** The upstream doc this work mirrors, when the user has published or
   *  imported it. Absent for the great majority of works, which are local only. */
  mirroredDoc?: WorkExternalLink
}

export interface WorksManifest {
  version: number
  works: Record<string, WorkMeta>
}

export interface Work extends WorkMeta {
  id: string
  content: string
}

export interface WorkReference {
  workId: string
  title: string
  type: WorkType
}

export interface SessionReference {
  sessionId: string
  provider: AgentId
  title: string   // slug || first line of firstMessage
  cwd: string      // needed so read_session can locate cross-project sessions
  /** Client-edge host stamp. Hosts ignore it; the client routes and resumes
   *  by it, so every new ref carries one. */
  serverId?: string
}

// ─── Plans ───

export interface PlanMessageRef {
  kind: 'plan' | 'document';
  id?: string;
  title?: string;
  content?: string;
  timestamp?: number;
  updatedAt?: string;
  /** Only set when kind === 'document' — distinguishes diagram from doc/slides */
  workType?: WorkType;
  /** True while a create_work tool call is still streaming content into the card. */
  streaming?: boolean;
  comments?: PlanComment[];
  status?: 'pending' | 'accepted' | 'rejected';
  bookmarked?: boolean;
}

export interface Plan {
  id: string
  sessionId: string
  planToolUseId: string
  projectPath: string
  cwd: string
  timestamp: number
  content: string
  filePath?: string
  questionId?: string
  options?: PermissionOption[]
  title: string
  status: 'pending' | 'accepted' | 'rejected'
  comments: PlanComment[]
  bookmarked: boolean
  bookmarkedAt?: number
  /** The provider document this plan revision mirrors. */
  mirroredDoc?: WorkExternalLink
}

export interface PlanReference {
  planId: string
  sessionId: string
  planToolUseId: string
  title: string
  status: 'pending' | 'accepted' | 'rejected'
}

export function planKey(sessionId: string, planToolUseId: string): string {
  return `${sessionId}__${planToolUseId}`
}

// ─── Plans Gallery ───

export interface PlanAnnotations {
  version: 1
  sessionId: string
  projectPath: string
  cwd: string
  planToolUseId: string
  title: string
  status: 'pending' | 'accepted' | 'rejected'
  comments: PlanComment[]
  bookmarked: boolean
  bookmarkedAt?: number
  /** The provider document this plan revision mirrors. */
  mirroredDoc?: WorkExternalLink
  updatedAt: number
}

/** An agent wrote to a plan's or a work's comment threads. Broadcast so the open
 *  document's rail refreshes without being reopened. */
export interface AnnotationsChanged {
  kind: 'plan' | 'work'
  /** `sessionId__planToolUseId` for a plan, the work id for a work. */
  targetId: string
}

/** Selection comments on a work (document), stored in a per-work sidecar. */
export interface WorkAnnotations {
  version: 1
  workId: string
  comments: PlanComment[]
  updatedAt: number
}

/** Single previous version of a work, snapshotted on agent-driven saves. */
export interface WorkPrevious {
  content: string
  updatedAt: string
}

export interface PlanRevisionSummary {
  planToolUseId: string
  timestamp: number
  title: string
  excerpt: string
  status: 'pending' | 'accepted' | 'rejected'
  commentCount: number
  planFilePath?: string
}

export interface PlanDescriptor {
  /** Client-edge owner stamp. Hosts do not set or consume this field. */
  serverId?: string
  provider?: AgentId
  planToolUseId: string
  sessionId: string
  projectPath: string
  cwd: string
  timestamp: number
  title: string
  excerpt: string
  status: 'pending' | 'accepted' | 'rejected'
  commentCount: number
  bookmarked: boolean
  bookmarkedAt?: number
  /** False when the saved plan remains but its provider transcript is gone. */
  sessionAvailable?: boolean
  planFilePath?: string
  revisions: PlanRevisionSummary[]
}

export type SessionScanEvent =
  | { streamId: string; type: 'batch'; sessions: SessionMeta[] }
  | { streamId: string; type: 'done'; totalSessions: number }

export interface SessionIndexUpdatedEvent {
  provider: AgentId
  projectPaths: string[]
  sessionIds: string[]
}

/** The authoritative persisted name for a session changed on its host. */
export interface SessionTitleChangedEvent {
  sessionId: string
  /** Null clears the custom name back to the opening prompt. */
  title: string | null
  source: 'generated' | 'manual'
  /** Present for generated names so the task host can apply the same metadata. */
  generatedDescription?: string
}

/** Model-generated scaffolding derived from the opening prompt. The title names
 * the session; the description fills the session-born task the agent works on. */
export interface SessionGeneratedMetadata {
  title: string
  description: string
}

export interface RunResult {
  totalCostUsd: number
  durationMs: number
  numTurns: number
  sessionId: string
}

// ─── Status Cards (inline progress for multi-step chat actions) ───

export type StatusCardStepStatus = 'pending' | 'active' | 'done' | 'error'

export interface StatusCardStep {
  /** Stable key within the card. */
  id: string
  label: string
  /** Optional supporting context, primarily for an actionable failed step. */
  detail?: string
  status: StatusCardStepStatus
}

/** A live, ordered checklist rendered inline in the conversation while a
 *  multi-step action (e.g. creating a worktree-backed session) runs. Emitted
 *  as a `status_card` event and replaced wholesale on each stage transition. */
export interface StatusCardState {
  /** Stable id so successive stage updates target the same card. */
  id: string
  title: string
  /** Icon hint for the header; the renderer maps it to a component. */
  icon?: 'git-branch' | 'server'
  status: 'active' | 'done' | 'error'
  steps: StatusCardStep[]
}

// ─── Agent conversations (one agent talking to another agent) ───

/** How the other agent entered the caller's thread. */
export type AgentConversationOrigin = 'created' | 'prompted' | 'watched'

export type AgentExchangeStatus = 'dispatched' | 'awaiting_input' | 'answered' | 'done' | 'failed' | 'interrupted'

/** One prompt→reply round-trip with another agent. `index` is dispatch order
 *  within the agent-conversation card and never renumbers. */
export interface AgentExchange {
  exchangeId: string
  index: number
  prompt: string
  delivery?: PromptDelivery
  dispatchedAt: number
  status: AgentExchangeStatus
  /** Rebuilt from persisted tool history rather than observed live. A restored
   *  dispatch may have lost its in-memory completion watcher across an app
   *  restart, so the card may eventually stop presenting it as active. */
  restored?: boolean
  /** Set while the other agent is waiting on human input mid-exchange. Kept
   *  after status 'answered' so the card still shows what was asked. */
  question?: { kind: 'question' | 'permission' | 'plan'; questionId?: string; text: string }
  /** What this side answered that question with. Only set with status 'answered'. */
  answer?: string
  reply?: string
  durationMs?: number
  toolCallCount?: number
  settledAt?: number
}

/** An agent-conversation card's message payload: one card per agent per turn.
 *  Live-updated in place by `agent_conversation_update` events; reconstructed from the
 *  transcript (tool rows + [session report] user turns) on history reload. */
export interface AgentConversationRef {
  /** `pending:<exchangeId>` until a created session reports its real id. */
  agentSessionId: string
  provider: AgentId
  /** Prompt-derived at dispatch; upgraded to the CLI slug once it lands. */
  title: string
  /** Working directory; already the worktree path for worktree-backed agents. */
  cwd: string
  model?: string
  reasoningEffort?: string
  origin: AgentConversationOrigin
  /** Launched with create_session's 'fire_and_forget' mode: no reply is owed to
   *  this conversation, so the card rests collapsed to its header. Cleared the
   *  moment this side prompts or watches the session — that is a conversation. */
  fireAndForget?: boolean
  /** The other agent was stopped, or its side ended the conversation. */
  closedByAgent?: boolean
  exchanges: AgentExchange[]
}

/** Structured agent-conversation lifecycle updates, broadcast to the caller's tabs.
 *  The model-facing [session report] prose is separate and never rendered. */
export type AgentConversationUpdate =
  | { phase: 'dispatched'; agentSessionId: string; exchangeId: string; origin: AgentConversationOrigin; prompt: string; delivery?: PromptDelivery; provider: AgentId; title: string; cwd: string; model?: string; reasoningEffort?: string; fireAndForget?: boolean; dispatchedAt: number }
  /** A card dispatched against a not-yet-existing session (create_session) binds
   *  to its real agent session id once startup resolves. Keyed by exchangeId. */
  | { phase: 'attached'; exchangeId: string; agentSessionId: string; cwd?: string }
  | { phase: 'awaiting_input'; agentSessionId: string; exchangeId: string; kind: 'question' | 'permission' | 'plan'; questionId?: string; questionText: string }
  /** This side answered the peer's question or ruled on its plan. No exchangeId
   *  — the answering tool never learns one; the tracker patches the agent's last
   *  awaiting exchange in place. */
  | { phase: 'answered'; agentSessionId: string; answerText: string }
  | { phase: 'settled'; agentSessionId: string; exchangeId: string; status: 'completed' | 'interrupted' | 'failed'; replyText: string; durationMs?: number; toolCallCount?: number; settledAt: number }
  | { phase: 'stopped'; agentSessionId: string }

// ─── Canonical Events (normalized from raw stream) ───

export type NormalizedEvent =
  | { type: 'session_init'; sessionId: string; model: string; skills: string[]; handoffFrom?: SessionHandoffLineage }
  | { type: 'text_pending' }
  | { type: 'text_chunk'; text: string; parentToolUseId?: string }
  /** Extended-thinking span boundaries. The transcript never renders the thought
   *  itself — only how long it took, folded into the following activity block. */
  | { type: 'thinking'; state: 'start' | 'stop'; parentToolUseId?: string }
  | { type: 'tool_call'; toolName: string; toolId: string; index: number; toolInput?: string; content?: string; parentToolUseId?: string; isSubagent?: boolean; subagentType?: string; startedAtMs?: number }
  | { type: 'tool_call_update'; toolId: string; index?: number; toolInput?: string; content?: string; parentToolUseId?: string }
  /** With an outcome or completedAtMs, the tool execution completed. Without
   *  either field, Claude only finished streaming the tool input; tool_result
   *  is the later execution boundary. */
  | { type: 'tool_call_complete'; index: number; toolId?: string; toolInput?: string; parentToolUseId?: string; completedAtMs?: number; outcome?: { status?: string; exitCode?: number; error?: string; declined?: boolean; durationMs?: number } }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean; parentToolUseId?: string; isAsyncLaunch?: boolean; isSubagentReport?: boolean }
  | { type: 'subagent_report'; toolUseId: string; text: string; isError?: boolean }
  | { type: 'assistant_message'; text: string; parentToolUseId?: string; isFinal?: boolean }
  | { type: 'task_complete'; result: string; costUsd: number; durationMs: number; numTurns: number; usage: UsageData; sessionId: string; permissionDenials?: Array<{ toolName: string; toolUseId: string }> }
  /** Solus's authoritative top-level turn boundary. Unlike `task_complete`, this
   *  fires only after all work owned by the turn has stopped. */
  | { type: 'turn_settled'; turnId: string; outcome: 'completed' | 'failed' | 'interrupted' | 'dead'; settledAt: number }
  | { type: 'background_task_started'; taskId: string; toolUseId?: string }
  | { type: 'background_task_progress'; taskId: string; toolUseId?: string; description?: string; toolUses?: number; totalTokens?: number; durationMs?: number; lastToolName?: string }
  | { type: 'background_task_settled'; taskId: string; status: 'completed' | 'failed' | 'stopped' | 'killed'; toolUseId?: string }
  | { type: 'error'; message: string; isError: boolean; sessionId?: string }
  | { type: 'session_dead'; exitCode: number | null; signal: string | null; stderrTail: string[] }
  | { type: 'rate_limit'; status: string; resetsAt: number; rateLimitType: string; isUsingOverage?: boolean; usedPercent?: number; windowDurationMins?: number; info?: RateLimitInfo; message?: string; deferCurrentRun?: boolean }
  | { type: 'usage'; context?: ContextUsage; run?: UsageData }
  | { type: 'model_rerouted'; fromModel: string; toModel: string; reason?: string }
  | { type: 'session_changed_files_updated'; paths: string[] }
  | { type: 'permission_request'; questionId: string; toolName: string; toolUseId?: string; toolDescription?: string; toolInput?: PermissionToolInput; options: PermissionOption[]; startedAtMs?: number }
  | { type: 'permission_resolved'; questionId: string }
  /** `kind` rides along from Codex's MCP elicitation normalizer — an elicitation
   *  form is answered with an extra `__action` entry, so anything answering this
   *  request has to be able to tell the two apart. */
  | { type: 'question_request'; questionId: string; questions: QuestionItem[]; kind?: 'standard' | 'mcp_form' | 'mcp_url' }
  /** Provider context compaction. Claude can report one completed interval by
   *  duration; Codex can report start and stop item boundaries. */
  | { type: 'context_compaction'; state: 'start' | 'stop'; trigger?: 'manual' | 'auto'; startedAtMs?: number; completedAtMs?: number; durationMs?: number }
  | { type: 'pending_input_sync'; pendingInputEvents: NormalizedEvent[] }
  | { type: 'plan'; planContent: string; planFilePath: string; questionId: string; options: PermissionOption[]; planToolUseId?: string }
  | { type: 'progress'; todos: TodoItem[]; parentToolUseId?: string }
  | { type: 'checkpoint'; checkpointId: string }
  | { type: 'git_context'; gitContext: GitCheckout }
  | { type: 'git_status'; cwd: string; state: GitState | null }
  | { type: 'user_message'; text: string; delivery?: PromptDelivery; clientPromptId?: string; imageAttachments?: Array<{ mimeType: string; dataUrl: string }>; imageAttachmentRefs?: PromptImageRef[]; via?: PromptVia; automationId?: string; automationName?: string; agentSessionId?: string; agentExchangeId?: string }
  | { type: 'prompt_queued'; text: string; queueId: string; clientPromptId?: string; enqueuedAt: number; reason?: QueuedPromptReason; releaseAt?: number; rateLimitType?: string; images?: Array<{ mimeType: string; dataUrl: string }>; imageRefs?: PromptImageRef[]; via?: PromptVia }
  | { type: 'prompt_dequeued'; queueId: string }
  | { type: 'prompt_queue_updated'; queueId: string; text: string }
  | { type: 'rate_limit_resolved'; sessionId: string; action: RateLimitDecisionAction }
  | { type: 'goal_updated'; goal: ThreadGoal }
  | { type: 'goal_cleared'; threadId: string }
  | { type: 'status_change'; status: SessionStatus; oldStatus: SessionStatus }
  | { type: 'plan_rejected'; planToolUseId: string }
  | { type: 'permission_mode_changed'; permissionMode: 'ask' | 'auto' | 'plan' }
  | { type: 'work_created'; workId: string; title: string; docType: WorkType; content: string }
  | { type: 'work_updated'; workId: string; title: string; docType: WorkType; content: string; updatedAt: string }
  /** `workId`/`title` are set when an HTML artifact was persisted as an
   *  `artifact` work; image artifacts (Codex ImageGeneration) carry neither. */
  | { type: 'artifact_created'; kind: 'html' | 'image'; html?: string; path?: string; workId?: string; title?: string }
  | { type: 'automation_saved'; automationId: string; name: string; trigger: AutomationTrigger; enabled: boolean }
  | { type: 'task_created'; taskId: string; title: string; url: string | null }
  | { type: 'browser_snapshot_captured'; snapshot: BrowserSnapshotRef }
  | { type: 'agent_conversation_update'; update: AgentConversationUpdate }

type ToolCallEvent = Extract<NormalizedEvent, { type: 'tool_call' }>
type ToolCallUpdateEvent = Extract<NormalizedEvent, { type: 'tool_call_update' }>
type ToolResultEvent = Extract<NormalizedEvent, { type: 'tool_result' }>

/** Session event shape allowed across the host-to-client boundary. */
export type WireNormalizedEvent =
  | Exclude<NormalizedEvent, ToolCallEvent | ToolCallUpdateEvent | ToolResultEvent>
  | Omit<ToolCallEvent, 'content'>
  | Omit<ToolCallUpdateEvent, 'content'>
  | { type: 'tool_result'; toolUseId: string; parentToolUseId?: string; status: 'ok' | 'error'; errorHead?: string; contentBytes: number }
  | { type: 'status_card'; card: StatusCardState }

// ─── Prompt Options ───

export type PromptDelivery = 'steer' | 'queue'

export type PromptSource = 'typed' | 'queued' | 'automation' | 'agent' | 'dispatch'

/** Non-human origin of an injected prompt. 'session-report' marks another agent's
 *  session's report — turn input for the model, never rendered as a bubble. */
export type PromptVia = 'automation' | 'session-report'

export interface PromptDispatchResult {
  /** `duplicate`: this session already accepted the same `clientPromptId` —
   *  an outbox drain replayed a delivered send, and nothing ran twice. */
  disposition: 'started' | 'steered' | 'queued' | 'duplicate'
  queueId?: string
}

export interface PromptOptions {
  prompt: string
  /** Explicit source of this turn for observability. Queue drain replaces it
   *  with `queued`; a remote execution host receives `dispatch`. */
  promptSource?: PromptSource
  /** Stable renderer-generated identity for correlating optimistic delivery state. */
  clientPromptId?: string
  /** How to deliver input when the target already has an active turn.
   *  User input defaults to steering; background callers should opt into FIFO queueing. */
  delivery?: PromptDelivery
  /** User-visible prompt text. `prompt` may include internal attachment/reference context. */
  displayPrompt?: string
  /** Image attachments sent as real content blocks rather than flattened into `prompt`.
   *  `dataUrl` is a base64 data URL (`data:<mime>;base64,<data>`). */
  imageAttachments?: Array<{ mimeType: string; dataUrl: string }>
  /** Images the host already stores, sent in place of `imageAttachments`. The
   *  host reads the bytes when it builds provider content blocks. Clients fall
   *  back to `imageAttachments` when the host cannot resolve refs. */
  imageAttachmentRefs?: PromptImageRef[]
  /** Set when a prompt is dispatched on a task-bound session. The main process
   *  hydrates the ticket into the run's system prompt, so the agent works from
   *  the task's live state without it entering the transcript. */
  taskId?: string
  /** Set on a fresh session when its automatically-created task should be a
   *  direct child of an existing top-level task. Mutually exclusive with
   *  `taskId`; task nesting remains limited to one level. */
  parentTaskId?: string
  /** Explicitly keep a fresh session outside the task system. Without this,
   *  an unbound first dispatch creates a local task from the prompt. */
  skipTaskCreation?: boolean
  /** The task's live state, shipped by the client when `taskId` names a task on
   *  a different host than the one executing this prompt (a dispatch). The
   *  execution host renders the system-prompt packet from it and serves
   *  `read_task` from the same shape; without it a foreign `taskId` is
   *  unreadable — hosts never talk to each other. */
  taskSnapshot?: TaskSnapshot
  /** Goal objective attached to a fresh session dispatch. Main persists it as
   *  soon as the provider issues the session id, before a fast turn can finish. */
  goalObjective?: string
  systemPrompt?: string
  maxTurns?: number
  maxBudgetUsd?: number
  /** Path to SOLUS-scoped settings file with hook config (passed via --settings) */
  hookSettingsPath?: string
  /** Marks the prompt as injected by an automation firing in-thread (badged on
   *  the bubble) or as an agent conversation report (suppressed from rendering). */
  via?: PromptVia
  /** Present when `via === 'session-report'`: the agent session and exchange the
   *  report settles, so the renderer can correlate without parsing prose. */
  agentSessionId?: string
  agentExchangeId?: string
  /** Source automation id/name, present when `via === 'automation'`. */
  automationId?: string
  automationName?: string
}

// ─── IPC Context ───

export interface SessionCtx {
  /** Solus's id for the conversation this context describes — the only address
   *  the host knows. Empty string when the source is a draft that has not
   *  started a session yet. */
  sessionId: string
  /** The draft this context composes for, when no session exists yet. Uploads
   *  are stored per conversation, and a draft is a conversation the user has
   *  begun — it owns a run, a working directory, and a prompt with attachments.
   *  Present only while `sessionId` is empty. */
  draftId?: string
  /** Present when this context executes a run dispatched from another host. */
  origin?: 'dispatch'
  provider: AgentId | null
  agentSessionId: string | null
  handoffFrom?: SessionHandoffLineage
  status: SessionStatus
  workingDirectory: string
  projectPath: string
  additionalDirs: string[]
  preferredModel: string | null
  reasoningEffort: ReasoningEffort
  contextWindow: number | null
  fastMode: boolean
  permissionMode: 'ask' | 'auto' | 'plan'
  gitContext: GitCheckout | null
  worktreeBaseBranch: string | null
  sessionChangedFiles: string[]
  readOnlyReason: string | null
  latestCheckpointId: string | null
  title?: string | null
  forked?: boolean
  forkExcludeLatestTurn?: boolean
  /** PR review context for this session's chat tab (null for normal sessions). */
  prReview?: PrReviewContext | null
}

export interface WindowCtx {
  viewMode: 'pill' | 'editor'
}

export type AppFontFamily = 'inter' | 'dm-sans' | 'system' | 'geist' | 'lora' | 'sf-pro-text' | 'sf-mono'
export type AppCodeFontFamily = 'sf-mono' | 'geist-mono' | 'fira-code' | 'cascadia-code' | 'jetbrains-mono' | 'system-mono'

export interface SettingsCtx {
  themeMode: 'dark' | 'light' | 'system'
  isDark: boolean
  soundEnabled: boolean
  voiceModeEnabled: boolean
  vadSilenceMs: number
  defaultEditor: EditorId | null
  /** Terminal opened only when no terminal is attached to the shared tmux session. */
  fallbackTerminal: TerminalAppId | null
  activeAgent: AgentId
  /** Effective review-companion choices used by foreground and background guide generation. */
  reviewAgent: AgentId | null
  reviewModel: string | null
  reviewReasoning: ReasoningEffort | null
  /** User instructions applied only when a review guide is authored. */
  reviewGuideInstructions: string
  /** Experimental: infer pull request lineage and present stacked PRs. */
  stackedPrsEnabled: boolean
  /** Per-project opt-in resolved by the renderer before crossing IPC. */
  reviewWarmingEnabled: boolean
  rateLimitBehavior: 'ask' | 'queue' | 'continue' | 'stop'
  fontFamily: AppFontFamily
  fontSize: number
  codeFontFamily: AppCodeFontFamily
  codeFontSize: number
  /** App-wide instructions appended to every agent system prompt. */
  extraInstructions: string
  /** Extra instructions keyed by resolved model id, appended when that model runs. */
  modelInstructions: Record<string, string>
}

export interface StatusBarCtx {
  workingDirectory: string
  activeAgent: AgentId
  permissionMode: 'ask' | 'auto' | 'plan'
  model: string
  reasoningEffort: ReasoningEffort
  defaultReasoningEffort: ReasoningEffort
  reasoningLevels: ReasoningEffort[]
  supportsFastMode: boolean
  fastMode: boolean
  contextWindows: number[]
}

export interface IpcContext {
  session: SessionCtx
  window: WindowCtx
  settings: SettingsCtx
  statusBar: StatusBarCtx
}

/**
 * The project scope a session's work is filed under. Task `targetScope`, the
 * `projectRoot` on PR events, and the renderer's per-project caches are all
 * keyed on it, and they compare for equality — so the operator matters: `??`
 * hands on `projectPath`'s empty string, `||` falls through to the working
 * directory. `||` is what the main-process producers already did.
 *
 * Not `projectRootOf` in the renderer's `run-config`, which resolves a checkout
 * back to its repo. This never touches the filesystem; `''` and `'~'` are both
 * possible answers.
 */
export function projectScopeOf(source: Pick<SessionCtx, 'projectPath' | 'workingDirectory'>): string {
  return source.projectPath || source.workingDirectory
}

/**
 * The minimal, caller-agnostic contract for running a turn against a session —
 * what the dispatch path and backends actually consume, with none of the UI
 * presentation state in IpcContext. Any system (the renderer, automations, a
 * future HTTP/MCP caller) can build this plain object directly to start, resume,
 * or send a message, instead of fabricating a full IpcContext snapshot.
 *
 * `agentSessionId` tells the backend whether to start or resume after the control
 * plane has resolved an explicit dispatch target. UI subscription state is not
 * part of this backend execution contract.
 */
export interface SessionRunInput {
  /** Resolved backend provider (no null — the caller picks before dispatch). */
  provider: AgentId
  /** null = start a new session; set = resume this session. */
  agentSessionId: string | null
  forked: boolean
  forkExcludeLatestTurn?: boolean
  workingDirectory: string
  projectPath: string
  additionalDirs: string[]
  gitContext: GitCheckout | null
  worktreeBaseBranch: string | null
  sessionChangedFiles: string[]
  contextWindow: number | null
  /** Resolved model the run uses (the value the backend actually runs with). */
  model: string
  /** The user's explicit model choice (null = "use default"); surfaced back to a
   *  reattaching client via bindRuntimeSession. Distinct from the resolved `model`. */
  preferredModel: string | null
  reasoningEffort: ReasoningEffort
  fastMode: boolean
  permissionMode: 'ask' | 'auto' | 'plan'
  rateLimitBehavior: SettingsCtx['rateLimitBehavior']
  /** App-wide instructions appended to every agent system prompt. */
  extraInstructions: string
  /** Extra instructions scoped to the model in use, resolved from settings.modelInstructions at dispatch time. */
  modelInstructions?: string
  /** PR review context — when set, the backend appends a PR-context system hint. */
  prReview?: PrReviewContext | null
  /** System-level context used only when starting a new provider session. */
  handoff?: {
    fromProvider: AgentId
    fromSessionId: string
    seedSystemAppend: string
  }
}

// ─── Control Plane Types ───

export interface BackendSession {
  /** The key of `activeSessions`. Still the provider's id until WP3 re-keys it. */
  sessionId: string
  /** The provider's thread id, for `--resume`. Null until session_init. */
  agentSessionId: string | null
  backendId: AgentId
  /** The provider conversation this one was handed off from, if any. */
  handoffFrom?: SessionHandoffLineage
  status: SessionStatus
  hasPendingInput?: boolean
  pendingInputEvents: NormalizedEvent[]
  /** The resolved run contract this session last ran with — the single source of
   *  truth for the session's config. Read by bindRuntimeSession to rehydrate a
   *  reattaching client, and by background triggers (e.g. an in-thread automation)
   *  to re-dispatch into the session with no UI snapshot to reconstruct. */
  runInput?: SessionRunInput
  gitContext?: GitCheckout
  lastActivityAt: number
  promptCount: number
  /** Solus-owned identity for the top-level turn currently running. Provider
   *  result events do not reliably identify that turn, so the control plane
   *  assigns this before dispatch and carries it through final settlement. */
  activeTurnId?: string
  /** Last turn whose terminal event was published. Prevents duplicate provider
   *  result/exit signals from settling one turn more than once. */
  settledTurnId?: string
  /** Task IDs of run_in_background sub-agents/tools still in flight. While this is
   *  non-empty the session is kept 'running' past turn end — the SDK query stays
   *  open servicing the background work and will only truly exit once it settles. */
  backgroundTaskIds?: Set<string>
}

export interface RuntimeSessionInfo {
  /** Null when the live session has no `runInput` to read the config back from —
   *  a stale exit can tear the record down and a re-`session_init` rebuild it
   *  without one. The run is still alive, so reattach must still succeed: the
   *  client keeps its own persisted config instead of losing the session. */
  modelConfig: ModelConfig | null
  permissionMode: 'ask' | 'auto' | 'plan' | null
  status: SessionStatus
  queuedPrompts: QueuedPromptSnapshot[]
  rateLimitInfo: RateLimitInfo | null
  handoffFrom?: SessionHandoffLineage
}

export interface SessionProviderSwitchResult {
  fromProvider: AgentId
  fromSessionId: string
  /** The one durable task-attempt identity change caused by this switch. The
   * client applies it to the task host, which can differ from the runtime host. */
  taskSessionMove: {
    sourceSessionId: string
    targetSessionId: string
  }
  /** Present when switching back before the target provider has started. The
   *  original session is restored instead of creating a redundant handoff. */
  restoredSessionId?: string
  /** Present while the session belongs to the new ordered handoff lookup. */
  handoffId?: string
  handoffFrom?: SessionHandoffLineage
}

export type QueuedPromptReason = 'busy' | 'rate_limit'

export interface QueuedPromptSnapshot {
  queueId: string
  clientPromptId?: string
  text: string
  enqueuedAt: number
  reason: QueuedPromptReason
  releaseAt?: number
  rateLimitType?: string
  /** Image attachments sent with the queued prompt, so the queued bubble can
   *  render them. `dataUrl` is a base64 data URL (`data:<mime>;base64,<data>`). */
  images?: Array<{ mimeType: string; dataUrl: string }>
  /** Host-stored images sent with the queued prompt. Preferred over `images`:
   *  a snapshot is re-sent on every reconnect and stays small. */
  imageRefs?: PromptImageRef[]
}

export type OutboundPromptState = 'steering' | 'queueing' | 'queued' | 'failed'

/** One renderer-side representation for every prompt waiting to be accepted,
 *  queued, or retried. `clientPromptId` is generated before dispatch and is the
 *  sole correlation key used to reconcile backend events. */
export interface OutboundPrompt {
  clientPromptId: string
  queueId?: string
  text: string
  state: OutboundPromptState
  enqueuedAt: number
  reason?: QueuedPromptReason
  releaseAt?: number
  rateLimitType?: string
  images?: Array<{ mimeType: string; dataUrl: string }>
  attachments?: Message['attachments']
  planRefs?: PlanReference[]
  workRefs?: WorkReference[]
  sessionRefs?: SessionReference[]
  error?: string
}

export interface RateLimitInfo {
  resetsAt: number
  rateLimitType: string
  prompt: string
  queuedPrompt: string
}

/** One subscription quota window (rolling 5h or weekly). */
export interface UsageWindow {
  usedPercent: number
  /** Epoch ms. Null when the provider only gives a localized label. */
  resetsAt: number | null
  /** Provider's own reset wording, when that's all we get (Claude). */
  resetsLabel: string | null
}

/** Normalized quota snapshot for one provider. Both windows are nullable:
 *  Codex accounts may not report a 5h window, and a Claude parse miss must
 *  degrade to null rather than invent a number. */
export interface AgentUsageLimits {
  provider: AgentId
  fiveHour: UsageWindow | null
  weekly: UsageWindow | null
  planType: string | null
  /** API-key sessions use metered API billing, not subscription quota windows. */
  usageMode?: 'subscription' | 'api'
  fetchedAt: number
  /** Last refresh failed — these numbers are old, not live. */
  stale: boolean
}

export type RateLimitDecisionAction = 'send_now' | 'stop' | 'wait'

export type ThreadGoalStatus = 'active' | 'paused' | 'complete' | 'blocked' | 'budgetLimited' | 'usageLimited'

export interface ThreadGoal {
  threadId: string
  objective: string
  status: ThreadGoalStatus
  tokenBudget?: number
  tokensUsed?: number
  timeUsedSeconds?: number
  createdAt?: number
  updatedAt?: number
}

export interface ThreadGoalSetRequest {
  threadId: string
  objective?: string
  status?: ThreadGoalStatus
  tokenBudget?: number
}

export interface EnrichedError {
  message: string
  stderrTail: string[]
  stdoutTail?: string[]
  exitCode: number | null
  elapsedMs: number
  toolCallCount: number
  sawPermissionRequest?: boolean
  permissionDenials?: Array<{ tool_name: string; tool_use_id: string }>
}

// ─── Session History ───

export interface SessionMeta {
  provider: AgentId
  sessionId: string
  slug: string | null
  firstMessage: string | null
  /** User-set or auto-generated session name; wins over slug/firstMessage everywhere a session is listed. */
  customTitle?: string | null
  lastTimestamp: string
  size: number
  cwd: string         // actual working directory read from the JSONL cwd field
  projectPath: string // raw encoded folder name, e.g. "-Users-sidhu-clui-cc"
  /** The Solus host holding this session. Stamped by the client that scanned it,
   *  or read from the index when a client recorded the session on a host that
   *  does not hold it — a machine cannot know which saved-server id names it, so
   *  either way this is the client's word. Absent means the host answering the
   *  read, which is every session listed before hosts were scanned. */
  serverId?: string
  isWorktree?: boolean
  status?: SessionStatus
  /** Start of the live turn, when this metadata describes an attached run. Used
   * by restored clients to resume the sidebar clock without loading history. */
  currentTurnStartedAt?: number
  model?: string
  reasoningEffort?: ReasoningEffort
  /** Git-root that groups a repo with all its worktrees. The canonical
   *  "project" key for cross-project search and grouping. */
  projectRoot?: string
  /** Branch this session attempt runs on. Session-owned because one attempt can
   *  be linked to several tasks without changing its checkout. */
  branch?: string
  /** Solus-owned lineage for a session created by another session. Provider
   *  history remains the source of conversation content; this relationship is
   *  local orchestration metadata that survives provider index refreshes. */
  delegation?: SessionDelegation
}

export interface SessionDelegation {
  parentSessionId: string
  rootSessionId: string
  exchangeId: string
  depth: number
  intent: 'delegate' | 'fire_and_forget'
  createdAt: number
}

export interface SessionSearchResult {
  session: SessionMeta
  snippet: string
  ts: number
}

export interface RecentProject {
  path: string          // decoded real path, e.g. "/Users/example/projects/solus"
  folderName: string    // last segment, e.g. "solus"
  lastOpened: string    // ISO timestamp of last open
}

// Every project Solus has seen, persisted in ~/.solus/projects/manifest.json.
export interface ProjectEntry {
  key: string           // hash of the repo root / cwd; names the ~/.solus/projects/<key> dir
  path: string          // decoded real path
  folderName: string    // last path segment
  addedAt: string       // ISO timestamp first recorded
}

/** A known checkout keyed by its normalized origin identity across hosts. */
export interface ProjectIdentity {
  path: string
  folderName: string
  /** Lowercase `host/owner/repo`, derived from the checkout's origin remote. */
  repoKey: string
}

/** A host-internal dispatch checkout that can contain session history. */
export interface DispatchHistoryRoot {
  path: string
  /** Lowercase `host/owner/repo`, matching ProjectIdentity.repoKey. */
  repoKey: string
}

// ─── Agent Types ───

export interface AgentMetadata {
  id: AgentId
  label: string
  models: Array<{ id: string; label: string }>
  defaultModel: string
  available?: boolean
  unavailableReason?: string
  binaryPath?: string
  capabilities?: {
    planMode?: boolean
    permissions?: boolean
    fileRewind?: boolean
    terminalResume?: boolean
    transport?: string
  }
}

/** One currently configured target for agent-created work. Unlike the static
 *  model profile table, this reflects the backends actually registered on the
 *  connected host and whether their binaries are currently available. */
export interface AgentTarget {
  provider: AgentId
  label: string
  available: boolean
  unavailableReason?: string
  defaultModel: string
  models: Array<{
    id: string
    label: string
    reasoningLevels: ReasoningEffort[]
    defaultReasoningEffort: ReasoningEffort
    defaultContextWindow: number | null
  }>
}

export interface StartInfo {
  version: string
  auth?: { email?: string; subscriptionType?: string; authMethod?: string }
  mcpServers?: string[]
  projectPath: string
  homePath: string
  workspacePath: string
  agents: AgentMetadata[]
}

export interface TextGenerationModelSelection {
  provider: AgentId
  model: string
}

/** Where this host sends its own telemetry. A host setting, not a device one:
 *  the exporter runs beside the server, so a phone configuring OTel is
 *  configuring the machine it is connected to. */
export interface OtelSettings {
  /** Master switch. Off means nothing leaves the machine, whatever else is set. */
  enabled: boolean
  /** Base OTLP/HTTP endpoint, e.g. `https://otlp.example.com`. Signal paths
   *  (`/v1/traces`) are appended per signal. */
  endpoint: string
  /** `key=value` pairs, comma separated — how a hosted collector is authorized. */
  headers: string
  exportMetrics: boolean
  /** Every span Solus records and the structured log events attached to it. */
  exportTraces: boolean
}

/** What is exporting right now — the answer to "is this actually on?", which
 *  the saved settings alone cannot give once the environment overrides them. */
export interface OtelActiveSignals {
  metrics: boolean
  traces: boolean
}

export interface OtelSettingsSnapshot {
  settings: OtelSettings
  /** True when `OTEL_EXPORTER_OTLP_*` env vars are set on the host. They win,
   *  and the form goes read-only rather than pretending to control the export. */
  managedByEnvironment: boolean
  active: OtelActiveSignals
}

export interface TextGenerationSettings {
  /** General-purpose model for metadata and other short background writing. */
  textGenerationModel: TextGenerationModelSelection
  /** Used when the preferred model is not available on the host. */
  backupTextGenerationModel: TextGenerationModelSelection
  /** Optional override for commit, branch, and pull-request writing. */
  sourceControlWriterModel: TextGenerationModelSelection | null
  /** Host-wide policy applied in the repository where each Git action runs. */
  sourceControlWriting: SourceControlWritingPreferences
}

export interface TextGenerationSettingsSnapshot extends TextGenerationSettings {
  effectiveTextGenerationModel: TextGenerationModelSelection
  effectiveSourceControlWriterModel: TextGenerationModelSelection
  agents: AgentMetadata[]
}

export type SourceControlWritingMode =
  | 'repo_conventions'
  | 'conventional_commits'
  | 'custom'

export interface SourceControlWritingPreferences {
  mode: SourceControlWritingMode
  customInstructions: string
  followPullRequestTemplate: boolean
}

export const DEFAULT_SOURCE_CONTROL_WRITING: SourceControlWritingPreferences = {
  mode: 'repo_conventions',
  customInstructions: '',
  followPullRequestTemplate: true,
}

/** Per-project settings read on the project's owner host. */
export interface ProjectConfig {
  version: 1
  /** Which task provider this project uses. Absent = local (the default). */
  taskProvider?: TaskProviderId
  /** Where the chosen provider points. `owner`/`repo` belong to GitHub and are
   *  auto-filled from the git remote; `cloudId`/`projectKey` belong to Jira and
   *  are chosen explicitly, because no Jira project can be inferred from a
   *  checkout. Only the fields of the configured `taskProvider` are read. */
  taskProviderConfig?: {
    owner?: string
    repo?: string
    cloudId?: string
    projectKey?: string
  }
  /** Local comments remain private unless this is enabled or a caller opts in. */
  tasksAutoPushComments?: boolean
  /** Move in-review tasks to done when their linked pull request merges. */
  taskDoneOnMerge?: boolean
}

// ─── Editor / Terminal Types ───

/**
 * Every editor and terminal Solus knows, as runtime values. These are the one
 * source of truth: the ids are validated at the client I/O boundary and
 * persisted in settings, and a second hand-written copy of either list silently
 * dropped every id it had not heard of — which is how newly added editors
 * reached the host but never the Settings dropdown.
 */
export const EDITOR_IDS = [
  'vscode',
  'cursor',
  'zed',
  'sublime',
  'intellij',
  'pycharm',
  'webstorm',
  'goland',
  'datagrip',
  'dataspell',
  'phpstorm',
  'rubymine',
  'vim',
  'nvim',
  'helix',
  'emacs',
] as const
export type EditorId = (typeof EDITOR_IDS)[number]

export const TERMINAL_APP_IDS = [
  'default-terminal',
  'ghostty',
  'iterm2',
  'wezterm',
  'kitty',
  'alacritty',
] as const
export type TerminalAppId = (typeof TERMINAL_APP_IDS)[number]

export interface DetectedEditor {
  id: EditorId
  name: string
  isTerminal: boolean
  /** Shell command, when one is installed. */
  binPath: string | null
}

export interface DetectedTerminal {
  id: TerminalAppId
  name: string
}

/** Which terminal "Open in terminal" will use right now. */
export interface ResolvedTerminal {
  /** Catalog id when Solus knows the app, null for one it can only detect. */
  id: TerminalAppId | null
  name: string
  /** `attached` when a terminal already holds the shared tmux session. */
  source: 'attached' | 'fallback'
}

export interface TerminalLaunchRequest {
  command: string
  /** Terminal to open only when no terminal is attached to the shared tmux session. */
  fallbackTerminalId: TerminalAppId
  cwd?: string
}

export interface OpenInEditorRequest {
  filePaths: string[]
  editorId: EditorId
  fallbackTerminalId?: TerminalAppId
  cwd?: string
}

export interface FilePreviewRequest {
  path: string
  cwd?: string
}

export interface ProjectFilesRequest {
  cwd?: string
  /** The files pane also draws folders, so it needs the ones no file reveals. */
  includeEmptyDirectories?: boolean
}

export type ProjectFilesResult =
  | {
      ok: true
      root: string
      files: string[]
      /** Root-relative, trailing-slash directory paths holding no indexed file.
       *  Present only when the request asked for them. */
      emptyDirectories?: string[]
      truncated: boolean
      source: 'index'
    }
  | {
      ok: false
      root?: string
      error: string
    }

export interface ProjectContentSearchRequest {
  /** Whitespace is significant in a content query, so it is never trimmed. */
  query: string
  /** Search root. Callers pass the session's environment cwd, which already
   *  resolves to the worktree path when the session runs in one. */
  cwd?: string
  caseSensitive: boolean
  wholeWord: boolean
  useRegex: boolean
}

/** Half-open `[start, end)` offsets into `lineContent`, in string indices. */
export interface ProjectContentMatchRange {
  start: number
  end: number
}

export interface ProjectContentMatch {
  /** Path relative to the search root. */
  path: string
  /** 1-based. */
  lineNumber: number
  lineContent: string
  matchRanges: ProjectContentMatchRange[]
}

export type ProjectContentSearchResult =
  | {
      ok: true
      matches: ProjectContentMatch[]
      /** More matches exist than were returned (limit or time budget hit). */
      truncated: boolean
      /** Set when a regex failed to compile and the engine fell back to a
       *  literal search — the query ran, but not as the user meant it. */
      regexError?: string
    }
  | {
      ok: false
      error: string
    }

export interface WriteFileRequest {
  path: string
  contents: string
  /** `base64` carries binary payloads — image exports — over a string field. */
  encoding?: 'utf8' | 'base64'
  cwd?: string
  expectedContents?: string
  /**
   * Where the write is allowed to land. `project` (the default) confines the
   * path to `cwd`'s root, which is what an editor saving a file it opened from
   * the tree wants. `host` is the user picking a destination themselves in the
   * directory picker — an export — so the root guard would only get in the way.
   */
  destination?: 'project' | 'host'
}

export type WriteFileResult =
  | {
      ok: true
      path: string
      displayPath: string
      size: number
    }
  | {
      ok: false
      path: string
      error: string
      conflict?: boolean
    }

/**
 * A structural change to the project's file tree. Paths are root-relative and
 * posix-separated; a folder path may carry a trailing slash. `createFile` and
 * `createFolder` never overwrite — an existing entry is reported as an error so
 * the tree can put the user back in the rename input.
 */
export type ProjectFileMutation =
  | { op: 'createFile'; path: string }
  | { op: 'createFolder'; path: string }
  | { op: 'rename'; path: string; toPath: string }
  | { op: 'delete'; path: string }

export interface ProjectFileMutationRequest {
  cwd?: string
  mutation: ProjectFileMutation
}

export type ProjectFileMutationResult =
  | {
      ok: true
      /** Root-relative path the entry now lives at; empty for a delete. */
      path: string
    }
  | {
      ok: false
      error: string
    }

/** A file-autocomplete result row, fully resolved by the backend. */
/**
 * A platform-agnostic key combo, structurally identical to the renderer's
 * keybindings `KeyCombo`. Used by the OS summon-shortcut RPCs so the main
 * process doesn't import renderer code. `mod` = Command on macOS, Control else.
 */
export interface AppShortcutCombo {
  code: string
  alt?: boolean
  shift?: boolean
  meta?: boolean
  ctrl?: boolean
  mod?: boolean
}

/** The two OS-level "summon Solus" shortcuts (desktop-only). */
export interface AppGlobalShortcuts {
  primary: AppShortcutCombo
  secondary: AppShortcutCombo
}

/** Accelerators that couldn't be live-registered (caller offers a restart). */
export interface SetAppGlobalShortcutsResult {
  failed: string[]
}

export interface FileMatch {
  /** Absolute path, no trailing slash. */
  path: string
  /** What the menu renders: cwd-relative inside the project, absolute outside. */
  display: string
  isDir: boolean
}

export interface DirectoryEntry {
  name: string
  isDir: boolean
  path: string
  // The three fields below are only populated when `listDirectory` is asked to
  // annotate, and are best-effort: an unreadable folder simply stays bare.
  /** The folder is a git checkout. */
  isRepo?: boolean
  /** The checked-out branch, when it resolves from `.git/HEAD`. */
  branch?: string
  /** Solus already knows this folder as a project on this host. */
  isProject?: boolean
}

export interface DirectoryListResult {
  entries: DirectoryEntry[]
  parentPath: string | null
  currentPath: string
  error: string | null
}

export interface CreateDirectoryResult {
  /** Host-resolved absolute path, with `~` already expanded. */
  path: string
  error: string | null
}

export type FilePreviewResult =
  | {
      ok: true
      path: string
      displayPath: string
      contents: string
      size: number
      /** Files outside the active project can be previewed but not edited. */
      isReadOnly: boolean
      /** `contents` holds only the first slice of the file. Editing is disabled
       *  in this state — saving would write the truncation back to disk. */
      truncated?: boolean
      mimeType?: string
    }
  | {
      ok: false
      path: string
      error: string
    }

// ─── Plugin Commands ───

export interface PluginCommand {
  name: string
  description: string
  argumentHint?: string
  kind?: 'command' | 'skill'
  path?: string
}

/** A slash command reported by the agent's SDK init (built-ins, custom, skills). */
export interface AgentSlashCommand {
  name: string
  description: string
  argumentHint?: string
  aliases?: string[]
}

export interface PluginCommandsResult {
  global: PluginCommand[]
  project: PluginCommand[]
  /** Built-in agent commands reported live by the SDK (claude-code only). */
  builtin?: AgentSlashCommand[]
}

// ─── IPC Payloads ───

export type SkillState = 'pending' | 'downloading' | 'validating' | 'installed' | 'failed' | 'skipped'

/** Emitted on `solus:skill-status` to report skill install progress. */
export interface SkillStatus {
  name: string
  state: SkillState
  error?: string
  reason?: 'up-to-date' | 'user-managed'
}

// ─── skills.sh registry (opt-in install) ───

/** A skill returned by the skills.sh registry search API. */
export interface RemoteSkill {
  /** The `owner/repo@skill` install target passed verbatim to `skills add`. */
  id: string
  /** Display name — the skill segment after `@`, or the repo's last path part. */
  name: string
  /** `owner/repo` the skill lives in. */
  repo: string
  /** Raw install-count label from the registry (e.g. "444.8K"); undefined if unknown. */
  installs?: string
  /** Canonical skills.sh page for the skill. */
  url: string
}

/** Result of installing a skill across the active providers. */
export interface SkillInstallResult {
  ok: boolean
  /** Providers the skill was installed into (the active backends at install time). */
  agents: AgentId[]
  error?: string
}

// ─── Git Context Types ───

/**
 * Where managed worktrees live, relative to the project root.
 *
 * Inside the git directory, not the working tree. `.git` is not part of the
 * checkout, so no project has to ignore this — not in `.gitignore`, not in an
 * editor, not in a search tool. Solus already owns `.git/solus/` for session
 * snapshots, so worktrees join an existing namespace rather than inventing one.
 *
 * Several segments, not one: join it, never assume a single directory name.
 */
export const SOLUS_WORKTREE_DIR = '.git/solus/worktrees'
export const SOLUS_WORKTREE_PATH_MARKER = `/${SOLUS_WORKTREE_DIR}/`

/**
 * Encode a filesystem path the way Claude Code names its on-disk project folders
 * (`~/.claude/projects/<encoded>/`): every non-alphanumeric character becomes
 * `-`, not just slashes. Paths containing dots — notably worktrees under
 * `.git/solus/worktrees` — must use this or the folder won't resolve and the
 * session `.jsonl` / plan files come back empty. Codex uses it only as an
 * internal grouping key, so consistency is all that matters there.
 */
export function encodePathAsFolder(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

/** True if `path` lives inside a Solus-managed worktree (`<root>/.git/solus/worktrees/<slug>`). */
export function isSolusWorktreePath(path: string): boolean {
  return path.includes(SOLUS_WORKTREE_PATH_MARKER)
}

/**
 * Marker segment of a delegated remote-dispatch checkout
 * (`<root>/solus-remote/<login>/<owner>/<repo>`). These clones are created to
 * run a session on another machine; they are host-internal plumbing, never a
 * project the user opened, so they must stay out of recents.
 */
export const SOLUS_REMOTE_DISPATCH_DIR = 'solus-remote'
export const SOLUS_REMOTE_DISPATCH_PATH_MARKER = `/${SOLUS_REMOTE_DISPATCH_DIR}/`

/** True if `path` lives inside a delegated remote-dispatch checkout. */
export function isRemoteDispatchCheckoutPath(path: string): boolean {
  return path.includes(SOLUS_REMOTE_DISPATCH_PATH_MARKER)
}

/** The base project root for a worktree path, or `path` unchanged when it isn't a worktree. */
export function worktreeProjectRoot(path: string): string {
  const idx = path.indexOf(SOLUS_WORKTREE_PATH_MARKER)
  return idx === -1 ? path : path.slice(0, idx)
}

/** `SOLUS_WORKTREE_PATH_MARKER` as it appears inside an encoded Claude folder name. */
export const SOLUS_WORKTREE_ENCODED_MARKER = encodePathAsFolder(SOLUS_WORKTREE_PATH_MARKER)

export interface GitCheckout {
  /** The branch or worktree branch the session is running in */
  branch: string | null
  /** Present when the checkout is detached instead of being on a named branch. */
  detachedHeadSha?: string
  /** Remote default branch — always present so DiffPanel always has a diff target */
  targetBranch: string
  /** Only present when running in worktree isolation */
  worktreePath?: string
  /** Absolute path of the git repo root (rev-parse --show-toplevel) */
  repoRoot?: string
}

export function gitCheckoutFromState(
  status: GitIdentity | null | undefined,
  worktreePath?: string,
): GitCheckout | null {
  if (!status) return null
  const checkout: GitCheckout = {
    branch: status.branch,
    targetBranch: status.targetBranch,
    repoRoot: status.repoRoot,
  }
  if (status.branch === null) checkout.detachedHeadSha = status.headSha
  if (worktreePath) checkout.worktreePath = worktreePath
  return checkout
}

export interface GitCheckoutBranchResult {
  success: boolean
  gitContext?: GitCheckout
  error?: string
}

export interface WorktreeEntry {
  path: string
  branch: string
  lastModified?: number
}

// ─── Automations ───
//
// An Automation is a saved unit of work that submits a prompt to an agent using
// a frozen model / reasoning / permission configuration. Phase 2 adds local,
// time-based triggers (manual / one-time / interval / cron) on top of the Phase 1
// run-now substrate. Scheduling is local-only — triggers fire while Solus is open
// and catch up missed fires on the next launch.

/**
 * Run outcomes. `dispatched` is the terminal state of an in-session run: the
 * prompt was handed into its chat thread, whose turn owns the real outcome —
 * we deliberately don't claim `succeeded` for work we didn't observe finish.
 */
export type AutomationRunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'dispatched'

/**
 * What causes an automation to run. Phase 2 ships time-based triggers only
 * (event triggers are a later phase).
 *  - `manual`   — only runs when explicitly triggered (run-now). Phase 1 default.
 *  - `once`     — runs a single time at an absolute instant, then disables itself.
 *  - `interval` — repeats every N minutes while Solus is open.
 *  - `cron`     — repeats on a standard 5-field cron expression in an optional
 *                 IANA timezone (daily/weekly/monthly presets compile to this).
 */
export type AutomationTrigger =
  | { type: 'manual' }
  | { type: 'once'; runAt: string }
  | { type: 'interval'; everyMinutes: number }
  | { type: 'cron'; expr: string; timezone?: string }

export type AutomationTriggerType = AutomationTrigger['type']

/** The frozen "how to run it" config — mirrors the per-session model picker. */
export interface AutomationAction {
  /** The instruction submitted to the agent verbatim (no templating in Phase 1). */
  prompt: string
  agentProvider: AgentId
  /** null → the agent's default model. */
  modelId: string | null
  reasoningEffort: ReasoningEffort
  /** Working directory the run executes in. */
  cwd: string
  /**
   * When set, the run is dispatched *into this existing agent session* — it
   * resumes that chat thread with full conversation context and posts its prompt
   * as an in-thread message (badged "Sent via automation") rather than spawning
   * an isolated headless run. This is what powers "check every minute in this
   * chat" heartbeat automations. The id is the originating session's
   * agentSessionId, captured at create time. `useWorktree` is ignored for these.
   */
  sessionId?: string
  /**
   * When true, the run executes in a fresh git worktree branched off `cwd`
   * instead of mutating the working directory directly. Isolates unattended
   * changes so the user can review them as a branch.
  */
  useWorktree?: boolean
  /**
   * Plan references embedded in the prompt (via `#`). Resolved to context
   * blocks when the run fires. The plan source (file path or content) is
   * captured at save time because a headless run can't locate it otherwise.
   */
  planRefs?: AutomationPlanRef[]
  /**
   * Work/doc references embedded in the prompt (via `%`). Their on-disk path is
   * derived fresh at run time so the agent always reads the latest version.
   */
  workRefs?: WorkReference[]
}

/** A plan reference stored on an automation, with its source resolved at save. */
export interface AutomationPlanRef {
  planId: string
  title: string
  /** Path to the plan markdown the agent should read, when known. */
  filePath?: string
  /** Inline plan content — used as a fallback when no file path exists. */
  content?: string
}

/** Provenance — who authored the automation (a human via UI, or an agent). */
export interface AutomationCreator {
  kind: 'user' | 'agent'
  agentProvider?: AgentId
  sessionId?: string
}

export interface Automation {
  id: string
  name: string
  enabled: boolean
  /** User-pinned to the top of the list. Defaults to false. */
  favorite?: boolean
  action: AutomationAction
  /** What causes the automation to run. Defaults to `{ type: 'manual' }`. */
  trigger: AutomationTrigger
  /**
   * Next scheduled fire as an ISO-8601 UTC instant. Undefined for manual
   * triggers and for one-time triggers that have already fired. The scheduler
   * persists this so a fire missed while the app was closed is caught up on the
   * next launch (a stale `nextRunAt <= now` means "overdue → run once now").
   */
  nextRunAt?: string
  createdAt: string
  updatedAt: string
  createdBy: AutomationCreator
  lastRunId?: string
  lastRunStatus?: AutomationRunStatus
  lastRunAt?: string
}

/** One execution instance of an automation. */
export interface AutomationRun {
  id: string
  automationId: string
  startedAt: string
  finishedAt?: string
  status: AutomationRunStatus
  /** Final assistant text captured from the run. */
  output?: string
  /** Session id of the spawned agent run, for opening it as a session later. */
  agentSessionId?: string | null
  /** Branch the run's isolated worktree was created on (useWorktree runs only),
   *  so the user can find the work the run produced. */
  branch?: string
  /** Exact directory the isolated run executed in. Required to find provider
   *  transcripts whose on-disk project key includes the worktree path. */
  worktreePath?: string
  /** Populated when status is 'failed'. */
  error?: string
}

export interface AutomationsManifest {
  version: 1
  automations: Record<string, Automation>
}

/**
 * Published as `automation.changed` whenever the main-process
 * automation store mutates — saves, deletes, scheduler fires, run transitions —
 * so every client stays live without polling (scheduled runs fire with no
 * renderer involvement at all).
 */
export type AutomationsChangedEvent =
  | { kind: 'saved'; automation: Automation }
  | { kind: 'deleted'; automationId: string }
  | { kind: 'run-started'; automation: Automation; run: AutomationRun }
  | { kind: 'run-updated'; automation: Automation; run: AutomationRun }
  | { kind: 'run-finished'; automation: Automation; run: AutomationRun }

// ─── Git provider integration ───
// Renderer-facing surface for the code-host provider adapter (see
// src/main/providers). Only the auth-status shapes cross the IPC boundary; the
// host-neutral review DTOs (PullRequest, ReviewThread, …) live in
// src/main/providers/types.ts and never reach the renderer until PR review mode.

/** Code-host providers we can authenticate against. GitHub only for v1. */
export type ProviderId = 'github'

export interface AuthStatus {
  connected: boolean
  /** Host username, cached after the first authenticated `/user` call. */
  login?: string
  scopes?: string[]
}

/** Device-flow prompt streamed to the renderer while `providerConnect` polls. */
export interface DeviceCodePrompt {
  userCode: string
  verificationUri: string
  expiresIn: number
}

export * from './git-types'

// RPC method names live in `shared/rpc.ts`; host event contracts live in
// `shared/host-events.ts`. Requests use one `{ id, method, args }` envelope.
