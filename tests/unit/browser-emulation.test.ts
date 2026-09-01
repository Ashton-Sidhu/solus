import { describe, expect, test } from 'bun:test'
import {
  emulationChanges,
  emulationRecord,
  type BrowserEmulation,
} from '@solus/server/browser/surface-driver'
import { presetById, resolveViewport, viewportFor } from '@solus/contracts/browser-types'

/**
 * How much of the guest a host re-emulates on each request.
 *
 * A dragged stage edge asks for a size on every pointer frame, and every one of
 * these commands makes the guest relayout. What is sent is therefore a
 * performance contract, not an implementation detail.
 */

const HOST_AGENT = 'Mozilla/5.0 (Macintosh) Chrome/120'

function preset(id: string): BrowserEmulation {
  const found = presetById(id)
  if (!found) throw new Error(`missing preset ${id}`)
  const emulation: BrowserEmulation = {
    viewport: viewportFor(found, 'portrait'),
    appearance: 'system',
  }
  if (found.userAgent) emulation.userAgent = found.userAgent
  return emulation
}

function sized(width: number, height: number): BrowserEmulation {
  return {
    viewport: resolveViewport({ mode: 'custom', width, height }),
    appearance: 'system',
  }
}

describe('browser emulation', () => {
  test('a guest with no emulation yet is sent all of it', () => {
    const changes = emulationChanges(null, emulationRecord(preset('iphone-15'), HOST_AGENT))

    expect(changes).toEqual({ metrics: true, touch: true, userAgent: true, appearance: true })
  })

  test('a resize sends the metrics and nothing else', () => {
    // WHY: this is the drag. Re-asserting an unchanged user agent, touch mode,
    // and colour scheme on every frame is three quarters of the work of a
    // resize spent confirming things nobody moved.
    const applied = emulationRecord(sized(900, 600), HOST_AGENT)
    const changes = emulationChanges(applied, emulationRecord(sized(901, 600), HOST_AGENT))

    expect(changes).toEqual({ metrics: true, touch: false, userAgent: false, appearance: false })
  })

  test('the same size again sends nothing at all', () => {
    // WHY: a drag settles on a size for several frames, and a pane resize under
    // a filling page repeats the size it landed on.
    const applied = emulationRecord(sized(900, 600), HOST_AGENT)
    const changes = emulationChanges(applied, emulationRecord(sized(900, 600), HOST_AGENT))

    expect(Object.values(changes).some(Boolean)).toBe(false)
  })

  test('switching to a phone still sends everything that differs', () => {
    // WHY: the saving must not become a stale guest. A preset change moves the
    // agent, the touch mode, and the pixel ratio together, and dropping any one
    // of them would leave the page claiming a device it is not emulating.
    const applied = emulationRecord(sized(900, 600), HOST_AGENT)
    const changes = emulationChanges(applied, emulationRecord(preset('iphone-15'), HOST_AGENT))

    expect(changes).toEqual({ metrics: true, touch: true, userAgent: true, appearance: false })
  })

  test('a viewport that names no device falls back to the host agent, and says so', () => {
    // WHY: the fallback has to be resolved before the comparison, or leaving a
    // preset for a custom size would compare a string against `undefined` and
    // re-send an agent that never changed.
    const record = emulationRecord(sized(900, 600), HOST_AGENT)

    expect(record.userAgent).toBe(HOST_AGENT)
    expect(emulationChanges(record, emulationRecord(sized(900, 601), HOST_AGENT)).userAgent).toBe(false)
  })

  test('the colour scheme is its own change', () => {
    const applied = emulationRecord(sized(900, 600), HOST_AGENT)
    const changes = emulationChanges(applied, {
      ...emulationRecord(sized(900, 600), HOST_AGENT),
      appearance: 'dark',
    })

    expect(changes).toEqual({ metrics: false, touch: false, userAgent: false, appearance: true })
  })

  test('two presets of the same size are still different devices', () => {
    // WHY: metrics are compared as one value, so the pixel ratio has to be part
    // of it — two 1920-wide viewports at 1x and 2x are not the same guest.
    const oneToOne = emulationRecord(sized(1920, 1080), HOST_AGENT)
    const retina = emulationRecord({
      viewport: { ...resolveViewport({ mode: 'custom', width: 1920, height: 1080 }), deviceScaleFactor: 2 },
      appearance: 'system',
    }, HOST_AGENT)

    expect(emulationChanges(oneToOne, retina).metrics).toBe(true)
  })
})
