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
  /** T3 Code's new-task sheet; the pickers preselect a host and project. */
  NewTask: { hostId?: string; projectPath?: string } | undefined
  Welcome: undefined
  /** `link` is a pairing link, or a nearby host's address, to check before pairing. */
  PairHost: { link?: string } | undefined
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
  RunApp: { hostId: string; projectPath?: string; sessionId?: string; conversationCheckoutPath?: string }
  BuildProfiles: { hostId: string; projectPath: string }
  BuildLog: { hostId: string; runId: string }
  Settings: undefined
  /** The person's own settings and their sync (plans/018); no host needed. */
  AccountSync: undefined
  /** The person's instructions, skills, and MCP servers, their sync, and their copy on each host (plans/020). */
  AgentProfile: undefined
  AppearanceSettings: undefined
  AgentDefaults: undefined
  NotificationSettings: undefined
  /** One organization's settings; `organizationId` preselects it. */
  OrganizationSettings: { organizationId?: string } | undefined
  HostSettings: { hostId: string }
  /** How one host is reached: Solus Cloud link, organizations, network, pairing, and devices. */
  HostAccess: { hostId: string }
  GitHubConnection: { hostId: string }
  /** The remote MCP servers one host knows, their tools, and the way to add one. */
  Integrations: { hostId: string }
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
  /** A project folder; `folderPath` is root-relative, `''` for the root. */
  Files: { hostId: string; projectPath: string; folderPath: string }
  /** One file; `path` is root-relative. */
  File: { hostId: string; projectPath: string; path: string }
}

export type ScreenProps<Name extends keyof RootStackParamList> = NativeStackScreenProps<RootStackParamList, Name>
