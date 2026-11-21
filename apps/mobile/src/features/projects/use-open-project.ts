import { useCallback, useEffect, useRef, useState } from 'react'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import { useApp } from '../../app/app-context'
import type { RootStackParamList } from '../../navigation/routes'
import { useHostApi } from '../hosts/use-host-api'

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
  const app = useApp()
  const api = useHostApi(hostId)
  const [folder, setFolder] = useState<{ hostId: string; path: string } | null>(null)
  useEffect(() => {
    const facts = api ? app.connections.connection(hostId)?.facts : null
    if (!facts) return
    let live = true
    // The folder may have moved since the host's record was read.
    void facts.refresh('capabilities').then(() => facts.when('capabilities')).then(
      (capabilities) => { if (live) setFolder({ hostId, path: capabilities.projectsBaseDirectory ?? '~' }) },
      () => { if (live) setFolder({ hostId, path: '~' }) },
    )
    return () => { live = false }
  }, [api, app, hostId])
  return folder?.hostId === hostId ? folder.path : null
}

/**
 * Shows a project the host now has: the project list refreshes and the new
 * task flow takes the project, replacing the Add project screens.
 */
export function useShowProject(hostId: string, navigation: NativeStackNavigationProp<RootStackParamList>) {
  const app = useApp()
  const mounted = useMounted()
  return useCallback((projectPath: string) => {
    void app.threads.load(hostId)
    if (!mounted.current) return
    navigation.popTo('NewTask', { hostId, projectPath })
  }, [app, hostId, mounted, navigation])
}

export function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
