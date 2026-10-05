import { useEffect, useState } from 'react'
import { Alert } from 'react-native'
import type { HostUpdateStatus } from '@solus/contracts/host-update-types'
import { useApp, useListened } from '../../app/app-context'
import type { ScreenProps } from '../../navigation/routes'
import { NavigationRow, GroupedScroll, GroupedSection, ValueRow } from '../../ui/grouped-rows'
import { updateStatusText } from './lib/update-status'

/** This build, each host's Solus version, and the notices the app carries. */
export function AboutScreen(_props: ScreenProps<'About'>) {
  const app = useApp()
  const hosts = useListened(app.registry.changes, app.registry.hosts)

  return (
    <GroupedScroll>
      <GroupedSection title="App">
        <ValueRow label="Version" value={app.platform.appVersion ?? 'Unknown'} />
      </GroupedSection>
      {hosts.length > 0 ? (
        <GroupedSection title="Hosts" footer="Update a host where Solus runs on it. A cloud host is updated for you.">
          {hosts.map((host, index) => <HostVersionRow key={host.id} hostId={host.id} label={host.label} isFirst={index === 0} />)}
        </GroupedSection>
      ) : null}
      <GroupedSection title="Acknowledgements">
        <NavigationRow icon="notices" label="Open source notices" onPress={() => Alert.alert('T3 Code', T3_CODE_NOTICE)} />
      </GroupedSection>
    </GroupedScroll>
  )
}

/** One host's version and what its last update check found. */
function HostVersionRow({ hostId, label, isFirst }: { hostId: string; label: string; isFirst: boolean }) {
  const app = useApp()
  const phase = useListened(app.connections.changes, () => app.connections.state(hostId)?.phase)
  const [status, setStatus] = useState<HostUpdateStatus | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const connection = app.connections.connection(hostId)
    if (phase !== 'connected' || !connection) return
    let active = true
    connection.api.hostUpdateStatus().then(
      (next) => { if (active) { setStatus(next); setFailed(false) } },
      () => { if (active) setFailed(true) },
    )
    const stop = connection.events.subscribe('host.updateStatusChanged', (next) => { if (active) setStatus(next) })
    return () => { active = false; stop() }
  }, [app, hostId, phase])

  const value = status?.currentVersion ?? (phase === 'connected' ? (failed ? 'Unknown' : 'Checking…') : 'Not connected')
  return <ValueRow isFirst={isFirst} label={label} value={value} detail={status ? updateStatusText(status) : undefined} />
}

/** The notice the T3 Code license requires with the adapted pieces (UPSTREAM.md). */
const T3_CODE_NOTICE = `Parts of this app adapt T3 Code's mobile app.

MIT License

Copyright (c) 2026 T3 Tools Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`
