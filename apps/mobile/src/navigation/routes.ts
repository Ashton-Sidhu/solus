import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import type { AgentId } from '@solus/contracts/types'
import type { LastRoute } from '../app/solus-app'

/** The conversation a workspace shows: a saved session, or one being started. */
export type SelectedConversation =
  | { record: NonNullable<LastRoute['record']> }
  | { newSession: { sessionId: string; provider: AgentId; workingDirectory: string } }

export type RootStackParamList = {
  Welcome: undefined
  PairHost: undefined
  CloudSignIn: undefined
  CloudHosts: undefined
  Hosts: undefined
  Projects: { hostId: string }
  /** The ways to get a project onto a host: new, existing folder, GitHub, or a URL. */
  OpenProject: { hostId: string }
  NewProject: { hostId: string }
  /** Folders in the host's projects folder, or in `path` when given. */
  OpenFolder: { hostId: string; path?: string }
  ProjectFromGithub: { hostId: string }
  CloneProject: { hostId: string }
  /** A project's sessions; a `projectPath` of `NEW_CHAT_DIRECTORY` lists the host's chats. */
  Workspace: { hostId: string; projectPath: string; selected?: SelectedConversation }
  Conversation: { hostId: string; projectPath: string; selected: SelectedConversation }
  Notifications: undefined
  Builds: { hostId: string }
  Settings: undefined
  /** The person's own settings and their sync (plans/018); no host needed. */
  PersonalSettings: undefined
  AppearanceSettings: undefined
  AgentDefaults: undefined
  NotificationSettings: undefined
  /** One organization's settings; `organizationId` preselects it. */
  OrganizationSettings: { organizationId?: string } | undefined
  HostSettings: { hostId: string }
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

export function selectedKey(selected: SelectedConversation): string {
  return 'record' in selected ? selected.record.sessionId : selected.newSession.sessionId
}
