import { useEffect, useState, type ReactNode } from 'react'
import { ActivityIndicator, Dimensions, View } from 'react-native'
import { StatusBar } from 'expo-status-bar'
import { useFonts } from 'expo-font'
import { JetBrainsMono_400Regular } from '@expo-google-fonts/jetbrains-mono/400Regular'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import type { InitialState } from '@react-navigation/native'
import { AppProvider, useListened } from './app/app-context'
import { initialRoutes } from './app/initial-route'
import { SolusApp } from './app/solus-app'
import { deriveLayout } from './features/layout/lib/layout'
import { KeyboardCommandsView } from './features/keyboard/KeyboardCommandsView'
import { RootNavigator } from './navigation/RootNavigator'
import { expoPlatform, watchAppLifecycle } from './platform/expo'
import { ThemeProvider, usePalette } from './theme/theme'

const app = new SolusApp(expoPlatform)

export default function App() {
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
        compact: deriveLayout(Dimensions.get('window')).variant === 'compact',
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
    <SafeAreaProvider>
      <ThemeProvider>
        <AppProvider app={app}>
          <StatusBar style="auto" />
          {ready && initialState ? <KeyboardRoot><RootNavigator initialState={initialState} /></KeyboardRoot> : <Loading />}
        </AppProvider>
      </ThemeProvider>
    </SafeAreaProvider>
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
