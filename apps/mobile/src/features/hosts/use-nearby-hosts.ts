import { useCallback, useEffect, useState } from 'react'
import type { DiscoveredServer } from '@solus/contracts/types'

import { useApp } from '../../app/app-context'

export interface NearbyHosts {
  /** False on a build without the native scanner: the section is then absent. */
  canScan: boolean
  hosts: DiscoveredServer[]
  isScanning: boolean
  /** True after the first scan answered, so "none found" is never shown before it. */
  hasScanned: boolean
  scan(): void
}

/** Unpaired hosts on this device's local network, scanned when the screen opens and on request. */
export function useNearbyHosts(): NearbyHosts {
  const app = useApp()
  const [hosts, setHosts] = useState<DiscoveredServer[]>([])
  const [isScanning, setIsScanning] = useState(false)
  const [hasScanned, setHasScanned] = useState(false)

  const scan = useCallback(() => {
    if (!app.canScanNearby) return
    setIsScanning(true)
    app.scanNearby()
      .then(setHosts, () => setHosts([]))
      .finally(() => {
        setIsScanning(false)
        setHasScanned(true)
      })
  }, [app])

  useEffect(() => { scan() }, [scan])

  return { canScan: app.canScanNearby, hosts, isScanning, hasScanned, scan }
}

/** The address a nearby host is paired at. */
export function nearbyHostUrl(server: Pick<DiscoveredServer, 'host' | 'port'>): string {
  return `http://${server.host}:${server.port}`
}
