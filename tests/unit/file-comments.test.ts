import { describe, expect, test } from 'bun:test'
import {
  fileContentVersion,
  isolateFileCommentEvents,
  rangeFromRemappedAnchor,
  selectedTextForFileRange,
} from '@solus/workspace-ui/components/artifact/lib/file-comments'

describe('file editor comments', () => {
  test('captures the current inclusive line range for agent context', () => {
    const contents = ['zero', 'one', 'two', 'three'].join('\n')

    expect(selectedTextForFileRange(contents, {
      startLine: 2,
      endLine: 3,
    })).toBe('one\ntwo')
  })

  test('clamps a stale range to the available document', () => {
    expect(selectedTextForFileRange('one\ntwo', {
      startLine: 0,
      endLine: 20,
    })).toBe('one\ntwo')
  })

  test('preserves a range span when Pierre remaps its end-line anchor', () => {
    expect(rangeFromRemappedAnchor(12, 3)).toEqual({
      startLine: 9,
      endLine: 12,
    })
  })

  test('never produces non-positive remapped lines', () => {
    expect(rangeFromRemappedAnchor(0, 4)).toEqual({
      startLine: 1,
      endLine: 1,
    })
  })

  test('changes the editor cache version when file contents change', () => {
    expect(fileContentVersion('one')).not.toBe(fileContentVersion('two'))
  })

  test('keeps comment input events out of the surrounding code editor', () => {
    const listeners = new Map<string, EventListener>()
    const element = {
      addEventListener: (name: string, listener: EventListener) => {
        listeners.set(name, listener)
      },
      removeEventListener: (name: string) => {
        listeners.delete(name)
      },
    } as unknown as HTMLElement
    const cleanup = isolateFileCommentEvents(element)
    let stopped = false

    listeners.get('beforeinput')?.({
      stopPropagation: () => {
        stopped = true
      },
    } as Event)

    expect(stopped).toBe(true)
    expect(listeners.has('keydown')).toBe(true)
    cleanup()
    expect(listeners.size).toBe(0)
  })
})
