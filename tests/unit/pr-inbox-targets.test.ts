import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const source = readFileSync(
  join(import.meta.dir, '../../src/renderer/components/prs/PrsPage.svelte'),
  'utf8',
)

describe('All projects fan-out', () => {
  test('fetches only from hosts that are connected', () => {
    // WHY: a saved host that has never dialed keeps its request queued in the
    // transport with nothing to age it out. Inside the inbox's bounded worker
    // pool one of those holds a slot forever, so the projects behind it are
    // never fetched and the page waits on a machine that is not there — while
    // the project you can actually read has rows ready to show.
    expect(source).toMatch(
      /\.filter\(\(option\) => serversStore\.statusFor\(option\.serverId\) === "online"\)/,
    )
  })

  test('reloads as hosts connect instead of only at page open', () => {
    // WHY: narrowing the fan-out to connected hosts would otherwise strand a
    // page opened during boot on whatever was up in its first frame.
    expect(source).toContain('const reachableInboxKey = $derived(')
    expect(source).toMatch(
      /if \(!open \|\| !isAllProjects \|\| reachableInboxKey === ""\) return;/,
    )
  })

  test('holds the skeleton while a host is still dialing', () => {
    // WHY: "no pull requests" is a claim about the projects it could read. A
    // host mid-handshake has not answered yet, so saying the inbox is empty
    // would be a lie the page corrects a second later.
    expect(source).toMatch(
      /\(inbox\.loading \|\| inboxHostsConnecting\) && activeItems\.length === 0/,
    )
  })
})
