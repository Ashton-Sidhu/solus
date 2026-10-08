import {
  NavigationContainer,
  createNavigationContainerRef,
  type InitialState,
  type NavigationState,
} from '@react-navigation/native'
import { createNativeStackNavigator, type NativeStackNavigationOptions } from '@react-navigation/native-stack'
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
import { NewTaskRouteScreen } from '../features/threads/NewTaskRouteScreen'
import { HostsScreen } from '../features/hosts/HostsScreen'
import { PairHostScreen } from '../features/hosts/PairHostScreen'
import { AdaptiveWorkspaceLayout, type WorkspaceLocation } from '../features/layout/AdaptiveWorkspaceLayout'
import { WelcomeScreen } from '../features/onboarding/WelcomeScreen'
import { OpenProjectScreen } from '../features/projects/OpenProjectScreen'
import { NewProjectScreen } from '../features/projects/NewProjectScreen'
import { OpenFolderScreen } from '../features/projects/OpenFolderScreen'
import { ProjectFromGithubScreen } from '../features/projects/ProjectFromGithubScreen'
import { CloneProjectScreen } from '../features/projects/CloneProjectScreen'
import { NotificationsScreen } from '../features/notifications/NotificationsScreen'
import { BuildsScreen } from '../features/devices/BuildsScreen'
import { BuildFolderScreen } from '../features/devices/BuildFolderScreen'
import { NewBuildScreen } from '../features/devices/NewBuildScreen'
import { BuildProfilesScreen } from '../features/devices/BuildProfilesScreen'
import { SettingsScreen } from '../features/settings/SettingsScreen'
import { AppearanceScreen } from '../features/settings/AppearanceScreen'
import { PersonalSettingsScreen } from '../features/settings/PersonalSettingsScreen'
import { OrganizationSettingsScreen } from '../features/settings/OrganizationSettingsScreen'
import { HostSettingsScreen } from '../features/settings/HostSettingsScreen'
import { HostAccessScreen } from '../features/settings/HostAccessScreen'
import { IntegrationsScreen } from '../features/settings/IntegrationsScreen'
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

// Header presets adapted from T3 Code apps/mobile/src/Stack.tsx (MIT, see UPSTREAM.md).
const HEADER_SCROLL_EDGE_EFFECTS = nativeHeaderScrollEdgeEffects(Platform.OS, Platform.Version)

type AppScreenOptions = NativeStackNavigationOptions & {
  /** T3's patched react-native-screens option (patches/react-native-screens@4.28.0.patch). */
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

/** Settings and the new-task flow, which T3 presents as sheets. */
const SHEET_ROUTES = new Set<keyof RootStackParamList>(['Settings', 'NewTask'])

// Routes presented as sheets/overlays ON TOP of the workspace. They must not
// influence the adaptive workspace layout: opening Settings over Home should
// not flip the sidebar in or change the active thread. Settings pages pushed
// from the Settings sheet stay in it.
const WORKSPACE_OVERLAY_ROUTES = new Set<keyof RootStackParamList>([
  'NewTask',
  'Settings',
  'PersonalSettings',
  'AppearanceSettings',
  'AgentDefaults',
  'NotificationSettings',
  'OrganizationSettings',
  'HostSettings',
  'HostAccess',
  'Integrations',
  'GitHubConnection',
  'About',
])

/** The topmost non-overlay route, with its key so thread selection can
 *  dismiss sheets without replacing the wrong destination. */
function workspaceLocationFromState(state: NavigationState<RootStackParamList>): WorkspaceLocation {
  const routes = state.routes.filter((route) => !WORKSPACE_OVERLAY_ROUTES.has(route.name))
  const route = routes.length > 0 ? routes[routes.length - 1] : state.routes[state.index]
  return {
    routeName: route?.name,
    routeKey: route?.key,
    // SAFETY: a route named 'Thread' is only pushed with `RootStackParamList['Thread']` params.
    thread: route?.name === 'Thread' ? (route.params as RootStackParamList['Thread']) : null,
  }
}

const Stack = createNativeStackNavigator<RootStackParamList>()
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
    // A `solus://` link (a Live Activity row) opens its session over where the
    // person was; one that arrives before the navigator is ready waits for it.
    let pending: string | null = null
    const open = (url: string | null | undefined) => {
      const target = url ? parseDeepLink(url) : null
      if (!target) return
      if (navigation.isReady()) navigation.navigate(target.screen, target.params)
      else pending = url ?? null
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
        <Stack.Screen
          name="ThreadAgents"
          component={ThreadAgentsSheet}
          // T3 Code's Agents sheet (Stack.tsx): half height, drawn up to 0.9.
          options={{ ...FORM_SHEET_PRESENTATION_OPTIONS, headerShown: false, sheetAllowedDetents: [0.5, 0.9], sheetGrabberVisible: true }}
        />
        <Stack.Screen
          name="NewTask"
          component={NewTaskRouteScreen}
          options={{ ...SHEET_GLASS_HEADER_OPTIONS, title: 'Choose project', gestureEnabled: true }}
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
        <Stack.Screen name="Builds" component={BuildsScreen} options={{ title: 'App builds' }} />
        <Stack.Screen name="BuildFolder" component={BuildFolderScreen} options={{ title: 'Add a build' }} />
        <Stack.Screen name="NewBuild" component={NewBuildScreen} options={{ title: 'New build' }} />
        <Stack.Screen name="BuildProfiles" component={BuildProfilesScreen} options={{ title: 'Build profiles' }} />
        <Stack.Screen name="Notifications" component={NotificationsScreen} options={{ title: 'Notifications', headerLargeTitle: true }} />
        <Stack.Screen name="Settings" component={SettingsScreen} options={{ title: 'Settings', gestureEnabled: true }} />
        <Stack.Screen name="PersonalSettings" component={PersonalSettingsScreen} options={{ title: 'Personal' }} />
        <Stack.Screen name="AppearanceSettings" component={AppearanceScreen} options={{ title: 'Appearance' }} />
        <Stack.Screen name="OrganizationSettings" component={OrganizationSettingsScreen} options={{ title: 'Organization' }} />
        <Stack.Screen name="HostSettings" component={HostSettingsScreen} options={{ title: 'Host settings' }} />
        <Stack.Screen name="HostAccess" component={HostAccessScreen} options={{ title: 'Access' }} />
        <Stack.Screen name="Integrations" component={IntegrationsScreen} options={{ title: 'MCP' }} />
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
