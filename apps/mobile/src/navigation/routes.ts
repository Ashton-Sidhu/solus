import type { NativeStackScreenProps } from '@react-navigation/native-stack'

export type RootStackParamList = {
  /** The workspace root with the Chats and Pull Requests tabs. `tab` selects
   *  a tab, and `hostId` narrows the Pull Requests tab to one host; Home
   *  reads them once and clears them. */
  Home: { tab?: 'chats' | 'pullRequests'; hostId?: string } | undefined
  /** One session, as T3 Code's thread screen. */
  Thread: { hostId: string; sessionId: string }
  /** The newest turn's agents, as a sheet over its thread. `conversationId` names the open conversation. */
  ThreadAgents: { hostId: string; conversationId: string }
  ThreadSubagent: { hostId: string; conversationId: string; itemId: string }
  /** The prompts queued behind the running turn, as a sheet over its thread. `conversationId` names the open conversation. */
  ThreadQueue: { hostId: string; conversationId: string }
  /** The model, reasoning, and permission mode for the next prompt, as T3 Code's form-sheet route over its thread or new-task draft. `conversationId` names the open conversation. */
  ThreadSettings: { hostId: string; conversationId: string }
  /** T3 Code's new-task sheet; the pickers preselect a host and project. */
  /**
   * `hostChoice` absent: Auto balance may still choose the host. `balanceRequest`
   * is the picker's Auto balance row: check now (docs/plans/resource-telemetry.md D8).
   */
  NewTask: { hostId?: string; projectPath?: string; hostChoice?: import("../features/threads/new-task-balance").NewTaskHostChoice; balanceRequest?: number } | undefined
  /** The host a new-task draft runs on, pushed in the new-task sheet. `hostId` and `projectPath` name the draft. */
  NewTaskEnvironment: { hostId: string; projectPath: string; hostChoice?: import("../features/threads/new-task-balance").NewTaskHostChoice }
  Welcome: undefined
  /** `link` is a pairing link, or a nearby host's address, to check before pairing. */
  PairHost: { link?: string } | undefined
  /** Adds a machine over SSH; a connected host runs SSH. `viaHostId` preselects that host; `identityFile` is a key `ChooseSshKey` chose, applied once (docs/plans/host-routes.md D6). */
  AddSshHost: { viaHostId?: string; identityFile?: string } | undefined
  /** Files on the host that runs SSH, from `~/.ssh` or `path`, to choose the identity file of `AddSshHost`. */
  ChooseSshKey: { hostId: string; path?: string }
  /** Adds the WSL distro `distro` of the Windows host `hostId` as a machine, chosen in that host's settings (docs/plans/windows.md §5.13). */
  AddWslHost: { hostId: string; distro: string }
  CloudSignIn: undefined
  CloudHosts: undefined
  Hosts: undefined
  /** The ways to get a project onto a host: new, existing folder, GitHub, or a URL. */
  OpenProject: { hostId: string }
  NewProject: { hostId: string }
  /** Folders in the host's projects folder, or in `path` when given. */
  OpenFolder: { hostId: string; path?: string }
  ProjectFromGithub: { hostId: string }
  CloneProject: { hostId: string }
  Notifications: undefined
  /** Android's third workspace destination beside Chats and Pull Requests; iOS opens it from the header. */
  Settings: undefined
  /** The person's own settings and their sync (plans/018); no host needed. */
  AccountSync: undefined
  /** The person's instructions, skills, and MCP servers, their sync, and their copy on each host (plans/020). */
  AgentProfile: undefined
  AppearanceSettings: undefined
  ProviderInstances: { hostId: string; instanceId?: string; projectPath?: string }
  SettingsScope: { hostId: string; projectPath?: string; axis?: "project" | "host" }
  Providers: undefined
  ProviderSettings: { provider: import("@solus/contracts/types").AgentId; hostId?: string; instanceId?: string }
  ChatSettings: undefined
  AgentDefaults: undefined
  VoiceSettings: undefined
  VoiceTerm: { term: string }
  NotificationSettings: undefined
  /** The effective policy of work on a host (plans/030 §7), read-only; the params preselect the host and the organization. */
  Policy: { hostId?: string; organizationId?: string } | undefined
  HostSettings: { hostId: string }
  /** One host's machine load and, for its admins, its process table. */
  HostResources: { hostId: string }
  /** Auto balance: the switch, and a preference for each host. */
  HostBalancing: undefined
  DeviceSettings: { hostId: string }
  Devices: { hostId: string; sessionId?: string }
  /** How one host is reached: Solus Cloud link, organizations, network, pairing, and devices. */
  HostAccess: { hostId: string }
  /** The routes this device has to one host: which is in use, and adding, moving, and removing one. */
  HostRoutes: { hostId: string }
  GitHubConnection: { hostId: string }
  /** The remote MCP servers one host knows, their tools, and the way to add one. */
  Integrations: { hostId: string }
  /** The webhooks of one host and its two webhook settings (docs/plans/webhooks.md §4). */
  Webhooks: { hostId: string }
  /** One webhook: Pause, Copy URL, and its deliveries. */
  Webhook: { hostId: string; webhookId: string }
  /** One delivery of a webhook, with its action results and Replay. */
  WebhookDelivery: { hostId: string; webhookId: string; deliveryId: string }
  /** The apps of one host, or of every host when no host is named (docs/plans/apps.md §9). */
  Apps: { hostId?: string } | undefined
  /** One app, with its UI in all of the screen. `appId` is the app's id or its slug on the host. */
  App: { hostId: string; appId: string }
  /** The app's sheet: versions, schedules, secrets, webhooks, calls, sessions, Stop or Start, and Delete. */
  AppManage: { hostId: string; appId: string }
  About: undefined
  PullRequest: { hostId: string; projectPath: string; number: number }
  /** Submit a review (`review`) or comment on the conversation (`comment`), as a sheet. */
  PullRequestReview: { hostId: string; projectPath: string; number: number; mode: 'review' | 'comment' }
  /** The pull request's diff on the native surface, as T3 Code's files screen. `commitSha` shows one
   *  commit; `path` opens at one file, and `focus` marks the lines a guide stop names. */
  PullRequestFiles: { hostId: string; projectPath: string; number: number; commitSha?: string; path?: string; focus?: { side: 'old' | 'new'; start: number; end: number } }
  /** A question to an agent about the pull request, as a sheet. */
  PullRequestAsk: { hostId: string; projectPath: string; number: number }
  /** A draft review comment on `line` (and from `startLine`) of `path`, written on `headSha`; `draftId` edits one. */
  PullRequestInlineComment: { hostId: string; projectPath: string; number: number; path: string; side: 'LEFT' | 'RIGHT'; line: number; startLine?: number; headSha: string; code: string; draftId?: string }
  /** One review thread of a pull request. */
  PullRequestDiscussion: { hostId: string; projectPath: string; number: number; threadId: string }
  PullRequestReviewers: { hostId: string; projectPath: string; number: number }
  PullRequestLabels: { hostId: string; projectPath: string; number: number }
  /** A change to the title or the description of a pull request, as a sheet. */
  PullRequestEdit: { hostId: string; projectPath: string; number: number; field: 'title' | 'body' }
  /** Searches the hosts for a label or author to filter the Pull Requests tab by. */
  PullRequestFilterSearch: { field: 'label' | 'author' }
  /** A project folder; `folderPath` is root-relative, `''` for the root. */
  Files: { hostId: string; projectPath: string; folderPath: string }
  /** One file; `path` is root-relative. */
  File: { hostId: string; projectPath: string; path: string }
  /** What a session produced or linked: pull requests, works, apps, files, images, and automations. */
  ThreadArtifacts: { hostId: string; sessionId: string }
}

export type ScreenProps<Name extends keyof RootStackParamList> = NativeStackScreenProps<RootStackParamList, Name>
