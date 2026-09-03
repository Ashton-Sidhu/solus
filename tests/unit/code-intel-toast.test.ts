import { describe, expect, test } from 'bun:test'
import type { CodeIntelLanguageStatus, CodeIntelStatus } from '@solus/contracts/code-intel'
import { CodeIntelIndexToastTracker } from '@solus/workspace-ui/components/code-intel/lib/index-toasts'

function language(
  state: CodeIntelLanguageStatus['state'],
  error: string | null = null,
): CodeIntelLanguageStatus {
  return {
    language: 'typescript',
    label: 'TypeScript',
    detected: true,
    toolName: 'scip-typescript',
    toolInstalled: true,
    installCommand: 'npm install -g @sourcegraph/scip-typescript',
    state,
    indexedAt: null,
    documentCount: 0,
    error,
  }
}

function status(state: CodeIntelLanguageStatus['state'], error: string | null = null): CodeIntelStatus {
  return { root: '/project', languages: [language(state, error)] }
}

describe('CodeIntelIndexToastTracker', () => {
  test('turns one indexing toast into the ready result', () => {
    const starts: string[] = []
    const successes: string[] = []
    const tracker = new CodeIntelIndexToastTracker((message) => {
      starts.push(message)
      return {
        update() {},
        success(message) { successes.push(message) },
        error() {},
        info() {},
        dismiss() {},
      }
    })

    tracker.update('host-a', status('indexing'))
    tracker.update('host-a', status('indexing'))
    tracker.update('host-a', status('ready'))

    // WHY: repeated status snapshots must not stack duplicate progress toasts.
    expect(starts).toEqual(['Indexing TypeScript symbols…'])
    expect(successes).toEqual(['TypeScript symbols are ready'])
  })

  test('turns a failed index run into an error toast', () => {
    const errors: { message: string; description: string | undefined }[] = []
    const tracker = new CodeIntelIndexToastTracker(() => ({
      update() {},
      success() {},
      error(message, options) { errors.push({ message, description: options?.description }) },
      info() {},
      dismiss() {},
    }))

    tracker.update('host-a', status('indexing'))
    tracker.update('host-a', status('error', 'Indexer exited with code 1'))

    expect(errors).toEqual([{
      message: 'Couldn’t index TypeScript symbols',
      description: 'Indexer exited with code 1',
    }])
  })
})
