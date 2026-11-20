import { PrInspectScreen } from '../features/prs/PrInspectScreen'
import { TaskRouteScreen } from '../features/tasks/TaskRouteScreen'
import { TaskSourcesScreen } from '../features/tasks/TaskSourcesScreen'
import { TaskCreateScreen } from '../features/tasks/TaskCreateScreen'
import { RunningServersScreen } from '../features/running-servers/RunningServersScreen'
import { SettingsScopeScreen } from '../features/settings/SettingsScopeScreen'
import { ProviderInstancesScreen } from '../features/settings/ProviderInstancesScreen'
import {
  NavigationContainer,
  createNavigationContainerRef,
  type InitialState,
  type NavigationState,
} from '@react-navigation/native'
import type { NativeStackNavigationOptions } from '@react-navigation/native-stack'
import { useEffect, useRef } from 'react'
import { Linking, Platform, useWindowDimensions } from 'react-native'
import { parseDeepLink } from './deep-links'
import { useUniwindTheme } from '../lib/useUniwindTheme'
import { getCompactBrandHeaderOptions } from '../components/CompactBrandTitle'
import { deriveLayout } from '../lib/layout'
import { useMobileNavigationTheme } from '../lib/useMobileNavigationTheme'
import { NATIVE_LIQUID_GLASS_SUPPORTED } from '../native/native-glass'
import { nativeHeaderScrollEdgeEffects } from '../native/StackHeader'
import { formSheetDetents } from '../native/sheet-detents'
import { FORM_SHEET_PRESENTATION_OPTIONS } from '../native/sheet-surface'
import { CloudHostsScreen } from '../features/account/CloudHostsScreen'
import { CloudSignInScreen } from '../features/account/CloudSignInScreen'
import { HomeRouteScreen } from '../features/home/HomeRouteScreen'
import { ThreadRouteScreen } from '../features/threads/ThreadRouteScreen'
import { ThreadAgentsSheet } from '../features/threads/ThreadAgents'
import { ProviderSubagentScreen } from '../features/threads/ProviderSubagentScreen'
import { ThreadQueueSheet } from '../features/threads/ThreadQueueSheet'
import { ThreadSettingsRouteScreen } from '../features/threads/ThreadSettingsSheet'
import { HostBalancingScreen } from '../features/hosts/HostBalancingScreen'
import { HostResourcesScreen } from '../features/hosts/HostResourcesScreen'
import { NewTaskRouteScreen } from '../features/threads/NewTaskRouteScreen'
import { NewTaskBranchPickerRouteScreen, NewTaskEnvironmentPickerRouteScreen } from '../features/threads/NewTaskContextPickerScreens'
import { HostsScreen } from '../features/hosts/HostsScreen'
import { PairHostScreen } from '../features/hosts/PairHostScreen'
import { AddSshHostScreen } from '../features/hosts/AddSshHostScreen'
import { ChooseSshKeyScreen } from '../features/hosts/ChooseSshKeyScreen'
import { AddWslHostScreen } from '../features/hosts/AddWslHostScreen'
import { AdaptiveWorkspaceLayout, type WorkspaceLocation } from '../features/layout/AdaptiveWorkspaceLayout'
import { createWorkspaceStackNavigator } from '../features/layout/createWorkspaceStackNavigator'
import { WorkspaceTabsProvider } from '../features/workspace/WorkspaceTabsContext'
import { WorkspaceSettingsFrame } from '../features/workspace/WorkspaceSettingsFrame'
import { settingsPagesOnTop } from '../features/workspace/workspace-destinations'
import { WelcomeScreen } from '../features/onboarding/WelcomeScreen'
import { OpenProjectScreen } from '../features/projects/OpenProjectScreen'
import { NewProjectScreen } from '../features/projects/NewProjectScreen'
import { CloneDestinationScreen, OpenFolderScreen } from '../features/projects/OpenFolderScreen'
import { ProjectFromGithubScreen } from '../features/projects/ProjectFromGithubScreen'
import { CloneProjectScreen } from '../features/projects/CloneProjectScreen'
import { NotificationsScreen } from '../features/notifications/NotificationsScreen'
import { SettingsScreen } from '../features/settings/SettingsScreen'
import { AppearanceScreen } from '../features/settings/AppearanceScreen'
import { AccountSyncScreen } from '../features/settings/AccountSyncScreen'
import { AgentProfileScreen } from '../features/settings/AgentProfileScreen'
import { PolicyScreen } from '../features/policy/PolicyScreen'
import { DeviceSettingsScreen } from '../features/devices/DeviceSettingsScreen'
import { DevicesScreen } from '../features/devices/DevicesScreen'
import { DevicePreviewRouteScreen } from '../features/devices/DevicePreviewRouteScreen'
import { BrowserPreviewRouteScreen } from '../features/browser/BrowserPreviewRouteScreen'
import { HostSettingsScreen } from '../features/settings/HostSettingsScreen'
import { HostAccessScreen } from '../features/settings/HostAccessScreen'
import { HostRoutesScreen } from '../features/hosts/HostRoutesScreen'
import { IntegrationsScreen } from '../features/settings/IntegrationsScreen'
import { WebhooksScreen } from '../features/webhooks/WebhooksScreen'
import { WebhookScreen } from '../features/webhooks/WebhookScreen'
import { WebhookDeliveryScreen } from '../features/webhooks/WebhookDeliveryScreen'
import { ProvidersScreen, ProviderSettingsScreen } from '../features/settings/ProvidersScreen'
import { ChatSettingsScreen } from '../features/settings/ChatSettingsScreen'
import { AgentDefaultsScreen } from '../features/settings/AgentDefaultsScreen'
import { VoiceSettingsScreen } from '../features/settings/VoiceSettingsScreen'
import { VoiceTermScreen } from '../features/settings/VoiceTermScreen'
import { NotificationSettingsScreen } from '../features/settings/NotificationSettingsScreen'
import { GitHubConnectionScreen } from '../features/settings/GitHubConnectionScreen'
import { AboutScreen } from '../features/settings/AboutScreen'
import { PullRequestScreen } from '../features/prs/PullRequestScreen'
import { PullRequestReviewSheet } from '../features/prs/PullRequestReviewSheet'
import { PullRequestInlineCommentScreen } from '../features/prs/PullRequestInlineCommentScreen'
import { PullRequestDiscussionScreen } from '../features/prs/PullRequestDiscussionScreen'
import { PullRequestFilesScreen } from '../features/prs/PullRequestFilesScreen'
import { CloudTurnDiffScreen } from '../features/threads/CloudTurnDiffScreen'
import { PullRequestAskScreen } from '../features/prs/PullRequestAskScreen'
import { PullRequestReviewersScreen } from '../features/prs/PullRequestReviewersScreen'
import { PullRequestEditSheet } from '../features/prs/PullRequestEditSheet'
import { PullRequestLabelsScreen } from '../features/prs/PullRequestLabelsScreen'
import { PullRequestFilterSearchScreen } from '../features/prs/PullRequestFilterSearchScreen'
import { FilesScreen } from '../features/files/FilesScreen'
import { ArtifactsScreen } from '../features/threads/artifacts/ArtifactsScreen'
import { AppsScreen } from '../features/apps/AppsScreen'
import { AppScreen } from '../features/apps/AppScreen'
import { AppManageScreen } from '../features/apps/AppManageScreen'
import { AppSectionScreen } from '../features/apps/AppSectionScreen'
import { AppCallScreen } from '../features/apps/AppCallScreen'
import { AppRunScreen } from '../features/apps/AppRunScreen'
import { AppModelCallScreen } from '../features/apps/AppModelCallScreen'
import { AppBuildLogScreen } from '../features/apps/AppBuildLogScreen'
import { AppOperationScreen } from '../features/apps/AppOperationScreen'
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

/** Pairing and the Solus Cloud sign-in: a centered form sheet on a wide iPad, not a full-width page. */
const CONNECT_SHEET_ROUTES = new Set<keyof RootStackParamList>(['PairHost', 'CloudSignIn', 'CloudHosts'])

// Routes presented as sheets/overlays ON TOP of the workspace. They must not
// influence the adaptive workspace layout: opening Settings from Home should
// not flip the sidebar in or change the active thread. Settings pages pushed
// from a sheet stay in that presentation group.
const WORKSPACE_OVERLAY_ROUTES = new Set<keyof RootStackParamList>([
  'PairHost',
  'AddSshHost',
  'ChooseSshKey',
  'AddWslHost',
  'CloudSignIn',
  'CloudHosts',
  'ThreadAgents',
  'ThreadQueue',
  'ThreadSettings',
  'ThreadDevicePreview',
  'ThreadBrowserPreview',
  'Settings',
  'AccountSync',
  'AgentProfile',
  'AppearanceSettings',
  'SettingsScope',
  'ProviderInstances',
  'Providers',
  'ProviderSettings',
  'ChatSettings',
  'AgentDefaults',
  'NotificationSettings',
  'VoiceSettings',
  'VoiceTerm',
  'Policy',
  'HostSettings',
  'HostResources',
  'HostBalancing',
  'DeviceSettings',
  'Devices',
  'HostAccess',
  'HostRoutes',
  'Integrations',
  'Webhooks',
  'Webhook',
  'WebhookDelivery',
  'Apps',
  'GitHubConnection',
  'About',
  'PullRequestReview',
  'PullRequestInlineComment',
  'PullRequestReviewers',
  'PullRequestLabels',
  'PullRequestEdit',
  'PullRequestFilterSearch',
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
  // Moving an open sheet or flow between a sheet and a column remounts its
  // screen. Each keeps the presentation it opened with until it is dismissed,
  // so a fold or a resize keeps the draft (T3 #23366).
  const flowPresentations = useRef(new Map<string, boolean>())
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
          screenListeners={{
            state: ({ data }) => {
              const keys = new Set(data.state.routes.map((route) => route.key))
              for (const key of flowPresentations.current.keys()) {
                if (!keys.has(key)) flowPresentations.current.delete(key)
              }
            },
          }}
          screenOptions={({ route }) => {
            // As T3 Code's stack: no header tint, so titles take the theme's
            // header foreground and buttons draw their own symbols.
            const base: NativeStackNavigationOptions = {
              contentStyle: { backgroundColor: themeVariables['--color-screen'] },
            }
            if (!CONNECT_SHEET_ROUTES.has(route.name)) return base
            let usesFlowScreen = flowPresentations.current.get(route.key)
            if (usesFlowScreen === undefined) {
              usesFlowScreen = usesWorkspaceFlowScreens
              flowPresentations.current.set(route.key, usesFlowScreen)
            }
            return Platform.OS === 'ios' && usesFlowScreen ? { ...base, ...FORM_SHEET_PRESENTATION_OPTIONS } : base
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
          <Stack.Screen name="Task" component={TaskRouteScreen} options={GLASS_HEADER_OPTIONS} />
          <Stack.Screen name="TaskSources" component={TaskSourcesScreen} options={GLASS_HEADER_OPTIONS} />
          <Stack.Screen name="TaskCreate" component={TaskCreateScreen} options={GLASS_HEADER_OPTIONS} />
          <Stack.Screen name="Thread" component={ThreadRouteScreen} options={GLASS_HEADER_OPTIONS} />
          <Stack.Screen name="ThreadSubagent" component={ProviderSubagentScreen} options={{ ...GLASS_HEADER_OPTIONS, title: 'Agent' }} />
          <Stack.Screen
            name="ThreadAgents"
            component={ThreadAgentsSheet}
            // T3 Code's Agents sheet (Stack.tsx): half height, drawn up to 0.9.
            options={{ ...FORM_SHEET_PRESENTATION_OPTIONS, headerShown: false, sheetAllowedDetents: formSheetDetents(Platform.OS, 0.5, 0.9), sheetGrabberVisible: true }}
          />
          <Stack.Screen
            name="ThreadQueue"
            component={ThreadQueueSheet}
            // T3 Code's Queue sheet (Stack.tsx): 0.65 of the height, drawn up to 0.95.
            options={{ ...FORM_SHEET_PRESENTATION_OPTIONS, headerShown: false, sheetAllowedDetents: formSheetDetents(Platform.OS, 0.65, 0.95), sheetGrabberVisible: true }}
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
            options={{ ...GLASS_HEADER_OPTIONS, title: 'Choose project', gestureEnabled: true }}
          />
          {/* T3 Code's Environment and Branch screens (Stack.tsx), pushed in the new-task sheet. */}
          <Stack.Screen
            name="NewTaskEnvironment"
            component={NewTaskEnvironmentPickerRouteScreen}
            options={{ ...SHEET_GLASS_HEADER_OPTIONS, title: 'Host' }}
          />
          <Stack.Screen
            name="NewTaskBranch"
            component={NewTaskBranchPickerRouteScreen}
            options={{ ...SHEET_GLASS_HEADER_OPTIONS, title: 'Base branch' }}
          />
          <Stack.Screen name="Welcome" component={WelcomeScreen} options={{ headerShown: false }} />
          <Stack.Screen name="PairHost" component={PairHostScreen} options={{ title: 'Connect to a host' }} />
          <Stack.Screen name="AddSshHost" component={AddSshHostScreen} options={{ title: 'Add over SSH' }} />
          <Stack.Screen name="ChooseSshKey" component={ChooseSshKeyScreen} options={{ title: 'Identity file' }} />
          <Stack.Screen name="AddWslHost" component={AddWslHostScreen} options={{ title: 'Add WSL distro' }} />
          <Stack.Screen name="CloudSignIn" component={CloudSignInScreen} options={{ title: 'Solus Cloud' }} />
          <Stack.Screen name="CloudHosts" component={CloudHostsScreen} options={{ title: 'Your hosts' }} />
          <Stack.Screen name="Hosts" component={HostsScreen} options={{ title: 'Hosts', headerLargeTitle: true }} />
          <Stack.Screen name="OpenProject" component={OpenProjectScreen} options={{ ...GLASS_HEADER_OPTIONS, title: 'Add project' }} />
          <Stack.Screen name="NewProject" component={NewProjectScreen} options={{ ...GLASS_HEADER_OPTIONS, title: 'New project' }} />
          <Stack.Screen name="OpenFolder" component={OpenFolderScreen} options={{ ...GLASS_HEADER_OPTIONS, title: 'Local folder' }} />
          <Stack.Screen name="ProjectFromGithub" component={ProjectFromGithubScreen} options={{ ...GLASS_HEADER_OPTIONS, title: 'GitHub' }} />
          <Stack.Screen name="CloneProject" component={CloneProjectScreen} options={{ ...GLASS_HEADER_OPTIONS, title: 'Git URL' }} />
          <Stack.Screen name="CloneDestination" component={CloneDestinationScreen} options={{ ...GLASS_HEADER_OPTIONS, title: 'Clone destination' }} />
          <Stack.Screen name="Notifications" component={NotificationsScreen} options={{ title: 'Notifications', headerLargeTitle: true }} />
          {/* Settings and its pages (SETTINGS_PAGE_ROUTES). An Android phone keeps the
              navigation bar under them when Settings was chosen from it. */}
          <Stack.Group screenLayout={({ children }) => <WorkspaceSettingsFrame>{children}</WorkspaceSettingsFrame>} screenOptions={SHEET_GLASS_HEADER_OPTIONS}>
            <Stack.Screen
              name="Settings"
              component={SettingsScreen}
              // Android: a top-level destination, so it swaps like the list tabs.
              options={{ title: 'Settings', gestureEnabled: true, ...(Platform.OS === 'android' ? { animation: 'none' as const } : null) }}
            />
            <Stack.Screen name="AccountSync" component={AccountSyncScreen} options={{ title: 'Account & sync' }} />
            <Stack.Screen name="AgentProfile" component={AgentProfileScreen} options={{ title: 'Agent profile' }} />
            <Stack.Screen name="AppearanceSettings" component={AppearanceScreen} options={{ title: 'Appearance' }} />
            <Stack.Screen name="Policy" component={PolicyScreen} options={{ title: 'Policy' }} />
            <Stack.Screen name="DeviceSettings" component={DeviceSettingsScreen} options={{ title: 'Devices' }} />
            <Stack.Screen name="Devices" component={DevicesScreen} options={{ title: 'Devices' }} />
            <Stack.Screen name="HostSettings" component={HostSettingsScreen} options={{ title: 'Host settings' }} />
            <Stack.Screen name="HostResources" component={HostResourcesScreen} options={{ title: 'Resources' }} />
            <Stack.Screen name="HostBalancing" component={HostBalancingScreen} options={{ title: 'Auto balance' }} />
            <Stack.Screen name="HostAccess" component={HostAccessScreen} options={{ title: 'Access' }} />
            <Stack.Screen name="HostRoutes" component={HostRoutesScreen} options={{ title: 'Routes' }} />
            <Stack.Screen name="Integrations" component={IntegrationsScreen} options={{ title: 'MCP' }} />
            <Stack.Screen name="Webhooks" component={WebhooksScreen} options={{ title: 'Webhooks' }} />
            <Stack.Screen name="Webhook" component={WebhookScreen} options={{ title: 'Webhook' }} />
            <Stack.Screen name="WebhookDelivery" component={WebhookDeliveryScreen} options={{ title: 'Delivery' }} />
            <Stack.Screen name="Apps" component={AppsScreen} options={{ title: 'Apps' }} />
            <Stack.Screen name="SettingsScope" component={SettingsScopeScreen} options={{ title: 'Apply settings for' }} />
            <Stack.Screen name="ProviderInstances" component={ProviderInstancesScreen} options={{ title: 'Provider instances' }} />
            <Stack.Screen name="Providers" component={ProvidersScreen} options={{ title: 'Providers' }} />
            <Stack.Screen name="ProviderSettings" component={ProviderSettingsScreen} options={{ title: 'Provider settings' }} />
            <Stack.Screen name="ChatSettings" component={ChatSettingsScreen} options={{ title: 'Chat' }} />
            <Stack.Screen name="AgentDefaults" component={AgentDefaultsScreen} options={{ title: 'Sessions' }} />
            <Stack.Screen name="VoiceSettings" component={VoiceSettingsScreen} options={{ title: 'Voice' }} />
            <Stack.Screen name="VoiceTerm" component={VoiceTermScreen} options={{ title: 'Term' }} />
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
            options={{ ...PULL_REQUEST_SHEET_HEADER_OPTIONS, ...FORM_SHEET_PRESENTATION_OPTIONS, sheetAllowedDetents: formSheetDetents(Platform.OS, 0.75), sheetGrabberVisible: true }}
          />
          <Stack.Screen
            name="PullRequestAsk"
            component={PullRequestAskScreen}
            options={{ ...PULL_REQUEST_SHEET_HEADER_OPTIONS, ...FORM_SHEET_PRESENTATION_OPTIONS, sheetAllowedDetents: formSheetDetents(Platform.OS, 0.75), sheetGrabberVisible: true }}
          />
          <Stack.Screen
            name="PullRequestInlineComment"
            component={PullRequestInlineCommentScreen}
            options={Platform.OS === 'android'
              ? { presentation: 'fullScreenModal', headerShown: false }
              : { ...SHEET_GLASS_HEADER_OPTIONS, ...FORM_SHEET_PRESENTATION_OPTIONS, sheetAllowedDetents: formSheetDetents(Platform.OS, 0.75), sheetGrabberVisible: true }}
          />
          <Stack.Screen name="PullRequestDiscussion" component={PullRequestDiscussionScreen} options={{ ...SOLID_HEADER_OPTIONS, title: 'Discussion' }} />
          <Stack.Screen
            name="PullRequestReviewers"
            component={PullRequestReviewersScreen}
            options={{ ...SHEET_SOLID_HEADER_OPTIONS, ...FORM_SHEET_PRESENTATION_OPTIONS, title: 'Request review', headerBackVisible: false, headerShown: Platform.OS !== 'android', sheetAllowedDetents: formSheetDetents(Platform.OS, 0.75), sheetGrabberVisible: true }}
          />
          <Stack.Screen
            name="PullRequestLabels"
            component={PullRequestLabelsScreen}
            options={{ ...SHEET_SOLID_HEADER_OPTIONS, ...FORM_SHEET_PRESENTATION_OPTIONS, title: 'Labels', headerBackVisible: false, sheetAllowedDetents: formSheetDetents(Platform.OS, 0.75), sheetGrabberVisible: true }}
          />
          <Stack.Screen
            name="PullRequestEdit"
            component={PullRequestEditSheet}
            options={{ ...PULL_REQUEST_SHEET_HEADER_OPTIONS, ...FORM_SHEET_PRESENTATION_OPTIONS, sheetAllowedDetents: formSheetDetents(Platform.OS, 0.75), sheetGrabberVisible: true }}
          />
          <Stack.Screen name="PrInspect" component={PrInspectScreen} options={{ title: "Inspect PR" }} />
        <Stack.Screen
            name="PullRequestFilterSearch"
            component={PullRequestFilterSearchScreen}
            options={{ ...SHEET_SOLID_HEADER_OPTIONS, ...FORM_SHEET_PRESENTATION_OPTIONS, title: 'Search', headerBackVisible: false, sheetAllowedDetents: formSheetDetents(Platform.OS, 0.75), sheetGrabberVisible: true }}
          />
          <Stack.Screen name="Files" component={FilesScreen} options={{ title: 'Files' }} />
          <Stack.Screen name="File" component={FileScreen} options={{ title: 'File' }} />
          <Stack.Screen name="ThreadArtifacts" component={ArtifactsScreen} options={{ title: 'Threads' }} />
          <Stack.Screen name="ThreadTurnDiff" component={CloudTurnDiffScreen} options={{ title: 'Changes' }} />
          {/* T3 Code's device and browser viewers (Stack.tsx): the device full screen with no
              bars and no swipe to dismiss, because a drag on it is input to the device; the
              browser under a solid header. The browser keeps the edge swipe: with gestures off,
              the v5 stack also ignores its Back button. */}
          <Stack.Screen
            name="ThreadDevicePreview"
            component={DevicePreviewRouteScreen}
            options={{ presentation: 'fullScreenModal', headerShown: false, gestureEnabled: false, statusBarHidden: true, navigationBarHidden: true }}
          />
          <Stack.Screen name="RunningServers" component={RunningServersScreen} options={{ ...SOLID_HEADER_OPTIONS, title: 'Running servers' }} />
          <Stack.Screen
            name="ThreadBrowserPreview"
            component={BrowserPreviewRouteScreen}
            options={{ ...SOLID_HEADER_OPTIONS, title: 'Browser', presentation: 'modal' }}
          />
          {/* The app frame scrolls inside its web view, so the header is solid. */}
          <Stack.Screen name="App" component={AppScreen} options={{ ...SOLID_HEADER_OPTIONS, title: 'App' }} />
          {/* The Manage screen and its pages are pushed on the app, as the pages of a pull request are. */}
          <Stack.Screen name="AppManage" component={AppManageScreen} options={{ title: 'Manage' }} />
          <Stack.Screen name="AppSection" component={AppSectionScreen} options={{ title: 'Manage' }} />
          <Stack.Screen name="AppCall" component={AppCallScreen} options={{ title: 'Call' }} />
          <Stack.Screen name="AppRun" component={AppRunScreen} options={{ title: 'Run' }} />
          <Stack.Screen name="AppModelCall" component={AppModelCallScreen} options={{ title: 'Model call' }} />
          <Stack.Screen name="AppBuildLog" component={AppBuildLogScreen} options={{ title: 'Build log' }} />
          <Stack.Screen name="AppOperation" component={AppOperationScreen} options={{ title: 'Operation' }} />
        </Stack.Navigator>
      </NavigationContainer>
    </WorkspaceTabsProvider>
  )
}
