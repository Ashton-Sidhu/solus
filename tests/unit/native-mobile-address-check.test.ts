import { describe, expect, test } from 'bun:test'
import { readNativeAddress } from '../../apps/mobile/src/platform/read-native-address'

class FakeRequest extends EventTarget {
  status = 0
  responseText = ''
  url = ''
  aborted = false
  open(method: string, url: string): void { expect(method).toBe('GET'); this.url = url }
  send(): void {}
  abort(): void { this.aborted = true; this.dispatchEvent(new Event('error')) }
}

describe('native address checks', () => {
  test('retains the iOS error that React Native fetch hides', async () => {
    const request = new FakeRequest()
    const result = readNativeAddress('http://100.87.157.17:3001/health', new AbortController().signal, () => request)
    request.responseText = 'The resource could not be loaded because the App Transport Security policy requires the use of a secure connection.'
    request.dispatchEvent(new Event('error'))
    expect(await result).toEqual({ kind: 'no-answer', error: request.responseText })
    expect(request.url).toBe('http://100.87.157.17:3001/health')
  })

  test('retains an HTTP refusal instead of reporting a network failure', async () => {
    const request = new FakeRequest()
    const result = readNativeAddress('http://host/health', new AbortController().signal, () => request)
    request.status = 403
    request.dispatchEvent(new Event('load'))
    expect(await result).toEqual({ kind: 'status', status: 403 })
  })

  test('aborts the native request at the diagnostic deadline and ignores its late error', async () => {
    const request = new FakeRequest()
    const controller = new AbortController()
    const result = readNativeAddress('http://host/health', controller.signal, () => request)
    controller.abort()
    expect(await result).toEqual({ kind: 'timeout' })
    expect(request.aborted).toBe(true)
  })

  test('does not open a request after the check has already timed out', async () => {
    const controller = new AbortController()
    controller.abort()
    expect(await readNativeAddress('http://host/health', controller.signal, () => { throw new Error('Must not create a request') })).toEqual({ kind: 'timeout' })
  })
})
