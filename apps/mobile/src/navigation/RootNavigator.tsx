import { NavigationContainer, DarkTheme, DefaultTheme, createNavigationContainerRef, type InitialState } from '@react-navigation/native'
import { createNativeStackNavigator } from '@react-navigation/native-stack'
import { usePalette, useIsDark } from '../theme/theme'
import { CloudHostsScreen } from '../features/account/CloudHostsScreen'
import { CloudSignInScreen } from '../features/account/CloudSignInScreen'
import { ConversationScreen } from '../features/conversation/ConversationScreen'
import { HostsScreen } from '../features/hosts/HostsScreen'
import { PairHostScreen } from '../features/hosts/PairHostScreen'
import { WelcomeScreen } from '../features/onboarding/WelcomeScreen'
import { ProjectsScreen } from '../features/sessions/ProjectsScreen'
import { WorkspaceScreen } from '../features/sessions/WorkspaceScreen'
import { OpenProjectScreen } from '../features/projects/OpenProjectScreen'
import { NewProjectScreen } from '../features/projects/NewProjectScreen'
import { OpenFolderScreen } from '../features/projects/OpenFolderScreen'
import { ProjectFromGithubScreen } from '../features/projects/ProjectFromGithubScreen'
import { CloneProjectScreen } from '../features/projects/CloneProjectScreen'
import { NotificationsScreen } from '../features/notifications/NotificationsScreen'
import { BuildsScreen } from '../features/devices/BuildsScreen'
import { SettingsScreen } from '../features/settings/SettingsScreen'
import { AppearanceScreen } from '../features/settings/AppearanceScreen'
import { PersonalSettingsScreen } from '../features/settings/PersonalSettingsScreen'
import { OrganizationSettingsScreen } from '../features/settings/OrganizationSettingsScreen'
import { HostSettingsScreen } from '../features/settings/HostSettingsScreen'
import { AgentDefaultsScreen } from '../features/settings/AgentDefaultsScreen'
import { NotificationSettingsScreen } from '../features/settings/NotificationSettingsScreen'
import { GitHubConnectionScreen } from '../features/settings/GitHubConnectionScreen'
import { AboutScreen } from '../features/settings/AboutScreen'
import { PullRequestsScreen } from '../features/prs/PullRequestsScreen'
import { PullRequestScreen } from '../features/prs/PullRequestScreen'
import { FilesScreen } from '../features/files/FilesScreen'
import { FileScreen } from '../features/files/FileScreen'
import { useKeyboardCommand } from '../features/keyboard/use-keyboard-command'
import type { RootStackParamList } from './routes'

const Stack = createNativeStackNavigator<RootStackParamList>()
const navigation = createNavigationContainerRef<RootStackParamList>()

export function RootNavigator({ initialState }: { initialState: InitialState }) {
  const palette = usePalette()
  const isDark = useIsDark()
  useKeyboardCommand('back', () => {
    if (!navigation.isReady() || !navigation.canGoBack()) return false
    navigation.goBack()
  })
  const base = isDark ? DarkTheme : DefaultTheme
  const theme = {
    ...base,
    colors: { ...base.colors, primary: palette.accent, background: palette.canvas, card: palette.surface, text: palette.text, border: palette.border },
  }
  return (
    <NavigationContainer ref={navigation} theme={theme} initialState={initialState}>
      <Stack.Navigator screenOptions={{ headerTintColor: palette.accent, headerTitleStyle: { color: palette.text }, contentStyle: { backgroundColor: palette.canvas } }}>
        <Stack.Screen name="Welcome" component={WelcomeScreen} options={{ headerShown: false }} />
        <Stack.Screen name="PairHost" component={PairHostScreen} options={{ title: 'Connect to a host' }} />
        <Stack.Screen name="CloudSignIn" component={CloudSignInScreen} options={{ title: 'Solus Cloud' }} />
        <Stack.Screen name="CloudHosts" component={CloudHostsScreen} options={{ title: 'Your hosts' }} />
        <Stack.Screen name="Hosts" component={HostsScreen} options={{ title: 'Hosts', headerLargeTitle: true }} />
        <Stack.Screen name="Projects" component={ProjectsScreen} options={{ title: 'Projects' }} />
        <Stack.Screen name="OpenProject" component={OpenProjectScreen} options={{ title: 'Open project' }} />
        <Stack.Screen name="NewProject" component={NewProjectScreen} options={{ title: 'Start a new project' }} />
        <Stack.Screen name="OpenFolder" component={OpenFolderScreen} options={{ title: 'Open an existing folder' }} />
        <Stack.Screen name="ProjectFromGithub" component={ProjectFromGithubScreen} options={{ title: 'Get a project from GitHub' }} />
        <Stack.Screen name="CloneProject" component={CloneProjectScreen} options={{ title: 'Clone from a URL' }} />
        <Stack.Screen name="Workspace" component={WorkspaceScreen} options={{ title: 'Sessions' }} />
        <Stack.Screen name="Conversation" component={ConversationScreen} options={{ title: 'Session' }} />
        <Stack.Screen name="Builds" component={BuildsScreen} options={{ title: 'App builds' }} />
        <Stack.Screen name="Notifications" component={NotificationsScreen} options={{ title: 'Notifications', headerLargeTitle: true }} />
        <Stack.Screen name="Settings" component={SettingsScreen} options={{ title: 'Settings' }} />
        <Stack.Screen name="PersonalSettings" component={PersonalSettingsScreen} options={{ title: 'Personal' }} />
        <Stack.Screen name="AppearanceSettings" component={AppearanceScreen} options={{ title: 'Appearance' }} />
        <Stack.Screen name="OrganizationSettings" component={OrganizationSettingsScreen} options={{ title: 'Organization' }} />
        <Stack.Screen name="HostSettings" component={HostSettingsScreen} options={{ title: 'Host settings' }} />
        <Stack.Screen name="AgentDefaults" component={AgentDefaultsScreen} options={{ title: 'Agent defaults' }} />
        <Stack.Screen name="NotificationSettings" component={NotificationSettingsScreen} options={{ title: 'Notifications' }} />
        <Stack.Screen name="GitHubConnection" component={GitHubConnectionScreen} options={{ title: 'GitHub' }} />
        <Stack.Screen name="About" component={AboutScreen} options={{ title: 'About Solus' }} />
        <Stack.Screen name="PullRequests" component={PullRequestsScreen} options={{ title: 'Pull requests' }} />
        <Stack.Screen name="PullRequest" component={PullRequestScreen} options={{ title: 'Pull request' }} />
        <Stack.Screen name="Files" component={FilesScreen} options={{ title: 'Files' }} />
        <Stack.Screen name="File" component={FileScreen} options={{ title: 'File' }} />
      </Stack.Navigator>
    </NavigationContainer>
  )
}
