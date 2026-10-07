import type { NativeStackScreenProps } from '@react-navigation/native-stack'

export type RootStackParamList = {
  /** T3 Code's home: every session on every host, newest first. */
  Home: undefined
  /** One session, as T3 Code's thread screen. */
  Thread: { hostId: string; sessionId: string }
  /** The newest turn's agents, as a sheet over its thread. `conversationId` names the open conversation. */
  ThreadAgents: { hostId: string; conversationId: string }
  /** T3 Code's new-task sheet; the pickers preselect a host and project. */
  NewTask: { hostId?: string; projectPath?: string } | undefined
  Welcome: undefined
  PairHost: undefined
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
  Builds: { hostId: string }
  BuildFolder: { hostId: string; path?: string }
  NewBuild: { hostId: string; projectPath?: string }
  BuildProfiles: { hostId: string; projectPath: string }
  Settings: undefined
  /** The person's own settings and their sync (plans/018); no host needed. */
  PersonalSettings: undefined
  AppearanceSettings: undefined
  AgentDefaults: undefined
  NotificationSettings: undefined
  /** One organization's settings; `organizationId` preselects it. */
  OrganizationSettings: { organizationId?: string } | undefined
  HostSettings: { hostId: string }
  /** How one host is reached: Solus Cloud link, organizations, network, pairing, and devices. */
  HostAccess: { hostId: string }
  GitHubConnection: { hostId: string }
  About: undefined
  PullRequests: { hostId: string }
  PullRequest: { hostId: string; projectPath: string; number: number }
  /** A project folder; `folderPath` is root-relative, `''` for the root. */
  Files: { hostId: string; projectPath: string; folderPath: string }
  /** One file; `path` is root-relative. */
  File: { hostId: string; projectPath: string; path: string }
}

export type ScreenProps<Name extends keyof RootStackParamList> = NativeStackScreenProps<RootStackParamList, Name>
