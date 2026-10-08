import type { QueueEntryDetails, QueueAttachment } from './session-queue'
import type { WireSessionLoadMessage } from './session-history'
import type { WorkExternalComments, WorkGoogleComments } from './work-comments'
import rawModelProfiles from './model-profiles.json'
import type { GitIdentity, GitState, WorktreeEntry } from './git-types'
import type { TaskProviderId, TaskSnapshot } from './task-types'
import type { PrReviewTarget, PullRequest } from './providers'
import type { BrowserRecordingRef, BrowserSnapshotRef } from './browser-types'
import type { DeviceRunProfile } from './device-types'
import type { WorkExternalLink } from './docs'
import type { Attribution, User } from './user'
import type { Activity } from './activity'
import type { MediaType } from './media-types'
import type { WorktreeBranchNaming } from './worktree-branch-naming'
import type { ExecutionPreferenceSnapshot, ExecutionPreferences } from './settings'
import type { ExchangeOutcome, ExchangeRequest, SessionOutput } from './session-exchange'
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

/** What one authenticated host can do and what it has, from
 * `serverGetCapabilities`. Missing keys are unsupported so newer clients remain
 * safe when connected to older hosts. Some fields answer for the caller: a
 * cloud member's projects folder is their own. */
export interface HostCapabilities {
  /** The host build's version, for the per-host skew notice. */
  version?: string
  /** What the machine calls itself, from the operating system. `/health` withholds
   *  this over a tunnel, so an authenticated connection is the only way a remote
   *  client learns the friendly name — and the only one that stays current when
   *  the machine is renamed. */
  name?: string
  attachUpload?: boolean
  /** The host reads `PromptOptions.imageAttachmentRefs` from its own attachment
   *  store. Without it a client sends image bytes inline on every turn. */
  promptImageRefs?: boolean
  assetUrls?: boolean
  skillsInstall?: boolean
  skillsSearch?: boolean
  skillsManage?: boolean
  voiceModel?: boolean
  automations?: boolean
  editors?: EditorId[]
  githubProvider?: boolean
  /** This host runs the browser domain: it can discover dev-server targets and
   *  hold browser pages. Whether a page can actually be *rendered* is a client
   *  fact (a native surface), not a host one. */
  browser?: boolean
  /** The host can record browser pages to MP4: it has a Chromium that can run
   *  the recording encoder. */
  browserRecording?: boolean
  /** The host accepts streamed uploads through `attachUploadToken`, so a client
   *  can send files larger than the RPC limit, such as videos. */
  attachStreamUpload?: boolean
  atlassianProvider?: boolean
  /** This host checks its own Solus release and its providers' releases. */
  hostUpdates?: boolean
  /** This host gets the model list from GitHub and serves it (`modelProfilesStatus`). */
  modelProfiles?: boolean
  /** The host runs without a window: no Electron main process. */
  headless?: boolean
  /** The desktop main process registered its handlers (screenshots, design mode, native dialogs). */
  desktopHandlers?: boolean
  /** Which agent CLIs the host found on its PATH. */
  agents?: { claude: boolean; codex: boolean }
  /** The local transcription model is installed. */
  dictation?: boolean
  platform?: string
  /** Projects this caller can see on the host. */
  projectCount?: number
  agentAuth?: { claude: boolean }
  gitAuth?: { github: boolean }
  /** The folder new projects and clones land in for this caller: the setting,
   *  else `SOLUS_PROJECTS_ROOT`, else `~/projects`; a cloud member's own folder. */
  projectsBaseDirectory?: string
  /** The owner chose `projectsBaseDirectory` in Settings, so "reset" has a default to return to. */
  projectsBaseDirectoryIsSet?: boolean
}

export type SetupAgent = 'claude' | 'codex'
/** Signing an agent in is a seat connect (`seats.ts`), not a setup step. */
export type SetupStreamStep =
  | 'install-claude' | 'install-codex' | 'install-git' | 'install-gh' | 'clone'
export type SetupStepStatus = 'running' | 'done' | 'failed'

export interface SetupLogEvent {
  step: SetupStreamStep
  line: string
}

export interface SetupStatusEvent {
  step: SetupStreamStep
  status: SetupStepStatus
  error?: string
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
  /** Origin branch to work on. The checkout is used when it holds the branch;
   *  otherwise the branch gets its own worktree. Absent: the default branch. */
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
  /** Clone every branch and its full history, fetching file contents only when needed. Set for a Run-on dispatch checkout. */
  partialClone?: boolean
}

/** The command that installs a package on a host, and whether Solus may run it unattended. */
export interface PackageInstallCommand {
  display: string
  /** False when the command needs sudo we don't have — the client shows it to copy instead. */
  autoRunnable: boolean
  /** The install action in the host's own terms, such as "Install Apple developer tools". Omitted means "Install <package>". */
  label?: string
  /** What the user still does after Solus runs the command, when it only opens an installer. */
  followUp?: string
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
  /** What fills the window, by content. Absent on providers with no such report. */
  categories?: ContextUsageCategory[]
  /** Per-item detail behind the categories — which MCP tool, which memory file. */
  groups?: ContextUsageGroup[]
}

/** One row of the window-by-content breakdown, as the provider accounts for it. */
export interface ContextUsageCategory {
  name: string
  tokens: number
  /**
   * An out-of-window tool schema the provider loads on demand. It is reported
   * for awareness and excluded from the usage total, so the meter shows the
   * count without a share of the window.
   */
  deferred?: boolean
}

export interface ContextUsageDetailItem {
  name: string
  tokens: number
  /** Where it came from — MCP server, memory scope, skill or agent source. */
  detail?: string
}

/** An expandable section under the categories, such as every MCP tool. */
export interface ContextUsageGroup {
  label: string
  tokens: number
  items: ContextUsageDetailItem[]
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
  /** The id the new session takes. A caller that watches the session before it
   *  starts chooses it; absent, the host chooses one. */
  sessionId?: string
  prompt: string
  provider: AgentId
  modelId: string | null
  reasoningEffort: ReasoningEffort
  contextWindow: number | null
  cwd: string
  /** Start the session in a new worktree from this branch. */
  worktreeBaseBranch?: string | null
  /** The requester's preferences for this session (plans/018 §6); absent means the built-in defaults. */
  executionPreferences?: ExecutionPreferences
  /** The agent session on another host that started this one (docs/plans/cross-host-sessions.md). */
  startedBy?: SessionOrigin
  /** Images already uploaded to this host's attachment store, sent with the prompt. */
  imageAttachmentRefs?: PromptImageRef[]
}

/** A prompt to an existing session from an agent on another host. The session
 *  runs it with its own stored settings, as when an agent on this host sends one. */
export interface HeadlessPromptRequest {
  sessionId: string
  prompt: string
  delivery: PromptDelivery
  /** Echoed as the `clientPromptId` of the session's `user_message`, so the
   *  sender can tell the turn that answers this prompt from any other. */
  promptId: string
  /** Images already uploaded to this host's attachment store. */
  imageAttachmentRefs?: PromptImageRef[]
}

/** The agent session on another host that started a session. The host it names
 *  is shown by its label; the session id is that host's own. */
export interface SessionOrigin {
  hostLabel: string
  sessionId: string
}

// ─── Model Profiles ───

export interface ModelProfile {
  label: string
  isDefault?: boolean
  /** A superseded generation. Still fully selectable, but pickers keep it behind
   *  a disclosure so the list reads as the models we expect people to pick. */
  isLegacy?: boolean
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
  isLegacy: z.boolean().optional(),
  reasoningLevels: z.array(reasoningEffortSchema),
  defaultReasoningEffort: reasoningEffortSchema,
  supportsFastMode: z.boolean(),
  contextWindows: z.array(z.number()),
  defaultContextWindow: z.number(),
})
const providerModelProfilesSchema = z.record(z.string(), modelProfileSchema)
/** The published model list. A host parses a download or its cache with this at the I/O boundary. */
export const modelProfilesSchema = z.object({
  'claude-code': providerModelProfilesSchema.optional(),
  codex: providerModelProfilesSchema.optional(),
  opencode: providerModelProfilesSchema.optional(),
})

export type ModelProfiles = z.infer<typeof modelProfilesSchema>

/** The list this build shipped with: what a host runs on until it has a newer one. */
export const BUNDLED_MODEL_PROFILES: ModelProfiles = modelProfilesSchema.parse(rawModelProfiles)

/**
 * The model list in effect in this process. A host replaces it with the list
 * published on GitHub (`docs/model-profiles.md`), so a new model needs no new
 * build. Read it at the time of use; never copy a provider's entries at import.
 */
export const MODEL_PROFILES: ModelProfiles = structuredClone(BUNDLED_MODEL_PROFILES)

/**
 * Put `next` in effect. Each provider's map is emptied and refilled in place,
 * so a module that holds `MODEL_PROFILES['claude-code']` reads the new list.
 */
export function replaceModelProfiles(next: ModelProfiles): void {
  for (const provider of ['claude-code', 'codex', 'opencode'] as const) {
    const incoming = next[provider] ?? {}
    const current = MODEL_PROFILES[provider]
    if (!current) {
      MODEL_PROFILES[provider] = structuredClone(incoming)
      continue
    }
    for (const modelId of Object.keys(current)) delete current[modelId]
    Object.assign(current, structuredClone(incoming))
  }
}

/** The models a provider offers and the one it starts on. */
export interface ProviderModels {
  models: Array<{ id: string; label: string }>
  defaultModel: string
}

/** The models a provider offers and the one it starts on, from the list in effect. */
export function providerModelsFor(provider: AgentId): ProviderModels {
  const profiles = Object.entries(MODEL_PROFILES[provider] ?? {})
  return {
    models: profiles.map(([id, profile]) => ({ id, label: profile.label })),
    defaultModel: profiles.find(([, profile]) => profile.isDefault)?.[0] ?? '',
  }
}

/** Where a host's model list came from, and when it last asked GitHub. */
export interface ModelProfilesStatus {
  /** `remote` once the host has a published list; `bundled` before that, or after the cache was cleared. */
  source: 'bundled' | 'remote'
  /** When the list in effect was downloaded. Null for the bundled list. */
  fetchedAt: number | null
  /** When the host last asked GitHub, whatever the answer. */
  checkedAt: number | null
  checking: boolean
  /** Why the last check failed. Null after a check that succeeded. */
  error: string | null
  profiles: ModelProfiles
}

/** The context window Claude runs a model at when it is not asked for the
 *  `[1m]` long-context variant. */
const CLAUDE_STANDARD_CONTEXT_WINDOW = 200_000

/** A model id as a provider reported running it, split into the selectable
 *  model id and the context window the variant names. Claude reports its
 *  long-context variant as `<model>[1m]`; the bare id runs the standard window.
 *  Other providers name no window in the id, so theirs is null. */
export function runtimeModelVariant(
  provider: string | null | undefined,
  runtimeModelId: string,
): { modelId: string; contextWindow: number | null } {
  if (provider !== 'claude-code') return { modelId: runtimeModelId, contextWindow: null }
  return runtimeModelId.endsWith('[1m]')
    ? { modelId: runtimeModelId.slice(0, -4), contextWindow: 1_000_000 }
    : { modelId: runtimeModelId, contextWindow: CLAUDE_STANDARD_CONTEXT_WINDOW }
}

/** A provider can report a runtime variant instead of the selectable model id.
 * Resolve that variant through the same profile so user-facing surfaces do not
 * leak backend syntax such as Claude's `[1m]` suffix. */
export function modelLabelFor(
  provider: AgentId | null | undefined,
  modelId: string | null | undefined,
): string | null {
  if (!modelId) return null
  if (!provider) return modelId
  const selectableModelId = runtimeModelVariant(provider, modelId).modelId
  return MODEL_PROFILES[provider]?.[selectableModelId]?.label ?? modelId
}

/**
 * A superseded model the pickers collapse behind a disclosure. A model the host
 * reports but the profile table does not know is treated as current: an unknown
 * model is more likely a new one than an old one, and hiding it would make it
 * unreachable rather than merely quiet.
 */
export function isLegacyModel(
  provider: AgentId | null | undefined,
  modelId: string | null | undefined,
): boolean {
  if (!provider || !modelId) return false
  return MODEL_PROFILES[provider]?.[modelId]?.isLegacy === true
}

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
  /** The agent ended its turn, but a background task it started (a shell, a
   *  sub-agent) still runs. The turn is settled and a prompt steers into the
   *  still-open provider query; Stop ends the background work. */
  | 'background'
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

/**
 * Why a pending permission or question can no longer be answered. The host
 * owns this state. `run_ended`: the run that asked it exited, stopped, or died.
 * `closed`: the host does not hold it now — another client answered it, or the
 * host restarted. A card with an expiry shows the reason and no answer controls.
 */
export type RequestExpiry = 'run_ended' | 'closed'

/** The host refuses an answer to a request it does not hold now. */
export const REQUEST_NOT_ANSWERABLE_CODE = 'REQUEST_NOT_ANSWERABLE'

export function requestExpiryText(expiry: RequestExpiry): string {
  return expiry === 'run_ended'
    ? 'No longer answerable — the run ended.'
    : 'No longer answerable — it was answered elsewhere or closed.'
}

export interface PermissionRequest {
  questionId: string
  toolTitle: string
  toolDescription?: string
  toolInput?: PermissionToolInput
  options: Array<{ optionId: string; kind?: string; label: string }>
  /** Whose turn asks, as the host stamped it; live only. */
  turnAuthor?: User
  /** Set when the request can no longer be answered. */
  expired?: RequestExpiry
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

export interface QuestionAnswer {
  questionId: string
  questions: QuestionItem[]
  answers: Record<string, string>
}

export interface QuestionRequest {
  questionId: string
  questions: QuestionItem[]
  /** An answer to this question is sent as a new message, not a provider callback. */
  responseMode?: 'message'
  kind?: 'standard' | 'mcp_form' | 'mcp_url'
  message?: string
  url?: string
  serverName?: string
  canDecline?: boolean
  canCancel?: boolean
  /** Whose turn asks, as the host stamped it; live only. */
  turnAuthor?: User
  /** Set when the request can no longer be answered. A message-mode question
   *  never expires with its run: it is answered by a new message. */
  expired?: RequestExpiry
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

/** Bounded, transport-safe attachment context for naming a session. File bytes
 * travel only through the existing image lanes below; client-local paths and
 * design payloads never cross to another host. */
export interface SessionMetadataAttachment {
  name: string
  type: 'image' | 'file' | 'design-selection'
  mimeType?: string
  size?: number
}

export interface SessionMetadataGenerationContext {
  /** The session being named. The host runs one generation per session at a
   *  time, and a concurrent request for the same session joins it. */
  sessionId?: string
  attachments?: SessionMetadataAttachment[]
  imageAttachments?: Array<{ mimeType: string; dataUrl: string }>
  imageAttachmentRefs?: PromptImageRef[]
  /** The requester's writing preferences (`textGenerationModel`); absent means the built-in default. */
  executionPreferences?: ExecutionPreferences
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
  designData?: DesignModeSelection
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
  pageURL?: string
  viewport?: { width: number; height: number }
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
 * How much an agent may do without asking. Each value maps to the provider's
 * own permission mode (Claude) or approval policy and sandbox (Codex); Solus
 * keeps no allow rules of its own. See docs/plans/permission-modes.md.
 */
export const PERMISSION_MODES = ['supervised', 'accept-edits', 'auto', 'full-access', 'plan'] as const
export type PermissionMode = (typeof PERMISSION_MODES)[number]

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
  permissionMode: PermissionMode
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
 * Where the session a composer starts will be filed: under a task that exists,
 * or under none. A session never makes a task of its own — a task is made by
 * a person, an agent, a ticket or an automation, and a session joins it
 * (docs/plans/task-conversation.md, decision 8).
 *
 * Never reaches the backend: `SessionRunInput` has no task field, because task
 * membership is a `task_session_links` row written once the session exists.
 */
export type TaskTarget =
  /** `role: 'lead'` starts the session as the task's lead: the one session
   *  that owns the task page's conversation. Absent, an ordinary attempt. */
  | { kind: 'existing'; taskId: string; role?: 'lead' }
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
  /** PR context carried by a composer opened from a pull request. Optional so
   *  drafts saved before this field existed still restore normally. */
  prReview?: PrReviewContext | null
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

/** Everything a client needs to open a saved session, in one read: the lineage
 *  behind it and the metadata of the member that answers for it today — the
 *  active member when it has a transcript, else the transcript that was asked
 *  for. `meta` is null when no transcript is indexed for that member. */
export interface SessionDescription {
  lineage: SessionLineageResolution | null
  meta: SessionMeta | null
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
  queueVersion?: number
  queueHeld?: boolean
  id: string
  run: RunConfig
  /** The agent session on another host that started this one (docs/plans/cross-host-sessions.md). */
  startedBy?: SessionOrigin
  agentSessionId: string | null
  /** A provider switch waits for the new provider's first thread: the host
   *  holds the session although it has no thread now. */
  handoffPending?: boolean
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
  /** Renderer-local: when this session's first dated message was sent, kept
   *  across a reload. A restored tab loads its transcript only when selected,
   *  so without this its sidebar row would have no start time until opened
   *  and would move when it was. */
  startedAt?: number | null
  isStreamingText: boolean
  isReconnecting: boolean
  permissionQueue: PermissionRequest[]
  questionQueue: QuestionRequest[]
  permissionDenied: { tools: Array<{ toolName: string; toolUseId: string }> } | null
  /** Prompts submitted while a turn cannot start immediately. Client-only
   *  optimistic state is reconciled with server queue snapshots and events. */
  outboundPrompts: OutboundPrompt[]
  rateLimitInfo: RateLimitInfo | null
  lastResult: RunResult | null
  /** What currently occupies the context window. Drives the context meter. */
  contextUsage: ContextUsage | null
  /** Cumulative token spend for the completed run (from task_complete). Not in
   *  the window — reported separately so neither number reads as the other. */
  runUsage: UsageData | null
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
  /** Opaque cursor for the next disjoint history page; null means exhausted. */
  historyCursor?: string | null
  /** Results/nested activity whose owning call is on an older history page. */
  historyPendingMessages?: WireSessionLoadMessage[]
  /** Prior provider identity retained by a worktree move within the same session.
   *  A separate fork records its source on the transcript divider instead. */
  forkedFromSessionId: string | null
  /** True until the fork initializes, so the provider branches from agentSessionId. */
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
   * A fork carries `{ kind: 'existing', taskId }` for the source's exact task.
   * The first dispatch links the new session to that task.
   */
  task: TaskTarget
  /** Set when this session is the chat tab of a PR review (worktree = PR head).
   *  Drives the `'pr'` diff scope and PR-scoped tab routing. */
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
  /** Resolved model from the session index, when available. */
  model?: string | null
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

export interface PlanCommentReply {
  id: string
  /** Who wrote it, stamped by the host. Absent only on a reply the reader has
   *  just written and the host has not stamped yet. */
  author?: Attribution
  text: string
  /** Epoch ms. */
  createdAt: number
}

/** Where an artifact comment sits: a point over the render, as fractions of its
 *  box, so the pin rides the render at every pane width. */
export interface CommentPin {
  x: number
  y: number
}

/** One person's last read of a thread. Read marks are per person on a shared
 *  work; `readAt` is the single-reader mark plans still use. */
export interface CommentReadMark {
  userId: string
  readAt: number
}

export interface PlanComment {
  /** A private discussion about a Google thread; never an outbound message. */
  externalThreadId?: string
  /** Legacy private Google discussion reference. */
  googleThreadId?: string
  id: string
  /** The anchor's display text: the quoted selection (docs/plans), the node label (diagrams), or the pin's label (artifacts). */
  selectedText: string
  comment: string
  textOffset?: number
  /** For diagram works: id of the node this comment is anchored to. Absent = whole diagram. */
  nodeId?: string
  /** For diagram works: id of the edge this comment is anchored to. Mutually exclusive with nodeId. */
  edgeId?: string
  /** For artifact works: the point over the render this comment is pinned to. Absent = the whole artifact. */
  pin?: CommentPin
  /** Who wrote the thread, stamped by the host from the admitted actor; a client
   *  never names itself. Absent only on a thread the reader has just written and
   *  the host has not stamped yet. */
  author?: Attribution
  /** Epoch ms. Absent on pre-existing comments, which render without a time. */
  createdAt?: number
  /** Epoch ms the thread was resolved. Absent = open. */
  resolvedAt?: number
  /** Who resolved it, stamped by the host like `author`. */
  resolvedBy?: Attribution
  replies?: PlanCommentReply[]
  /** Epoch ms the thread was last read. A Solus message newer than this is unread. */
  readAt?: number
  /** Per-person read marks on a shared work; the host writes the caller's. */
  readBy?: CommentReadMark[]
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

/** A provider context compaction, drawn as a transcript divider. Each field is
 *  present only when the provider reports it: Claude records the trigger and
 *  the token counts, Codex records only that a compaction happened. */
export interface ContextCompaction {
  trigger?: 'manual' | 'auto'
  preTokens?: number
  postTokens?: number
  /** Live only: the compaction started and has not stopped. A client sets it
   *  from the `context_compaction` start event; history never carries it. */
  isRunning?: boolean
}

export interface Message {
  /** In-memory answer receipt; reload uses only existing provider history. */
  questionAnswer?: QuestionAnswer
  /** A system row that marks a context compaction. Live from the
   *  `context_compaction` stop event, and read back with the history. */
  compaction?: ContextCompaction
  /** A system row that is one activity the host recorded (plans/012 §5): a stop,
   *  a decision, a rename. Live from the `activity` event, and read back with the
   *  history, so it survives a reload. */
  activity?: Activity
  questionResult?: string
  id: string
  role: 'user' | 'assistant' | 'tool' | 'system' | 'plan'
  content: string
  toolName?: string
  toolId?: string
  toolIndex?: number
  toolInput?: string
  historyToolInput?: import('./session-history').DeferredToolInput
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
   *  It folds into the block's summary as "Thought for 6s". */
  thinkingMs?: number
  /** The agent's thoughts immediately before this tool call or prose block, in
   *  order, as the provider wrote them (markdown). Collapsed in the transcript
   *  until opened. Absent when the provider sent no readable reasoning. */
  thoughts?: string[]
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
  workRef?: { workId: string; title: string; workType?: WorkType; contentVersion?: number }
  /** A rendered visual artifact (render_artifact tool) shown flush in the
   *  conversation. `pending` is true while the tool call is still in flight.
   *  An HTML artifact also carries `workRef` once it is persisted as an
   *  `artifact` work, so the frame can open it in a pane and link it. */
  /** `pending` is the skeleton, before any markup has arrived. `streaming` is
   *  the render that has one but is still being written: it renders live and
   *  reloads as more lands, and is what `artifact_created` fills in. */
  artifact?: {
    /** Originating render_artifact call, used to correlate concurrent streams. */
    toolId?: string
    kind: 'html' | 'image'
    html?: string
    path?: string
    pending?: boolean
    streaming?: boolean
    /** Successful saved revision, used to ignore repeated update delivery. */
    updatedAt?: string
  }
  /** Reference to an automation the agent created or updated in this thread,
   *  rendered as a card with an Open action. */
  automationRef?: { automationId: string; name: string; trigger: AutomationTrigger; enabled: boolean }
  /** Reference to a task the agent created in this thread, rendered as a card
   *  that opens the task board focused on the new task. */
  taskRef?: { taskId: string; title: string; url: string | null }
  /** A capture the agent took of a browser page, rendered as the picture it saw
   *  rather than a line saying it looked. */
  browserSnapshot?: BrowserSnapshotRef
  /** Images this tool call returned, shown under its step. */
  toolImages?: ToolResultImage[]
  /** A recording the agent made of a browser page, rendered as a player. */
  browserRecording?: BrowserRecordingRef
  /** Agent-conversation card for another agent this thread is driving
   *  (start_session / send_session). One message per
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
  /** Set on a user message that an automation injected into this
   *  thread, so the bubble can render its origin badge. Live-only (not persisted
   *  to the transcript), so it's lost on a history reload. */
  via?: PromptVia
  automationId?: string
  automationName?: string
  /** Correlates the committed transcript entry with its optimistic outbox row. */
  clientPromptId?: string
  /** Who wrote this prompt, as the host stamped it. Live-only, like `via`: a
   *  history reload does not know, and the bubble then carries no name. */
  author?: User
  /** How this message entered an already-running session. */
  delivery?: PromptDelivery
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

export interface WorkMeta {
  /** The canonical organization (organization-scope §3, R10): `local` while unassigned, else an organization id that never changes. */
  organizationId: string
  title: string
  preview: string
  type: WorkType
  createdAt: string
  /** When the record last changed, body or metadata. It is the record's
   *  concurrency token (the HTTP ETag), not a content version and not a history
   *  id: a title change moves it, and it never names a revision. */
  updatedAt: string
  /** Origin session (kept for back-compat). Prefer `sessionIds` for resume. */
  sessionId?: string
  /** Every session that has collaborated on this work, oldest→newest. */
  sessionIds?: string[]
  agentProvider: AgentId
  cwd: string
  /** Pinned works sort to the top of the gallery. */
  pinned?: boolean
  /** The upstream doc this work mirrors, when the user has published or
   *  imported it. Absent for the great majority of works, which are local only. */
  mirroredDoc?: WorkExternalLink
}

export interface Work extends WorkMeta {
  id: string
  content: string
  /** The body's version: one step for each accepted change to `content`. An
   *  equal body and a metadata-only change leave it alone; a restore to earlier
   *  content still advances it. This, not `updatedAt`, is the precondition for
   *  a content write made from an earlier read. */
  contentVersion: number
  /** `sha256` of `content`: recognizes identical bodies (an undo, a restore).
   *  Never a substitute for the `contentVersion` precondition. */
  contentHash: string
  /** Who wrote the current body, taken from the admitted request, never from a
   *  label the client supplies. Null is a body written before Solus recorded
   *  authors; it is never guessed. */
  contentAuthor: Attribution | null
}

/** Why a checkpoint was captured. `baseline` is the first body a work had in
 *  history; `checkpoint` is a body captured before another write displaced it
 *  (and every revision stored before reasons existed); `agent`, `upstream`, and
 *  `restore` are the bodies those writes produced; `review` is a body a
 *  reviewer pinned. */
export type WorkRevisionReason = 'baseline' | 'checkpoint' | 'agent' | 'upstream' | 'review' | 'restore'

/** One immutable checkpoint of a work body. `revisionId` is scoped to the
 *  work. It stores the body exactly as it was when captured, with that body's
 *  version, author, and hash. */
export interface WorkRevisionSummary {
  workId: string
  revisionId: number
  reason: WorkRevisionReason
  /** The work's `contentVersion` for this body; null for a revision stored
   *  before content versions existed. */
  sourceContentVersion: number | null
  /** Who wrote this body; null when nobody recorded it. */
  author: Attribution | null
  contentHash: string
  capturedAt: string
}

export interface WorkRevision extends WorkRevisionSummary {
  content: string
}

/** `worksExport`: write a work's stored content to a path on the host that
 *  runs the call — Markdown for a document, JSON for a diagram or slides, HTML
 *  for an artifact. The work row stays where it is; the file is a copy. */
export interface WorkExportRequest {
  workId: string
  /** The destination file, absolute or `~`-relative on the host. */
  path: string
}

export interface WorkExportResult {
  /** The resolved host path the file was written to. */
  path: string
  bytes: number
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
  contentVersion?: number;
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

/** A plan's id: its session and its tool use (docs/plans/session-identity.md).
 *  Never the provider thread that holds it. */
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
  /** Host-owned shared discussion snapshot. Private comment saves cannot change it. */
  externalComments?: WorkExternalComments
  /** Legacy Google snapshot; migrated by the host on next refresh. */
  googleComments?: WorkGoogleComments
  version: 1
  workId: string
  comments: PlanComment[]
  updatedAt: number
}

/** The comparison and revert target of a work: the body the last agent write,
 *  upstream pull, or restore displaced. */
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
  /** Explicit recovery choices: `worktree` after an isolated checkout fails to
   *  prepare; `connect-github` when a host could not clone without the account's
   *  GitHub connection, with `recoveryUrl` naming the account's Connections page. */
  recovery?: 'worktree' | 'connect-github'
  recoveryUrl?: string
}

// ─── Agent conversations (one agent talking to another agent) ───

/** How the other agent entered the caller's thread. */
export type AgentConversationOrigin = 'created' | 'prompted'

/** Where one exchange stands. `lost` is a message the transcript opened whose
 *  reply never arrived and that the host no longer carries — a restart ended it. */
export type AgentExchangeStatus = 'dispatched' | 'queued' | 'running' | 'awaiting_input' | 'rate_limited' | 'waiting_for_children' | 'answered' | 'done' | 'failed' | 'interrupted' | 'lost'

/** One prompt→reply round-trip with another agent. `index` is dispatch order
 *  within the agent-conversation card and never renumbers. */
export interface AgentExchange {
  messageId: string
  index: number
  prompt: string
  delivery?: PromptDelivery
  dispatchedAt: number
  status: AgentExchangeStatus
  /** What the other agent's turn is waiting on a person for. Kept after it is
   *  answered so the card still shows what was asked. */
  request?: ExchangeRequest
  /** What a person answered, one line each. */
  answers?: string[]
  /** While `rate_limited`: when the provider's limit resets and the turn resumes. */
  rateLimitedUntil?: number
  reply?: string
  /** References to what the turn produced: answered questions, plans, works,
   *  changed files, a pull request, sessions it started. */
  outputs?: SessionOutput[]
  /** The child's task, from the report. */
  taskId?: string
  durationMs?: number
  toolCallCount?: number
  settledAt?: number
}

/** An agent-conversation card's message payload: one card per agent per turn.
 *  Live-updated in place by `agent_conversation_update` events; reconstructed from the
 *  transcript (tool rows + [session report] user turns) on history reload. */
export interface AgentConversationRef {
  /** The other session. Known from dispatch, before its provider starts. */
  sessionId: string
  /** A session start_session created, before its provider started: there is
   *  nothing to open, prompt or track yet. */
  starting?: boolean
  provider: AgentId
  /** Prompt-derived at dispatch; upgraded to the CLI slug once it lands. */
  title: string
  /** Working directory; already the worktree path for worktree-backed agents. */
  cwd: string
  model?: string
  reasoningEffort?: string
  origin: AgentConversationOrigin
  /** Started with start_session's `report` off: no reply is owed to
   *  this conversation, so the card rests collapsed to its header. Cleared the
   *  moment this side prompts or watches the session — that is a conversation. */
  fireAndForget?: boolean
  /** The other agent was stopped, or its side ended the conversation. */
  closedByAgent?: boolean
  exchanges: AgentExchange[]
}

/**
 * A message a session sent that the host still carries: its turn has not
 * settled, waiting on nested work, or has a reply waiting for the sender.
 * Stored host receipts keep queued work, pending reports, and final outcomes
 * visible after a restart. Closed receipts are retained for safe retries.
 */
/** Where the host says one exchange stands when a transcript is read. The
 *  transcript keeps what was sent; only the host knows what happened since. */
export interface ExchangeProgress {
  state: 'queued' | 'running' | 'awaiting_input' | 'rate_limited' | 'waiting_for_children' | 'reply_queued' | 'settled'
  outcome?: ExchangeOutcome
  request?: ExchangeRequest
  /** While `rate_limited`: when the turn resumes. */
  resetsAt?: number
}

/** Structured agent-conversation lifecycle updates, broadcast to the sender's
 *  tabs by the host's session orchestrator — the only thing that emits them.
 *  The model-facing [session report] text is separate and never rendered. */
export type AgentConversationUpdate =
  | { phase: 'dispatched'; sessionId: string; messageId: string; origin: AgentConversationOrigin; prompt: string; delivery?: PromptDelivery; provider: AgentId; title: string; cwd: string; model?: string; reasoningEffort?: string; fireAndForget?: boolean; dispatchedAt: number }
  /** A started session's checkout is known: the card shows where it runs. */
  | { phase: 'attached'; messageId: string; sessionId: string; cwd?: string }
  /** The target accepted the message: its turn started, it waits behind the
   *  target's current turn, or it joined that turn as a steer. */
  | { phase: 'accepted'; sessionId: string; messageId: string; state: 'queued' | 'running' | 'waiting_for_children' }
  | { phase: 'awaiting_input'; sessionId: string; messageId: string; request: ExchangeRequest }
  /** A person answered what the message's turn was waiting on, from any surface. */
  | { phase: 'answered'; sessionId: string; messageId: string; answerText: string }
  /** The target's turn is parked on a provider limit and resumes on its own at
   *  `resetsAt`; `accepted` with `running` follows when it does. */
  | { phase: 'rate_limited'; sessionId: string; messageId: string; resetsAt?: number; limitType?: string }
  | { phase: 'settled'; sessionId: string; messageId: string; status: ExchangeOutcome; replyText: string; outputs?: SessionOutput[]; taskId?: string; durationMs?: number; toolCallCount?: number; settledAt: number }
  | { phase: 'stopped'; sessionId: string }

// ─── Canonical Events (normalized from raw stream) ───

/**
 * An image a tool returned (an MCP image block, a Read of a picture, a device
 * screenshot). The host keeps the bytes in its asset store; the transcript
 * carries only this reference, and a client loads the picture through a signed
 * asset URL when it is on screen. `width` and `height` are the pixel size when
 * the host could read it, so a client can reserve the box before it loads.
 */
export interface ToolResultImage {
  assetId: string
  mimeType: string
  width?: number
  height?: number
}

export type NormalizedEvent =
  | { type: 'model_routed'; provider: AgentId; modelConfig: ModelConfig; usedFallback: boolean }
  | { type: 'session_init'; sessionId: string; model: string; skills: string[]; handoffFrom?: SessionHandoffLineage }
  | { type: 'text_pending' }
  | { type: 'text_chunk'; text: string; parentToolUseId?: string; streaming?: boolean }
  /** Extended-thinking span boundaries. The transcript renders how long it took
   *  and keeps `text` on the tool call or prose block that follows.
   *  `text` is the span's reasoning, on `stop` only, when the provider sent any. */
  | { type: 'thinking'; state: 'start' | 'stop'; parentToolUseId?: string; text?: string }
  | { type: 'tool_call'; toolName: string; toolId: string; index: number; toolInput?: string; content?: string; parentToolUseId?: string; isSubagent?: boolean; subagentType?: string; startedAtMs?: number }
  | { type: 'tool_call_update'; toolId: string; index?: number; toolInput?: string; content?: string; parentToolUseId?: string; toolImages?: ToolResultImage[] }
  /** With an outcome or completedAtMs, the tool execution completed. Without
   *  either field, Claude only finished streaming the tool input; tool_result
   *  is the later execution boundary. */
  | { type: 'tool_call_complete'; index: number; toolId?: string; toolInput?: string; parentToolUseId?: string; completedAtMs?: number; outcome?: { status?: string; exitCode?: number; error?: string; declined?: boolean; durationMs?: number } }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean; parentToolUseId?: string; isAsyncLaunch?: boolean; isSubagentReport?: boolean; toolImages?: ToolResultImage[] }
  | { type: 'subagent_report'; toolUseId: string; text: string; isError?: boolean }
  | { type: 'subagent_running'; toolUseId: string }
  | { type: 'assistant_message'; text: string; parentToolUseId?: string; isFinal?: boolean }
  | { type: 'task_complete'; result: string; costUsd: number; durationMs: number; numTurns: number; usage: UsageData; sessionId: string; permissionDenials?: Array<{ toolName: string; toolUseId: string }> }
  /** Solus's authoritative top-level turn boundary. Unlike `task_complete`, this
   *  fires only after all work owned by the turn has stopped. */
  | { type: 'turn_settled'; turnId: string; outcome: 'completed' | 'failed' | 'interrupted' | 'dead'; settledAt: number }
  | { type: 'background_task_started'; taskId: string; toolUseId?: string }
  | { type: 'background_task_progress'; taskId: string; toolUseId?: string; description?: string; toolUses?: number; totalTokens?: number; durationMs?: number; lastToolName?: string }
  | { type: 'background_task_settled'; taskId: string; status: 'completed' | 'failed' | 'stopped' | 'killed'; toolUseId?: string }
  /** `kind: 'auth'`: the provider refused the turn's login. The client offers sign-in again. */
  | { type: 'error'; message: string; isError: boolean; sessionId?: string; kind?: 'auth' }
  | { type: 'session_dead'; exitCode: number | null; signal: string | null; stderrTail: string[] }
  /** `resetsAt` is epoch seconds from the provider. The server fills missing
   * resets from cached usage and applies its retry buffer before publication.
   * Null means no automatic release and no countdown.
   * `turnAuthor`, on this and on `permission_request` and `question_request`: whose
   * turn raised it, stamped by the host from the running turn's actor (plan 004 F2).
   * Live only; absent for the host's own work. */
  | { type: 'rate_limit'; status: string; resetsAt: number | null; rateLimitType: string; isUsingOverage?: boolean; windowDurationMins?: number; info?: RateLimitInfo; deferCurrentRun?: boolean; turnAuthor?: User }
  /** Quota windows a provider reported mid-stream. Both agents send these on
   *  nearly every turn, which is what keeps the usage store current enough to
   *  answer the moment a limit lands. */
  | { type: 'usage_limits'; windows: UsageWindowUpdate[] }
  | { type: 'usage'; context?: ContextUsage; run?: UsageData }
  | { type: 'model_rerouted'; fromModel: string; toModel: string; reason?: string }
  | { type: 'session_changed_files_updated'; paths: string[] }
  | { type: 'permission_request'; questionId: string; toolName: string; toolUseId?: string; toolDescription?: string; toolInput?: PermissionToolInput; options: PermissionOption[]; startedAtMs?: number; turnAuthor?: User }
  /** Who decided is an `activity` of its own; this event only clears the request.
   *  With `expired`, nobody answered: the host closed the request (its run ended),
   *  and clients keep the card, without answer controls, to say why. */
  | { type: 'permission_resolved'; questionId: string; decision?: PermissionDecision; expired?: RequestExpiry }
  /** `kind` rides along from Codex's MCP elicitation normalizer — an elicitation
   *  form is answered with an extra `__action` entry, so anything answering this
   *  request has to be able to tell the two apart. */
  | { type: 'question_answered'; answer: QuestionAnswer; timestamp: number }
  | { type: 'question_request'; questionId: string; questions: QuestionItem[]; responseMode?: 'message'; kind?: 'standard' | 'mcp_form' | 'mcp_url'; turnAuthor?: User }
  /** Provider context compaction. Claude can report one completed interval by
   *  duration and its token counts; Codex can report start and stop item
   *  boundaries. A stop that is not `failed` draws the compaction divider. */
  | { type: 'context_compaction'; state: 'start' | 'stop'; trigger?: 'manual' | 'auto'; startedAtMs?: number; completedAtMs?: number; durationMs?: number; preTokens?: number; postTokens?: number; failed?: boolean }
  | { type: 'pending_input_sync'; pendingInputEvents: NormalizedEvent[] }
  | { type: 'plan'; planContent: string; planFilePath: string; questionId: string; options: PermissionOption[]; planToolUseId?: string }
  | { type: 'progress'; todos: TodoItem[]; parentToolUseId?: string }
  | { type: 'git_context'; gitContext: GitCheckout }
  | { type: 'git_status'; cwd: string; state: GitState | null }
  | { type: 'user_message'; text: string; delivery?: PromptDelivery; clientPromptId?: string; imageAttachments?: Array<{ mimeType: string; dataUrl: string }>; imageAttachmentRefs?: PromptImageRef[]; via?: PromptVia; automationId?: string; automationName?: string; author?: User }
  | { type: 'prompt_queued'; text: string; queueId: string; clientPromptId?: string; enqueuedAt: number; reason?: QueuedPromptReason; releaseAt?: number; rateLimitType?: string; images?: Array<{ mimeType: string; dataUrl: string }>; imageRefs?: PromptImageRef[]; via?: PromptVia; author?: User }
  | { type: 'prompt_dequeued'; queueId: string }
  | { type: 'session_queue'; held: boolean; entries: QueuedPromptSnapshot[] }
  | { type: 'provider_switch_applied'; provider: AgentId; modelConfig: ModelConfig; result: SessionProviderSwitchResult | null }
  | { type: 'prompt_queue_updated'; queueId: string; text: string }
  | { type: 'rate_limit_resolved'; sessionId: string; action: RateLimitDecisionAction }
  /** One thing a person (or the host) did to the session that people read: a
   *  stop, a decision, a rename (plans/012 §5). The host stored it first. */
  | { type: 'activity'; activity: Activity }
  | { type: 'goal_updated'; goal: ThreadGoal }
  | { type: 'goal_cleared'; threadId: string }
  | { type: 'status_change'; status: SessionStatus; oldStatus: SessionStatus }
  | { type: 'plan_rejected'; planToolUseId: string }
  | { type: 'permission_mode_changed'; permissionMode: PermissionMode }
  | { type: 'work_created'; workId: string; title: string; docType: WorkType; content: string }
  | { type: 'work_updated'; toolId?: string; workId: string; title: string; docType: WorkType; content: string; updatedAt: string; contentVersion?: number }
  /** `workId`/`title` are set when an HTML artifact was persisted as an
   *  `artifact` work; image artifacts (Codex ImageGeneration) carry neither. */
  | { type: 'artifact_created'; toolId?: string; kind: 'html' | 'image'; html?: string; path?: string; workId?: string; title?: string }
  | { type: 'automation_saved'; automationId: string; name: string; trigger: AutomationTrigger; enabled: boolean }
  | { type: 'task_created'; taskId: string; title: string; url: string | null }
  | { type: 'browser_snapshot_captured'; snapshot: BrowserSnapshotRef }
  | { type: 'browser_recording_captured'; recording: BrowserRecordingRef }
  | { type: 'agent_conversation_update'; update: AgentConversationUpdate }

type ToolCallEvent = Extract<NormalizedEvent, { type: 'tool_call' }>
type ToolCallUpdateEvent = Extract<NormalizedEvent, { type: 'tool_call_update' }>
type ToolResultEvent = Extract<NormalizedEvent, { type: 'tool_result' }>

/** Session event shape allowed across the host-to-client boundary. */
export type WireNormalizedEvent =
  | Exclude<NormalizedEvent, ToolCallEvent | ToolCallUpdateEvent | ToolResultEvent>
  | Omit<ToolCallEvent, 'content'>
  | Omit<ToolCallUpdateEvent, 'content'>
  | { type: 'tool_result'; toolUseId: string; parentToolUseId?: string; status: 'ok' | 'error'; errorHead?: string; contentBytes: number; toolImages?: ToolResultImage[] }
  | { type: 'status_card'; card: StatusCardState }

// ─── Prompt Options ───

export type PromptDelivery = 'steer' | 'queue'

export type PromptSource = 'typed' | 'queued' | 'automation' | 'agent' | 'dispatch'

/** Origin of a prompt delivered outside the normal input bar. 'session-report' marks another agent's
 *  session's report — turn input for the model, never rendered as a bubble.
 *  'background-command' is a command the agent left running that finished
 *  after its turn ended. 'question-answer' delivers an async answer whose
 *  visible receipt is the structured Q&A row. */
export type PromptVia = 'automation' | 'background-command' | 'session-report' | 'question-answer' | 'pull-request-watch'

export interface PromptDispatchResult {
  /** `duplicate`: this session already accepted the same `clientPromptId` —
   *  an outbox drain replayed a delivered send, and nothing ran twice. */
  disposition: 'started' | 'steered' | 'queued' | 'duplicate'
  queueId?: string
}

export interface PromptOptions {
  queueAttachments?: QueueAttachment[]
  queueAttachmentContext?: string
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
  /** The task's live state, shipped by the client when `taskId` names a task on
   *  a different host than the one executing this prompt (a dispatch). The
   *  execution host renders the system-prompt packet from it and serves
   *  `read_task` from the same shape; without it a foreign `taskId` is
   *  unreadable — hosts never talk to each other. */
  taskSnapshot?: TaskSnapshot
  /** The role this session's task link is written with. Only `lead` is ever
   *  sent: the session started from a task page's conversation composer. The
   *  execution host writes the link once the session id exists, so the role
   *  has to ride the first prompt. Absent means a `working` attempt. */
  taskRole?: 'lead'
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
  permissionMode: PermissionMode
  gitContext: GitCheckout | null
  worktreeBaseBranch: string | null
  sessionChangedFiles: string[]
  readOnlyReason: string | null
  title?: string | null
  forked?: boolean
  forkExcludeLatestTurn?: boolean
  /** PR review context for this session's chat tab (null for normal sessions). */
  prReview?: PrReviewContext | null
  /**
   * The organization the sending window is working in (organization-scope §3,
   * R11): the one an unassigned Local session may be assigned to, once, when
   * that organization's Insights policy applies. Never reassigns a session.
   */
  organizationId?: string
}

/** The bundled interface presets. A font preference (`FontFamilyPreference` in
 *  host-config) is one of these ids or the name of a family installed on the
 *  client, so these lists are the presets, not the whole choice. */
export type AppFontFamily = 'inter' | 'dm-sans' | 'system' | 'geist' | 'lora' | 'sf-pro-text' | 'sf-mono'
export type AppCodeFontFamily = 'sf-mono' | 'geist-mono' | 'fira-code' | 'cascadia-code' | 'jetbrains-mono' | 'system-mono'

/** The sender's choices a host reads for one request. */
export interface SettingsCtx {
  /** This device's terminal, for a launch on the client's own machine. Never applied to a remote host. */
  fallbackTerminal: TerminalAppId | null
  activeAgent: AgentId
  /** Effective review-companion choices used by foreground and background guide generation. */
  reviewAgent: AgentId | null
  reviewModel: string | null
  reviewReasoning: ReasoningEffort | null
  /** User instructions applied only when a review guide is authored. */
  reviewGuideInstructions: string
  /** Per-project opt-in resolved by the renderer before crossing IPC. */
  reviewWarmingEnabled: boolean
  /**
   * The sender's personal preferences the host reads while it runs this work
   * (plans/018 §6), including instructions and rate-limit behavior. Strict: a bad
   * value refuses the request.
   */
  executionPreferences: ExecutionPreferences
}

export interface StatusBarCtx {
  workingDirectory: string
  activeAgent: AgentId
  permissionMode: PermissionMode
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
  permissionMode: PermissionMode
  rateLimitBehavior: 'ask' | 'queue' | 'continue' | 'stop'
  /** App-wide user instructions added through the provider's instruction extension point. */
  extraInstructions: string
  /** Extra instructions scoped to the model in use, resolved from the sender's execution preferences at dispatch time. */
  modelInstructions?: string
  /** System-level context used only when starting a new provider session. */
  handoff?: {
    fromProvider: AgentId
    fromSessionId: string
    seedSystemAppend: string
  }
  /**
   * The acting person's preferences, captured when this run was requested, so a
   * queued or resumed run keeps them and another client's later edit cannot
   * change it mid-run (plans/018 §6). Absent: built-in defaults.
   */
  executionPreferences?: ExecutionPreferences
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
  permissionMode: PermissionMode | null
  status: SessionStatus
  queuedPrompts: QueuedPromptSnapshot[]
  rateLimitInfo: RateLimitInfo | null
  handoffFrom?: SessionHandoffLineage
}

export interface WatchSessionInput {
  /** The session's id. A thread id never names a session
   *  (docs/plans/session-identity.md). */
  sessionId: string
  /** Also attach to the live runtime, as `bindRuntimeSession` would, so a
   *  client joining a session pays one round trip rather than two. */
  attachRuntime?: boolean
}

export interface WatchSessionResult {
  /** Set when `attachRuntime` was asked for: null means no live runtime. */
  runtime?: RuntimeSessionInfo | null
  /** Questions that remain open after their Codex turn has ended. */
  pendingQuestions?: QuestionRequest[]
}

export interface SessionProviderSwitchResult {
  fromProvider: AgentId
  fromSessionId: string
  /** Present when switching back before the target provider has started. The
   *  original thread is restored instead of creating a redundant handoff. */
  restoredSessionId?: string
  handoffFrom?: SessionHandoffLineage
}

/** How an accepted plan's implementation starts (plans/012 §5). */
export interface AcceptPlanRequest {
  planId: string
  /** Hand the session to this agent first; the implementation runs there. */
  provider?: AgentId
  /** Start a fresh agent session that carries only the plan. A provider change
   *  never resets: its handoff already starts the next agent's session. */
  startNewSession: boolean
}

export interface AcceptPlanResult {
  /** The provider switch the host made, for the client to adopt. */
  handoff?: SessionProviderSwitchResult
}

export type QueuedPromptReason = 'busy' | 'rate_limit'

export interface QueuedPromptSnapshot extends QueueEntryDetails {
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
  /** Who wrote the held prompt, stamped by the host; absent for the host's own work. */
  author?: User
}

export type OutboundPromptState = 'steering' | 'queueing' | 'queued' | 'failed'

/** One renderer-side representation for every prompt waiting to be accepted,
 *  queued, or retried. `clientPromptId` is generated before dispatch and is the
 *  sole correlation key used to reconcile backend events. */
export interface OutboundPrompt extends Omit<QueueEntryDetails, 'attachments'> {
  queueAttachments?: QueueAttachment[]
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
  /** Who wrote the held prompt, as the host named them; the reader's own stay unlabelled. */
  author?: User
}

export interface RateLimitInfo {
  /** Epoch seconds, or null when no window reset is known. */
  resetsAt: number | null
  rateLimitType: string
  prompt: string
  queuedPrompt: string
  /** Whose seat reached the limit: the author of the turn it stopped. The client
   *  copies it from the `rate_limit` event; live only. */
  turnAuthor?: User
}

/** The canonical window durations. A provider names its windows however it
 *  likes; the duration is the only identity that survives the difference, and
 *  it is what `readUsageLimits` already matches on. */
export const FIVE_HOUR_WINDOW_MINS = 300
export const WEEKLY_WINDOW_MINS = 10_080

/** One window as a provider reported it mid-stream. `usedPercent` is absent
 *  when the report only carries a reset. */
export interface UsageWindowUpdate {
  windowDurationMins: number
  usedPercent: number | null
  /** Epoch ms. */
  resetsAt: number | null
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

/** What a person chose on a permission, as the host read it from the option (plan 004 F4). */
export type PermissionDecision = 'approved' | 'approved_for_session' | 'denied'

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
  /** The agent session on another host that started this one (docs/plans/cross-host-sessions.md). */
  startedBy?: SessionOrigin
}

export interface SessionDelegation {
  parentSessionId: string
  rootSessionId: string
  messageId: string
  depth: number
  intent: 'delegate' | 'fire_and_forget'
  createdAt: number
}

// ─── Session records (collaboration plane) ───

/** What a session is doing, as the collaboration plane knows it: a runner
 *  reports `running` while a turn is open and `idle` once it settles; a record
 *  still `running` when its runner restarts is `interrupted`. */
export type SessionRecordStatus = 'idle' | 'running' | 'interrupted'

/**
 * The collaboration plane's record of a session
 * (docs/plans/cloud-service-model.md): the facts every client lists and
 * filters by, kept where people read together. The transcript stays on the
 * runner that holds it. `projectPath` is the provider's project folder key,
 * the same spelling the transcript index uses, so the picker's filters are
 * unchanged.
 */
/**
 * Whether a record's content is Local or available from the Solus API
 * (organization-scope §3). Distinct from its organization: an
 * organization-attributed session can send Insights while its transcript stays
 * on the laptop.
 */
export type RecordPublication = 'local' | 'published'

export interface SessionRecord {
  sessionId: string
  /** The canonical organization (§3, R10): `local` while unassigned, else an organization id that never changes. */
  organizationId: string
  publication: RecordPublication
  /** The account that started the session, when one is known; null on a host's own sessions. */
  ownerUserId: string | null
  provider: AgentId
  projectPath: string
  /** The project's remote URL, when the runner knows one; how two runners name the same repository. */
  projectRemote: string | null
  /** The runner holding the transcript; null for the host answering the read. */
  runnerHostId: string | null
  /** The derived name: the first prompt, or the provider's slug. */
  title: string | null
  customTitle: string | null
  status: SessionRecordStatus
  model: string | null
  reasoningEffort: ReasoningEffort | null
  parentSessionId: string | null
  rootSessionId: string | null
  createdAt: number
  lastActivityAt: number
  /** Transcript bytes, as the runner last reported. */
  size: number
  /** The working directory on the runner, which a resume needs. Null until the runner reports it. */
  cwd: string | null
  /** The provider's own name for the session, when it gave one. */
  slug: string | null
  /** The session ran in a Solus worktree of its project. */
  isWorktree: boolean
  branch: string | null
  /** Git root that groups a repository with its worktrees, on the runner. */
  projectRoot: string | null
  /** How the parent session started this one; null for a session nobody delegated. */
  delegation: SessionRecordDelegation | null
}

/** `SessionDelegation` less the two ids the record already carries. */
export type SessionRecordDelegation = Omit<SessionDelegation, 'parentSessionId' | 'rootSessionId'>

/** `sessionRecordUpsert`: a field left out keeps the stored value; `lastActivityAt`
 *  is always the caller's. The organization is the caller's, never an argument. */
export interface SessionRecordUpsert extends Partial<Omit<SessionRecord, 'sessionId' | 'provider' | 'projectPath' | 'lastActivityAt' | 'organizationId' | 'publication'>> {
  sessionId: string
  provider: AgentId
  projectPath: string
  lastActivityAt: number
  /**
   * A runner's report only: the Solus session id the Solus API admitted this
   * organization session under before its provider started (organization-vms §3).
   * The service takes the record's owner from that admission, never from the report.
   */
  admissionId?: string
  /**
   * A runner's report only: the session is a chat, which stays private to its owner
   * until they share it (plan 004 D14). Read once, when the service first sees the record.
   */
  privateToOwner?: boolean
}

/** `sessionRecordList`: the picker's filters. `projectPath` is a plain path; the
 *  host encodes it as the provider does, and `includeWorktrees` adds the
 *  project's worktree folders beneath it. */
export interface SessionRecordListFilter {
  provider?: AgentId
  projectPath?: string
  includeWorktrees?: boolean
  /** Only chats, the sessions with no project, in every chat folder. */
  chats?: boolean
  limit?: number
}

/** One home's records. `indexing` is true while a machine's first index sweep
 *  runs: the list is not complete yet, so a client must not show it as final. */
export interface SessionRecordList {
  records: SessionRecord[]
  indexing: boolean
}

/** `sessionRecordSearch`: the sessions of one home that match a query
 *  (docs/plans/unified-search.md). Every word matches as a prefix. */
export interface SessionRecordSearchQuery {
  query: string
  /** One project root and its worktrees; omit to search every project. */
  projectRoot?: string
  provider?: AgentId
  /** Match names and metadata only; read no message. */
  namesOnly?: boolean
  /** Only sessions last active at or after this instant (ms). */
  activeSince?: number
  /** One page: at most `limit` sessions after `offset`. */
  limit?: number
  offset?: number
}

export interface SessionRecordSearchResult extends SessionSearchHit {
  record: SessionRecord
  additionalMatches: SessionSearchHit[]
}

export interface SessionRecordSearch {
  results: SessionRecordSearchResult[]
  /** How many sessions match in all; `results` is one page of them. */
  total: number
  indexing: boolean
}

export interface SessionSearchResult extends SessionSearchHit {
  session: SessionMeta
  /** Up to two other matching messages, in relevance order. */
  additionalMatches?: SessionSearchHit[]
}

export interface SessionSearchHit {
  /** The passage the words were found in, with each matched token wrapped in
   *  the markers of `search-snippet.ts`. Read it through `snippetRuns` or
   *  `plainSnippet`; never show it raw. */
  snippet: string
  ts: number
  /** The indexed message the words were found in, so a preview can open on
   *  that passage rather than on the transcript's ends. -1, with an empty
   *  snippet, when the session matched by its name alone. */
  messageId: number
  /** The session's standing in the answer. Lower is a better match, and a
   *  rank is comparable only with others from the same index. */
  rank: number
}

export interface RecentProject {
  path: string          // decoded real path, e.g. "/Users/example/projects/solus"
  folderName: string    // last segment, e.g. "solus"
  lastOpened: string    // ISO timestamp of last open
}

/** A project on this host's project list (docs/plans/project-model.md §2): a
 *  folder someone added explicitly. The host list is the only record of which
 *  folders are projects; clients keep a copy only for hosts that are away. */
export interface ProjectEntry {
  key: string           // hash of the repo root / cwd; names the ~/.solus/projects/<key> dir
  path: string          // the project root: the repository's top folder, or the folder itself
  folderName: string    // last path segment
  addedAt: string       // ISO timestamp first recorded
  /** ISO timestamp of the last time it was added again or a session started
   *  in it; `addedAt` until then. Project lists order by it. */
  lastUsedAt: string
  /** The project this checkout belongs to (docs/plans/project-model.md §1):
   *  the repository key of its primary remote, or null for a folder with no
   *  hosted remote. */
  repositoryKey: string | null
}

/** A known checkout keyed by its normalized origin identity across hosts. */
export interface ProjectIdentity {
  path: string
  folderName: string
  /** The clone source: the checkout's `origin` remote, reduced to lowercase
   *  `host/path` by `repositoryKeyFromRemoteUrl`. For a fork this differs from
   *  `ProjectEntry.repositoryKey`, which names the upstream. */
  repoKey: string
}

/** A host-internal dispatch checkout that can contain session history. */
export interface DispatchHistoryRoot {
  path: string
  /** Lowercase `host/path` of the dispatch checkout's clone source, matching ProjectIdentity.repoKey. */
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
  /** Overrides the host's worktree branch naming for this project. Absent =
   *  the host setting. */
  worktreeBranchNaming?: WorktreeBranchNaming
  /** How to build the app for Build & run on a device (plan 016, S02). */
  deviceRuns?: DeviceRunProfile[]
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

/** The OS-level "summon Solus" shortcut (desktop-only). */
export interface AppGlobalShortcuts {
  toggle: AppShortcutCombo
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

/**
 * One edit to a path anywhere on the host, from the directory picker. Unlike
 * `ProjectFileMutation` it is not confined to a project root. `trash` is
 * recoverable; `delete` is permanent and follows only an explicit
 * confirmation after `trash` answered `trashUnavailable`.
 */
export type HostPathMutation =
  | { op: 'rename'; path: string; toPath: string }
  | { op: 'trash'; path: string }
  | { op: 'delete'; path: string }

export type HostPathMutationResult =
  | { ok: true; /** Host-resolved absolute path the entry now has; empty once it is gone. */ path: string }
  | { ok: false; error: string; /** The host has no Trash for this path. */ trashUnavailable?: boolean }

/**
 * One file, as the file pane shows it. Text arrives with its contents. A media
 * file arrives without its bytes: the client loads it from a signed asset URL,
 * so a large video or PDF never crosses the RPC channel. Any other binary file
 * arrives as its size alone.
 */
export type FilePreviewResult =
  | {
      ok: true
      kind: 'text'
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
      ok: true
      kind: 'media'
      path: string
      displayPath: string
      size: number
      media: MediaType
    }
  | {
      ok: true
      kind: 'binary'
      path: string
      displayPath: string
      size: number
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
 * (`<projects root>/solus-remote/<owner key>/<host>/<owner>/<repo>`). The owner
 * key is the paired device, or the member on a Solus-provisioned machine
 * (`dispatchCheckoutOwnerKey`). These clones are created to
 * run a session on another machine; they are host-internal plumbing, never a
 * project the user opened, so they must stay out of recents.
 */
export const SOLUS_REMOTE_DISPATCH_DIR = 'solus-remote'
export const SOLUS_REMOTE_DISPATCH_PATH_MARKER = `/${SOLUS_REMOTE_DISPATCH_DIR}/`

/** True if `path` lives inside a delegated remote-dispatch checkout. */
export function isRemoteDispatchCheckoutPath(path: string): boolean {
  return path.includes(SOLUS_REMOTE_DISPATCH_PATH_MARKER)
}

/**
 * The repository a remote-dispatch checkout holds, read from its path:
 * `<projects root>/solus-remote/<owner>/<host>/<owner>/<repo>`, the layout
 * `dispatchCheckoutPath` writes. A dispatch clone has only its clone source
 * as a remote, so this is the key its host would read from git. Hosts leave
 * dispatch checkouts out of their project list, so no host names this key.
 * Null for any other path.
 */
export function remoteDispatchRepositoryKey(path: string): string | null {
  const root = worktreeProjectRoot(path)
  const markerIndex = root.indexOf(SOLUS_REMOTE_DISPATCH_PATH_MARKER)
  if (markerIndex === -1) return null
  const segments = root.slice(markerIndex + SOLUS_REMOTE_DISPATCH_PATH_MARKER.length).split('/').filter(Boolean).slice(1)
  return segments.length >= 3 ? segments.join('/').toLowerCase() : null
}

/** The base project root for a worktree path, or `path` unchanged when it isn't a worktree. */
export function worktreeProjectRoot(path: string): string {
  const idx = path.indexOf(SOLUS_WORKTREE_PATH_MARKER)
  return idx === -1 ? path : path.slice(0, idx)
}

/** `SOLUS_WORKTREE_PATH_MARKER` as it appears inside an encoded Claude folder name. */
export const SOLUS_WORKTREE_ENCODED_MARKER = encodePathAsFolder(SOLUS_WORKTREE_PATH_MARKER)

interface GitCheckoutIdentity {
  /** The branch or worktree branch the session is running in */
  branch: string | null
  /** Present when the checkout is detached instead of being on a named branch. */
  detachedHeadSha?: string
  /** Remote default branch — always present so DiffPanel always has a diff target */
  targetBranch: string
}

/** A worktree must name both its checkout and its owning project. */
export type GitCheckout = GitCheckoutIdentity & (
  | { worktreePath: string; repoRoot: string }
  | { worktreePath?: undefined; repoRoot?: string }
)

export function gitCheckoutFromState(
  status: GitIdentity | null | undefined,
  worktreePath?: string,
  projectRoot?: string,
): GitCheckout | null {
  if (!status) return null
  const checkoutIdentity: GitCheckoutIdentity = {
    branch: status.branch,
    targetBranch: status.targetBranch,
  }
  if (status.branch === null) checkoutIdentity.detachedHeadSha = status.headSha
  return worktreePath
    ? {
        ...checkoutIdentity,
        repoRoot: projectRoot ?? worktreeProjectRoot(worktreePath),
        worktreePath,
      }
    : { ...checkoutIdentity, repoRoot: status.repoRoot }
}

/** Whether two checkouts name the same place: branch or detached head, diff
 *  target, worktree, and repository. Working-tree dirt is not part of identity. */
export function sameGitCheckout(
  a: GitCheckout | null | undefined,
  b: GitCheckout | null | undefined,
): boolean {
  if (!a || !b) return !a && !b
  return a.branch === b.branch
    && a.detachedHeadSha === b.detachedHeadSha
    && a.targetBranch === b.targetBranch
    && a.worktreePath === b.worktreePath
    && a.repoRoot === b.repoRoot
}

export interface GitCheckoutBranchResult {
  success: boolean
  gitContext?: GitCheckout
  error?: string
}

// ─── Automations ───
//
// An Automation is a saved unit of work that submits a prompt to an agent using
// a frozen model / reasoning / permission configuration. Phase 2 adds local,
// time-based triggers (manual / one-time / interval / cron) on top of the Phase 1
// run-now substrate. Scheduling is local-only — triggers fire while Solus is open
// and catch up missed fires on the next launch.

/** Run outcomes. */
export type AutomationRunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled'

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
  cwd: string
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

export interface Automation {
  /** Archived records are disabled and retained until the host retention period expires. */
  archivedAt?: string
  /** Stop was requested while a check was still running. */
  archiveRequested?: boolean
  id: string
  name: string
  enabled: boolean
  /** The canonical organization (organization-scope §3); `local` while unassigned. Absent on records from a host that predates it. */
  organizationId?: string
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
  /** Who made it, recorded by the host from the admitted request: a person, or
   *  an agent's session and the person it worked for. The person's removal from
   *  the organization pauses it (plans/010-standard-oauth.md). */
  createdBy: Attribution
  /**
   * The creator's personal preferences this automation runs with (plans/018 §6):
   * captured when it was created or last edited, or once from the host's old
   * config (`source: 'legacy'`) the first time it ran after the upgrade. A later
   * edit to the person's settings does not rewrite it.
   */
  executionPreferences?: ExecutionPreferenceSnapshot
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
  /** The session the run started, for opening it later. */
  sessionId?: string | null
  /** Branch the run's isolated worktree was created on (useWorktree runs only),
   *  so the user can find the work the run produced. */
  branch?: string
  /** Exact directory the isolated run executed in. Required to find provider
   *  transcripts whose on-disk project key includes the worktree path. */
  worktreePath?: string
  /** Populated when status is 'failed'. */
  error?: string
}

/** What a run-history graph needs about one run, without its output: the list
 *  draws one for every automation, so it must not carry each run's final text. */
export type AutomationRunPoint = Pick<AutomationRun, 'id' | 'automationId' | 'startedAt' | 'finishedAt' | 'status'>

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
