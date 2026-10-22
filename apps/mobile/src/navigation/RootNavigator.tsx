import {
  NavigationContainer,
  createNavigationContainerRef,
  type InitialState,
  type NavigationState,
} from '@react-navigation/native'
import type { NativeStackNavigationOptions } from '@react-navigation/native-stack'
import { useEffect } from 'react'
import { Linking, Platform, useWindowDimensions } from 'react-native'
import { parseDeepLink } from './deep-links'
import { useUniwindTheme } from '../lib/useUniwindTheme'
import { getCompactBrandHeaderOptions } from '../components/CompactBrandTitle'
import { deriveLayout } from '../lib/layout'
import { useMobileNavigationTheme } from '../lib/useMobileNavigationTheme'
import { NATIVE_LIQUID_GLASS_SUPPORTED } from '../native/native-glass'
import { nativeHeaderScrollEdgeEffects } from '../native/StackHeader'
import { FORM_SHEET_PRESENTATION_OPTIONS } from '../native/sheet-surface'
import { CloudHostsScreen } from '../features/account/CloudHostsScreen'
import { CloudSignInScreen } from '../features/account/CloudSignInScreen'
import { HomeRouteScreen } from '../features/home/HomeRouteScreen'
import { ThreadRouteScreen } from '../features/threads/ThreadRouteScreen'
import { ThreadAgentsSheet } from '../features/threads/ThreadAgents'
import { ProviderSubagentScreen } from '../features/threads/ProviderSubagentScreen'
import { ThreadQueueSheet } from '../features/threads/ThreadQueueSheet'
import { ThreadSettingsRouteScreen } from '../features/threads/ThreadSettingsSheet'
import { NewTaskRouteScreen } from '../features/threads/NewTaskRouteScreen'
import { NewTaskEnvironmentPickerRouteScreen } from '../features/threads/NewTaskContextPickerScreens'
import { HostsScreen } from '../features/hosts/HostsScreen'
import { PairHostScreen } from '../features/hosts/PairHostScreen'
import { AdaptiveWorkspaceLayout, type WorkspaceLocation } from '../features/layout/AdaptiveWorkspaceLayout'
import { createWorkspaceStackNavigator } from '../features/layout/createWorkspaceStackNavigator'
import { WorkspaceTabsProvider } from '../features/workspace/WorkspaceTabsContext'
import { WorkspaceSettingsFrame } from '../features/workspace/WorkspaceSettingsFrame'
import { settingsPagesOnTop } from '../features/workspace/workspace-destinations'
import { WelcomeScreen } from '../features/onboarding/WelcomeScreen'
import { OpenProjectScreen } from '../features/projects/OpenProjectScreen'
import { NewProjectScreen } from '../features/projects/NewProjectScreen'
import { OpenFolderScreen } from '../features/projects/OpenFolderScreen'
import { ProjectFromGithubScreen } from '../features/projects/ProjectFromGithubScreen'
import { CloneProjectScreen } from '../features/projects/CloneProjectScreen'
import { NotificationsScreen } from '../features/notifications/NotificationsScreen'
import { SettingsScreen } from '../features/settings/SettingsScreen'
import { AppearanceScreen } from '../features/settings/AppearanceScreen'
import { AccountSyncScreen } from '../features/settings/AccountSyncScreen'
import { AgentProfileScreen } from '../features/settings/AgentProfileScreen'
import { OrganizationSettingsScreen } from '../features/settings/OrganizationSettingsScreen'
import { HostSettingsScreen } from '../features/settings/HostSettingsScreen'
import { HostAccessScreen } from '../features/settings/HostAccessScreen'
import { IntegrationsScreen } from '../features/settings/IntegrationsScreen'
import { AgentDefaultsScreen } from '../features/settings/AgentDefaultsScreen'
import { NotificationSettingsScreen } from '../features/settings/NotificationSettingsScreen'
import { GitHubConnectionScreen } from '../features/settings/GitHubConnectionScreen'
import { AboutScreen } from '../features/settings/AboutScreen'
import { PullRequestScreen } from '../features/prs/PullRequestScreen'
import { PullRequestReviewSheet } from '../features/prs/PullRequestReviewSheet'
import { PullRequestInlineCommentScreen } from '../features/prs/PullRequestInlineCommentScreen'
import { PullRequestDiscussionScreen } from '../features/prs/PullRequestDiscussionScreen'
import { PullRequestFilesScreen } from '../features/prs/PullRequestFilesScreen'
import { PullRequestAskScreen } from '../features/prs/PullRequestAskScreen'
import { PullRequestReviewersScreen } from '../features/prs/PullRequestReviewersScreen'
import { PullRequestLabelsScreen } from '../features/prs/PullRequestLabelsScreen'
import { FilesScreen } from '../features/files/FilesScreen'
import { FileScreen } from '../features/files/FileScreen'
import { useKeyboardCommand } from '../features/keyboard/use-keyboard-command'
import type { RootStackParamList } from './routes'

// Header presets and the workspace navigator adapted from T3 Code apps/mobile/src/Stack.tsx (MIT, see UPSTREAM.md).
const HEADER_SCROLL_EDGE_EFFECTS = nativeHeaderScrollEdgeEffects(Platform.OS, Platform.Version)

type AppScreenOptions = NativeStackNavigationOptions & {
  /** The fork's UINavigationItem style (apps/mobile/deps/README.md). */
  readonly unstable_navigationItemStyle?: 'editor'
}

// Shared header presets. Screens only override genuinely dynamic values (titles,
// subtitles, toolbar items, search callbacks) via NativeStackScreenOptions.
//
// GLASS: transparent header over the screen's primary scroll view on supported
// iOS versions. Pre-glass iOS gets the same solid material as internal-scroll
// surfaces so content is laid out below the bar instead of underlapping it.
export const GLASS_HEADER_OPTIONS: AppScreenOptions = {
  headerBackButtonDisplayMode: 'minimal',
  headerBackTitle: '',
  headerLargeTitle: false,
  headerShadowVisible: false,
  headerShown: true,
  headerStyle: NATIVE_LIQUID_GLASS_SUPPORTED ? { backgroundColor: 'transparent' } : undefined,
  headerTitleStyle: { fontSize: 18, fontWeight: '800' },
  headerTransparent: NATIVE_LIQUID_GLASS_SUPPORTED,
  scrollEdgeEffects: NATIVE_LIQUID_GLASS_SUPPORTED ? HEADER_SCROLL_EDGE_EFFECTS : undefined,
  unstable_navigationItemStyle: NATIVE_LIQUID_GLASS_SUPPORTED ? 'editor' : undefined,
}

// SOLID: opaque sheet-colored header for surfaces whose content scrolls internally
// (file viewer, terminal, review) — there is nothing for glass to sample there.
export const SOLID_HEADER_OPTIONS: AppScreenOptions = {
  headerBackButtonDisplayMode: 'minimal',
  headerBackTitle: '',
  headerLargeTitle: false,
  headerShadowVisible: false,
  headerShown: true,
  headerTitleStyle: { fontSize: 18, fontWeight: '800' },
  headerTransparent: false,
  unstable_navigationItemStyle: Platform.OS === 'ios' ? 'editor' : undefined,
}

// Solid header variant for screens inside sheets (centered title, no editor style).
export const SHEET_SOLID_HEADER_OPTIONS: AppScreenOptions = {
  ...SOLID_HEADER_OPTIONS,
  unstable_navigationItemStyle: undefined,
}

// A native glass header for a sheet screen whose primary child is a scroll
// view. The centered sheet title stays stable while UIKit supplies scroll-edge
// fading from that child.
export const SHEET_GLASS_HEADER_OPTIONS: AppScreenOptions = {
  ...GLASS_HEADER_OPTIONS,
  unstable_navigationItemStyle: undefined,
}

/** A pull request form sheet: the native glass header on iOS, the sheet's own header on Android. */
const PULL_REQUEST_SHEET_HEADER_OPTIONS: AppScreenOptions =
  Platform.OS === 'ios' ? SHEET_GLASS_HEADER_OPTIONS : { headerShown: false }

/** Settings and the new-task flow, which T3 presents as sheets. */
const SHEET_ROUTES = new Set<keyof RootStackParamList>(['Settings', 'NewTask'])

/** Pairing and the Solus Cloud sign-in: a centered form sheet on a wide iPad, not a full-width page. */
const CONNECT_SHEET_ROUTES = new Set<keyof RootStackParamList>(['PairHost', 'CloudSignIn', 'CloudHosts'])

// Routes presented as sheets/overlays ON TOP of the workspace. They must not
// influence the adaptive workspace layout: opening Settings over Home should
// not flip the sidebar in or change the active thread. Settings pages pushed
// from the Settings sheet stay in it.
const WORKSPACE_OVERLAY_ROUTES = new Set<keyof RootStackParamList>([
  'NewTask',
  'PairHost',
  'CloudSignIn',
  'CloudHosts',
  'NewTaskEnvironment',
  'ThreadAgents',
  'ThreadQueue',
  'ThreadSettings',
  'Settings',
  'AccountSync',
  'AgentProfile',
  'AppearanceSettings',
  'AgentDefaults',
  'NotificationSettings',
  'OrganizationSettings',
  'HostSettings',
  'HostAccess',
  'Integrations',
  'GitHubConnection',
  'About',
  'PullRequestReview',
  'PullRequestInlineComment',
  'PullRequestReviewers',
  'PullRequestLabels',
])

/** The topmost non-overlay route, with its key so thread selection can
 *  dismiss sheets without replacing the wrong destination. Settings stays an
 *  overlay for the layout (the sidebar stays beside it) but is the selected
 *  Android destination while its pages are on top. */
function workspaceLocationFromState(state: NavigationState<RootStackParamList>): WorkspaceLocation {
  const routes = state.routes.filter((route) => !WORKSPACE_OVERLAY_ROUTES.has(route.name))
  const route = routes.length > 0 ? routes[routes.length - 1] : state.routes[state.index]
  return {
    routeName: route?.name,
    routeKey: route?.key,
    // SAFETY: a route named 'Thread' is only pushed with `RootStackParamList['Thread']` params.
    thread: route?.name === 'Thread' ? (route.params as RootStackParamList['Thread']) : null,
    settingsOpen: settingsPagesOnTop(state) > 0,
  }
}

// iOS: the v5 workspace (system tab bar, iPad columns, v5 headers); Android: the native stack.
const Stack = createWorkspaceStackNavigator<RootStackParamList>()
const navigation = createNavigationContainerRef<RootStackParamList>()

export function RootNavigator({ initialState }: { initialState: InitialState }) {
  const themeVariables = useUniwindTheme()
  const navigationTheme = useMobileNavigationTheme()
  const { width, height } = useWindowDimensions()
  // Follow the workspace viewport as it resizes; compact iOS keeps sheets.
  const usesWorkspaceFlowScreens = Platform.OS === 'android' || deriveLayout({ width, height }).usesSplitView
  useKeyboardCommand('back', () => {
    if (!navigation.isReady() || !navigation.canGoBack()) return false
    navigation.goBack()
  })
  useEffect(() => {
    // A `solus://` link (a Live Activity row, or a host's pairing page) opens
    // over where the person was; one that arrives before the navigator is
    // ready waits for it.
    let pending: string | null = null
    const open = (url: string | null | undefined) => {
      const target = url ? parseDeepLink(url) : null
      if (!target) return
      if (!navigation.isReady()) pending = url ?? null
      else if (target.screen === 'Thread') navigation.navigate('Thread', target.params)
      else navigation.navigate('PairHost', target.params)
    }
    void Linking.getInitialURL().then(open).catch(() => undefined)
    const subscription = Linking.addEventListener('url', (event) => open(event.url))
    const ready = setInterval(() => {
      if (!pending || !navigation.isReady()) return
      const url = pending
      pending = null
      open(url)
    }, 250)
    return () => {
      subscription.remove()
      clearInterval(ready)
    }
  }, [])
  return (
    <WorkspaceTabsProvider>
      <NavigationContainer ref={navigation} theme={navigationTheme} initialState={initialState}>
        <Stack.Navigator
          layout={({ children, state }) => (
            <AdaptiveWorkspaceLayout location={workspaceLocationFromState(state)}>{children}</AdaptiveWorkspaceLayout>
          )}
          screenOptions={({ route }) => {
            // As T3 Code's stack: no header tint, so titles take the theme's
            // header foreground and buttons draw their own symbols.
            const base: NativeStackNavigationOptions = {
              contentStyle: { backgroundColor: themeVariables['--color-screen'] },
            }
            if (CONNECT_SHEET_ROUTES.has(route.name)) {
              return Platform.OS === 'ios' && usesWorkspaceFlowScreens ? { ...base, ...FORM_SHEET_PRESENTATION_OPTIONS } : base
            }
            if (!SHEET_ROUTES.has(route.name)) return base
            return usesWorkspaceFlowScreens
              ? { ...base, presentation: 'card' }
              : { ...base, ...FORM_SHEET_PRESENTATION_OPTIONS, sheetAllowedDetents: [0.92], sheetGrabberVisible: true }
          }}
        >
          <Stack.Screen
            name="Home"
            component={HomeRouteScreen}
            options={{
              ...GLASS_HEADER_OPTIONS,
              contentStyle: { backgroundColor: 'transparent' },
              headerBackVisible: false,
              ...getCompactBrandHeaderOptions(),
            }}
          />
          <Stack.Screen name="Thread" component={ThreadRouteScreen} options={GLASS_HEADER_OPTIONS} />
          <Stack.Screen name="ThreadSubagent" component={ProviderSubagentScreen} options={{ ...GLASS_HEADER_OPTIONS, title: 'Agent' }} />
          <Stack.Screen
            name="ThreadAgents"
            component={ThreadAgentsSheet}
            // T3 Code's Agents sheet (Stack.tsx): half height, drawn up to 0.9.
            options={{ ...FORM_SHEET_PRESENTATION_OPTIONS, headerShown: false, sheetAllowedDetents: [0.5, 0.9], sheetGrabberVisible: true }}
          />
          <Stack.Screen
            name="ThreadQueue"
            component={ThreadQueueSheet}
            // T3 Code's Queue sheet (Stack.tsx): 0.65 of the height, drawn up to 0.95.
            options={{ ...FORM_SHEET_PRESENTATION_OPTIONS, headerShown: false, sheetAllowedDetents: [0.65, 0.95], sheetGrabberVisible: true }}
          />
          <Stack.Screen
            name="ThreadSettings"
            component={ThreadSettingsRouteScreen}
            // T3 Code's ThreadSettingsSheet route (Stack.tsx): a full-height form sheet that hosts the
            // picker's own stack; a card on Android.
            options={{
              gestureEnabled: true,
              headerShown: false,
              ...(Platform.OS === 'android'
                ? { presentation: 'card' as const }
                : { ...FORM_SHEET_PRESENTATION_OPTIONS, sheetAllowedDetents: [1], sheetGrabberVisible: true }),
            }}
          />
          <Stack.Screen
            name="NewTask"
            component={NewTaskRouteScreen}
            options={{ ...SHEET_GLASS_HEADER_OPTIONS, title: 'Choose project', gestureEnabled: true }}
          />
          {/* T3 Code's Environment screen (Stack.tsx), pushed in the new-task sheet. */}
          <Stack.Screen
            name="NewTaskEnvironment"
            component={NewTaskEnvironmentPickerRouteScreen}
            options={{ ...SHEET_GLASS_HEADER_OPTIONS, title: 'Host' }}
          />
          <Stack.Screen name="Welcome" component={WelcomeScreen} options={{ headerShown: false }} />
          <Stack.Screen name="PairHost" component={PairHostScreen} options={{ title: 'Connect to a host' }} />
          <Stack.Screen name="CloudSignIn" component={CloudSignInScreen} options={{ title: 'Solus Cloud' }} />
          <Stack.Screen name="CloudHosts" component={CloudHostsScreen} options={{ title: 'Your hosts' }} />
          <Stack.Screen name="Hosts" component={HostsScreen} options={{ title: 'Hosts', headerLargeTitle: true }} />
          <Stack.Screen name="OpenProject" component={OpenProjectScreen} options={{ title: 'Open project' }} />
          <Stack.Screen name="NewProject" component={NewProjectScreen} options={{ title: 'Start a new project' }} />
          <Stack.Screen name="OpenFolder" component={OpenFolderScreen} options={{ title: 'Open an existing folder' }} />
          <Stack.Screen name="ProjectFromGithub" component={ProjectFromGithubScreen} options={{ title: 'Get a project from GitHub' }} />
          <Stack.Screen name="CloneProject" component={CloneProjectScreen} options={{ title: 'Clone from a URL' }} />
          <Stack.Screen name="Notifications" component={NotificationsScreen} options={{ title: 'Notifications', headerLargeTitle: true }} />
          {/* Settings and its pages (SETTINGS_PAGE_ROUTES). An Android phone keeps the
              navigation bar under them when Settings was chosen from it. */}
          <Stack.Group screenLayout={({ children }) => <WorkspaceSettingsFrame>{children}</WorkspaceSettingsFrame>}>
            <Stack.Screen
              name="Settings"
              component={SettingsScreen}
              // Android: a top-level destination, so it swaps like the list tabs.
              options={{ title: 'Settings', gestureEnabled: true, ...(Platform.OS === 'android' ? { animation: 'none' as const } : null) }}
            />
            <Stack.Screen name="AccountSync" component={AccountSyncScreen} options={{ title: 'Account & sync' }} />
            <Stack.Screen name="AgentProfile" component={AgentProfileScreen} options={{ title: 'Agent profile' }} />
            <Stack.Screen name="AppearanceSettings" component={AppearanceScreen} options={{ title: 'Appearance' }} />
            <Stack.Screen name="OrganizationSettings" component={OrganizationSettingsScreen} options={{ title: 'Organization' }} />
            <Stack.Screen name="HostSettings" component={HostSettingsScreen} options={{ title: 'Host settings' }} />
            <Stack.Screen name="HostAccess" component={HostAccessScreen} options={{ title: 'Access' }} />
            <Stack.Screen name="Integrations" component={IntegrationsScreen} options={{ title: 'MCP' }} />
            <Stack.Screen name="AgentDefaults" component={AgentDefaultsScreen} options={{ title: 'Agent defaults' }} />
            <Stack.Screen name="NotificationSettings" component={NotificationSettingsScreen} options={{ title: 'Notifications' }} />
            <Stack.Screen name="GitHubConnection" component={GitHubConnectionScreen} options={{ title: 'GitHub' }} />
            <Stack.Screen name="About" component={AboutScreen} options={{ title: 'About Solus' }} />
          </Stack.Group>
          <Stack.Screen name="PullRequest" component={PullRequestScreen} options={{ title: 'Pull request' }} />
          <Stack.Screen name="PullRequestFiles" component={PullRequestFilesScreen} options={{ title: 'Changed files' }} />
          {/* T3 Code's pull request sheets (Stack.tsx, #22390): form sheets with the native glass
              header on iOS (PullRequestSheetContent fills it); Android draws its own header. */}
          <Stack.Screen
            name="PullRequestReview"
            component={PullRequestReviewSheet}
            options={{ ...PULL_REQUEST_SHEET_HEADER_OPTIONS, ...FORM_SHEET_PRESENTATION_OPTIONS, sheetAllowedDetents: [0.75, 0.92], sheetGrabberVisible: true }}
          />
          <Stack.Screen
            name="PullRequestAsk"
            component={PullRequestAskScreen}
            options={{ ...PULL_REQUEST_SHEET_HEADER_OPTIONS, ...FORM_SHEET_PRESENTATION_OPTIONS, sheetAllowedDetents: [0.75, 0.92], sheetGrabberVisible: true }}
          />
          <Stack.Screen
            name="PullRequestInlineComment"
            component={PullRequestInlineCommentScreen}
            options={Platform.OS === 'android'
              ? { presentation: 'fullScreenModal', headerShown: false }
              : { ...SHEET_GLASS_HEADER_OPTIONS, ...FORM_SHEET_PRESENTATION_OPTIONS, sheetAllowedDetents: [0.75, 0.92], sheetGrabberVisible: true }}
          />
          <Stack.Screen name="PullRequestDiscussion" component={PullRequestDiscussionScreen} options={{ ...SOLID_HEADER_OPTIONS, title: 'Discussion' }} />
          <Stack.Screen
            name="PullRequestReviewers"
            component={PullRequestReviewersScreen}
            options={{ ...SHEET_SOLID_HEADER_OPTIONS, ...FORM_SHEET_PRESENTATION_OPTIONS, title: 'Request review', headerBackVisible: false, headerShown: Platform.OS !== 'android', sheetAllowedDetents: [0.75, 0.92], sheetGrabberVisible: true }}
          />
          <Stack.Screen
            name="PullRequestLabels"
            component={PullRequestLabelsScreen}
            options={{ ...SHEET_SOLID_HEADER_OPTIONS, ...FORM_SHEET_PRESENTATION_OPTIONS, title: 'Labels', headerBackVisible: false, sheetAllowedDetents: [0.75, 0.92], sheetGrabberVisible: true }}
          />
          <Stack.Screen name="Files" component={FilesScreen} options={{ title: 'Files' }} />
          <Stack.Screen name="File" component={FileScreen} options={{ title: 'File' }} />
        </Stack.Navigator>
      </NavigationContainer>
    </WorkspaceTabsProvider>
  )
}
