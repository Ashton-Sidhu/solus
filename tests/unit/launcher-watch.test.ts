import { describe, expect, test } from 'bun:test'
import { watchLauncher } from '@solus/desktop-main/launcher-watch'

describe('launcher watch', () => {
  test('quits once the dev launcher is gone, not while it is alive', async () => {
    let parentPid = 4242
    let polls = 0
    let goneCalls = 0
    let confirmGone!: () => void
    const gone = new Promise<void>((resolve) => { confirmGone = resolve })

    const stop = watchLauncher({
      launcherPid: 4242,
      intervalMs: 2,
      readParentPid: () => {
        polls += 1
        // The launcher is killed after a few polls; launchd adopts the orphan.
        if (polls === 4) parentPid = 1
        return parentPid
      },
      onLauncherGone: () => {
        goneCalls += 1
        confirmGone()
      },
    })

    await gone
    expect(polls).toBe(4)
    expect(goneCalls).toBe(1)

    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(polls).toBe(4)
    expect(goneCalls).toBe(1)
    stop()
  })

  test('stopping the watch keeps a later launcher death from quitting', async () => {
    let parentPid = 4242
    let goneCalls = 0
    const stop = watchLauncher({
      launcherPid: 4242,
      intervalMs: 2,
      readParentPid: () => parentPid,
      onLauncherGone: () => { goneCalls += 1 },
    })

    stop()
    parentPid = 1
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(goneCalls).toBe(0)
  })
})
