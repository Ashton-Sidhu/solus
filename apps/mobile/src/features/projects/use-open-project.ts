import { useCallback, useEffect, useRef, useState } from 'react'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import { useApp, useListened } from '../../app/app-context'
import type { RootStackParamList } from '../../navigation/routes'

/** The host's API while it is connected; null otherwise, so a screen shows the host banner. */
export function useHostApi(hostId: string) {
  const app = useApp()
  const phase = useListened(app.connections.changes, () => app.connections.state(hostId)?.phase)
  return phase === 'connected' ? app.connections.connection(hostId)?.api ?? null : null
}

/** False once the screen is gone: a late reply must not navigate or set state. */
export function useMounted() {
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  return mounted
}

/** The folder this host puts new projects and clones in, `~` when the host does not say. Null until known. */
export function useProjectsFolder(hostId: string): string | null {
  const api = useHostApi(hostId)
  const [path, setPath] = useState<string | null>(null)
  useEffect(() => {
    if (!api) return
    let live = true
    api.getServerCapabilities().then(
      (capabilities) => { if (live) setPath(capabilities.projectsBaseDirectory ?? '~') },
      () => { if (live) setPath('~') },
    )
    return () => { live = false }
  }, [api])
  return path
}

/**
 * Shows a project the host now has: the projects list refreshes and the
 * workspace replaces the Open project screens, so Back returns to Projects.
 */
export function useShowProject(hostId: string, navigation: NativeStackNavigationProp<RootStackParamList>) {
  const app = useApp()
  const mounted = useMounted()
  return useCallback((projectPath: string) => {
    void app.sessions.loadProjects(hostId)
    if (!mounted.current) return
    navigation.popTo('Projects', { hostId })
    navigation.navigate('Workspace', { hostId, projectPath })
  }, [app, hostId, mounted, navigation])
}

export function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
