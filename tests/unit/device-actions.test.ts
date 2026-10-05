import { describe, expect, test } from 'bun:test'
import {
  deviceActionSchema,
  deviceSupportsAction,
  type DeviceAction,
  type DevicePlatform,
} from '@solus/contracts/device-types'
import { parseAxStatus, readDeviceDetail, runDeviceAction, textSizeFromAndroid, textSizeFromIos } from '@solus/server/devices/device-actions'
import { DeviceDomainError } from '@solus/server/devices/device-errors'
import type { DeviceCommandOptions, DeviceCommandRunner } from '@solus/server/devices/device-process'

/**
 * Device Tools actions (P10–P13). Every supported action runs one typed
 * command; unsupported ones fail before any process starts; nothing goes
 * through a shell or the hub's exec channel.
 */

function recorder(results: (command: string, args: readonly string[]) => { code: number; stdout?: string; stderr?: string } = () => ({ code: 0 })) {
  const calls: { command: string; args: string[]; options?: DeviceCommandOptions }[] = []
  const run: DeviceCommandRunner = async (command, args, options) => {
    calls.push({ command, args: [...args], ...(options ? { options } : {}) })
    const result = results(command, args)
    return { code: result.code, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
  }
  return { calls, ready: { run, nodePath: '/node', helpers: { serveSimAxSettings: '/ax', serveSimCli: '/serve-sim.js' } } }
}

async function code(promise: Promise<unknown>) {
  try {
    await promise
    return null
  } catch (error) {
    return error instanceof DeviceDomainError ? error.code : String(error)
  }
}

const parse = (action: unknown) => deviceActionSchema.parse(action)

describe('device actions', () => {
  const cases: [DevicePlatform, DeviceAction, string, string[]][] = [
    ['ios', parse({ type: 'setAppearance', value: 'dark' }), 'xcrun', ['simctl', 'ui', 'SIM', 'appearance', 'dark']],
    ['ios', parse({ type: 'setTextSize', value: 'extra-large' }), 'xcrun', ['simctl', 'ui', 'SIM', 'content_size', 'accessibility-large']],
    ['ios', parse({ type: 'setToggle', setting: 'increaseContrast', value: true }), 'xcrun', ['simctl', 'ui', 'SIM', 'increase_contrast', 'enabled']],
    ['ios', parse({ type: 'setToggle', setting: 'voiceOver', value: false }), 'xcrun', ['simctl', 'spawn', 'SIM', '/ax', 'set', 'voiceover', 'off']],
    ['ios', parse({ type: 'setColorFilter', value: 'grayscale' }), 'xcrun', ['simctl', 'spawn', 'SIM', '/ax', 'set', 'color-filter', 'grayscale']],
    ['ios', parse({ type: 'setLiquidGlass', value: 'tinted' }), 'xcrun', ['simctl', 'spawn', 'SIM', '/ax', 'set', 'liquid-glass', 'tinted']],
    ['ios', parse({ type: 'setLocation', latitude: 51.5, longitude: -0.12 }), 'xcrun', ['simctl', 'location', 'SIM', 'set', '51.5,-0.12']],
    ['ios', parse({ type: 'setPermission', appId: 'com.example.app', permission: 'camera', decision: 'grant' }), 'xcrun', ['simctl', 'privacy', 'SIM', 'grant', 'camera', 'com.example.app']],
    ['ios', parse({ type: 'setPermission', appId: 'com.example.app', permission: 'notifications', decision: 'revoke' }), '/node', ['/serve-sim.js', 'permissions', 'revoke', 'notifications', 'com.example.app', '-d', 'SIM']],
    ['ios', parse({ type: 'openUrl', url: 'myapp://settings' }), 'xcrun', ['simctl', 'openurl', 'SIM', 'myapp://settings']],
    ['ios', parse({ type: 'launchApp', appId: 'com.example.app' }), 'xcrun', ['simctl', 'launch', 'SIM', 'com.example.app']],
    ['android', parse({ type: 'setAppearance', value: 'dark' }), 'adb', ['-s', 'SIM', 'shell', 'cmd', 'uimode', 'night', 'yes']],
    ['android', parse({ type: 'setTextSize', value: 'small' }), 'adb', ['-s', 'SIM', 'shell', 'settings', 'put', 'system', 'font_scale', '0.85']],
    ['android', parse({ type: 'setLocation', latitude: 51.5, longitude: -0.12 }), 'adb', ['-s', 'SIM', 'emu', 'geo', 'fix', '-0.12', '51.5']],
    ['android', parse({ type: 'terminateApp', appId: 'com.example.app' }), 'adb', ['-s', 'SIM', 'shell', 'am', 'force-stop', 'com.example.app']],
  ]

  for (const [platform, action, command, args] of cases) {
    test(`${platform} ${action.type} runs one exact command`, async () => {
      const { calls, ready } = recorder()
      await runDeviceAction(ready, platform, 'SIM', action)
      expect(calls[0]).toMatchObject({ command, args })
    })
  }

  test('Android orientation tilts an emulator and locks a physical device', async () => {
    const emulator = recorder()
    await runDeviceAction(emulator.ready, 'android', 'emulator-5554', parse({ type: 'setOrientation', value: 'landscape_left' }))
    expect(emulator.calls.at(-1)!.args).toEqual(['-s', 'emulator-5554', 'emu', 'sensor', 'set', 'acceleration', '9.81:0:0'])
    const phone = recorder()
    await runDeviceAction(phone.ready, 'android', 'R5CT', parse({ type: 'setOrientation', value: 'landscape_left' }))
    expect(phone.calls.at(-1)!.args).toEqual(['-s', 'R5CT', 'shell', 'cmd', 'window', 'user-rotation', 'lock', '1'])
  })

  test('unsupported actions fail before a process starts', async () => {
    // WHY: an unsupported control must not look like a successful no-op.
    const unsupported: [DevicePlatform, DeviceAction][] = [
      ['ios', parse({ type: 'setOrientation', value: 'portrait' })],
      ['ios', parse({ type: 'setToggle', setting: 'networkEnabled', value: false })],
      ['android', parse({ type: 'setColorFilter', value: 'none' })],
      ['android', parse({ type: 'clearLocation' })],
      ['android', parse({ type: 'sendPush', appId: 'com.example.app', payload: { kind: 'text', body: 'Hi' } })],
      ['android', parse({ type: 'setPermission', appId: 'com.example.app', permission: 'faceid', decision: 'grant' })],
      ['android', parse({ type: 'setPermission', appId: 'com.example.app', permission: 'camera', decision: 'reset' })],
    ]
    for (const [platform, action] of unsupported) {
      const { calls, ready } = recorder()
      expect(deviceSupportsAction(platform, action)).toBe(false)
      expect(await code(runDeviceAction(ready, platform, 'SIM', action))).toBe('action_unsupported')
      expect(calls).toHaveLength(0)
    }
  })

  test('a missing helper is reported, not a silent success', async () => {
    const { ready } = recorder()
    const without = { ...ready, helpers: { serveSimAxSettings: null, serveSimCli: null } }
    expect(await code(runDeviceAction(without, 'ios', 'SIM', parse({ type: 'setToggle', setting: 'reduceMotion', value: true })))).toBe('helper_missing')
  })

  test('push payloads travel on stdin and invalid JSON is refused', async () => {
    const { calls, ready } = recorder()
    await runDeviceAction(ready, 'ios', 'SIM', parse({ type: 'sendPush', appId: 'com.example.app', payload: { kind: 'text', body: 'Hello $(rm -rf ~)' } }))
    expect(calls[0]!.args).toEqual(['simctl', 'push', 'SIM', 'com.example.app', '-'])
    expect(JSON.parse(calls[0]!.options!.stdin!)).toEqual({ aps: { alert: 'Hello $(rm -rf ~)' } })
    expect(await code(runDeviceAction(ready, 'ios', 'SIM', parse({ type: 'sendPush', appId: 'com.example.app', payload: { kind: 'json', json: '{oops' } })))).toBe('invalid_request')
    expect(await code(runDeviceAction(ready, 'ios', 'SIM', parse({ type: 'sendPush', appId: 'com.example.app', payload: { kind: 'json', json: '[1,2]' } })))).toBe('invalid_request')
  })

  test('injection strings are refused at the boundary', () => {
    expect(deviceActionSchema.safeParse({ type: 'launchApp', appId: 'com.app; rm -rf /' }).success).toBe(false)
    expect(deviceActionSchema.safeParse({ type: 'openUrl', url: '--help' }).success).toBe(false)
    expect(deviceActionSchema.safeParse({ type: 'setLocation', latitude: 91, longitude: 0 }).success).toBe(false)
  })

  test('Android permission groups report partial failure', async () => {
    const { ready } = recorder((_command, args) => ({ code: args.includes('android.permission.WRITE_CONTACTS') ? 1 : 0 }))
    const error = await runDeviceAction(ready, 'android', 'emulator-5554', parse({ type: 'setPermission', appId: 'com.example.app', permission: 'contacts', decision: 'grant' })).catch((caught: unknown) => caught)
    expect((error as DeviceDomainError).code).toBe('command_failed')
    expect((error as DeviceDomainError).detail).toContain('1 of 2')
  })
})

describe('device detail', () => {
  test('iOS settings are read back; unread values stay unknown, not false', async () => {
    const { ready } = recorder((command, args) => {
      if (args.includes('appearance')) return { code: 0, stdout: 'Dark\n' }
      if (args.includes('content_size')) return { code: 0, stdout: 'extra-extra-large' }
      if (args.includes('increase_contrast')) return { code: 1 }
      if (args.includes('status')) return { code: 0, stdout: JSON.stringify({ 'reduce-motion': 'on', 'color-filter': 'grayscale' }) }
      if (args.includes('launchctl')) return { code: 0, stdout: '123\t0\tUIKitApplication:com.example.app[1a2b][rb-legacy]\n-\t0\tUIKitApplication:com.example.other[3]' }
      return { code: command === 'xcrun' ? 0 : 1 }
    })
    const detail = await readDeviceDetail(ready, 'ios', 'SIM')
    expect(detail.settings).toEqual({ appearance: 'dark', textSize: 'large', reduceMotion: true, colorFilter: 'grayscale' })
    expect('increaseContrast' in detail.settings).toBe(false)
    expect(detail.foregroundApp).toEqual({ appId: 'com.example.app' })
  })

  test('Android settings and foreground app are read back', async () => {
    const { ready } = recorder((_command, args) => {
      if (args.includes('night')) return { code: 0, stdout: 'Night mode: yes' }
      if (args.includes('font_scale')) return { code: 0, stdout: '1.3' }
      if (args.includes('animator_duration_scale')) return { code: 0, stdout: '0' }
      if (args.includes('wifi_on')) return { code: 0, stdout: '1' }
      if (args.includes('dumpsys')) return { code: 0, stdout: '  mCurrentFocus=Window{abc u0 com.example.app/com.example.Main}' }
      return { code: 1 }
    })
    const detail = await readDeviceDetail(ready, 'android', 'emulator-5554')
    expect(detail.settings).toEqual({ appearance: 'dark', textSize: 'extra-large', reduceMotion: true, networkEnabled: true })
    expect(detail.foregroundApp).toEqual({ appId: 'com.example.app' })
  })

  test('text sizes map to the four shared levels', () => {
    expect(textSizeFromIos('large')).toBe('default')
    expect(textSizeFromIos('accessibility-extra-large')).toBe('extra-large')
    expect(textSizeFromAndroid(1.15)).toBe('large')
    expect(parseAxStatus('{"reduce-motion":"maybe"}')?.['reduce-motion']).toBeUndefined()
  })
})
