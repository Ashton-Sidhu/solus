// T3 Code's styling system; must load before any component renders.
import '../global.css'
import { useEffect, useState, type ReactNode } from 'react'
import { ActivityIndicator, StatusBar, View } from 'react-native'
import { useFonts } from 'expo-font'
import { JetBrainsMono_400Regular } from '@expo-google-fonts/jetbrains-mono/400Regular'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { KeyboardProvider } from 'react-native-keyboard-controller'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import type { InitialState } from '@react-navigation/native'
import { AppProvider, useListened } from './app/app-context'
import { initialRoutes } from './app/initial-route'
import { SolusApp } from './app/solus-app'
import { ConfirmDialogHost } from './components/ConfirmDialogHost'
import { OverlayPortalHost } from './components/OverlayPortal'
import { KeyboardCommandsView } from './features/keyboard/KeyboardCommandsView'
import {
  AppearancePreferencesProvider,
  useAppearancePreferences,
} from './features/settings/appearance/AppearancePreferencesProvider'
import { RootNavigator } from './navigation/RootNavigator'
import { expoPlatform, watchAppLifecycle } from './platform/expo'
import { ThemeProvider, usePalette } from './theme/theme'

const app = new SolusApp(expoPlatform)

/** Provider order adapted from T3 Code apps/mobile/src/App.tsx (MIT, see UPSTREAM.md);
 *  the appearance provider reads the app, so the app wraps it. */
export default function App() {
  return (
    <AppProvider app={app}>
      <AppearancePreferencesProvider>
        <AppContent />
      </AppearancePreferencesProvider>
    </AppProvider>
  )
}

function AppContent() {
  const { themeAppearance } = useAppearancePreferences()
  const [initialState, setInitialState] = useState<InitialState | null>(null)
  // A font that fails to load falls back to the system's; it never blocks the app.
  const [fontsLoaded, fontError] = useFonts({ JetBrainsMono_400Regular })
  const ready = !!initialState && (fontsLoaded || !!fontError)

  useEffect(() => {
    let active = true
    let stopNotifications = () => {}
    // The load barrier: nothing restores or dials before credentials are read.
    void app.load().then(() => {
      if (!active) return
      stopNotifications = app.notifications.start(app.account.changes)
      const routes = initialRoutes({
        hasHosts: app.registry.hosts().length > 0,
        isSignedIn: app.account.isSignedIn,
        lastRoute: app.lastRoute(),
      })
      setInitialState({ index: routes.length - 1, routes })
    })
    const stopLifecycle = watchAppLifecycle(app.connections, () => void app.notifications.refresh())
    return () => {
      active = false
      stopLifecycle()
      stopNotifications()
    }
  }, [])

  return (
    <GestureHandlerRootView className="flex-1">
      <KeyboardProvider statusBarTranslucent>
        <SafeAreaProvider>
          <ThemeProvider>
            <StatusBar barStyle={themeAppearance === 'dark' ? 'light-content' : 'dark-content'} />
            <View style={{ flex: 1 }}>
              {ready && initialState ? <KeyboardRoot><RootNavigator initialState={initialState} /></KeyboardRoot> : <Loading />}
              <ConfirmDialogHost />
            </View>
            {/* Anchored-menu overlays render here — in-window, so the
                keyboard stays up while a dropdown is open. */}
            <OverlayPortalHost />
          </ThemeProvider>
        </SafeAreaProvider>
      </KeyboardProvider>
    </GestureHandlerRootView>
  )
}

/** Offers the commands the mounted screens handle to the hardware keyboard. */
function KeyboardRoot({ children }: { children: ReactNode }) {
  const enabledCommands = useListened(app.keyboard.changes, app.keyboard.enabledCommands)
  return <KeyboardCommandsView enabledCommands={enabledCommands} onCommand={(command) => { app.keyboard.dispatch(command) }}>{children}</KeyboardCommandsView>
}

function Loading() {
  const palette = usePalette()
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: palette.canvas }}>
      <ActivityIndicator accessibilityLabel="Opening Solus" />
    </View>
  )
}
