import { describe, expect, test } from 'bun:test'
import { windowsListeners } from '@solus/server/browser/target-scanner'

// Windows has no lsof, so the browser pane finds dev servers from `netstat -ano`
// (docs/plans/windows.md §5.14).

const ENGLISH = [
  '',
  'Active Connections',
  '',
  '  Proto  Local Address          Foreign Address        State           PID',
  '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1432',
  '  TCP    127.0.0.1:5173         0.0.0.0:0              LISTENING       8812',
  '  TCP    127.0.0.1:5173         127.0.0.1:61234        ESTABLISHED     8812',
  '  TCP    192.168.1.20:61500     140.82.112.4:443       TIME_WAIT       0',
].join('\r\n')

const GERMAN_IPV6 = [
  'Aktive Verbindungen',
  '',
  '  Proto  Lokale Adresse         Remoteadresse          Status           PID',
  '  TCP    [::]:3000              [::]:0                 ABHÖREN          19568',
  '  TCP    [::1]:5173             [::1]:61235            HERGESTELLT      8812',
].join('\r\n')

describe('listening sockets on Windows', () => {
  test('a listener is read from its foreign address, so the translated state column does not matter', () => {
    // WHY: the state column is translated; a German Windows says ABHÖREN.
    expect(windowsListeners(GERMAN_IPV6)).toEqual([{ pid: 19568, port: 3000, command: '' }])
  })

  test('open connections and closing ones are not listeners', () => {
    expect(windowsListeners(ENGLISH)).toEqual([
      { pid: 1432, port: 135, command: '' },
      { pid: 8812, port: 5173, command: '' },
    ])
  })

  test('headers, blank lines, and UDP rows are skipped', () => {
    expect(windowsListeners('Active Connections\r\n\r\n  UDP    0.0.0.0:5353   *:*   2208')).toEqual([])
  })
})
