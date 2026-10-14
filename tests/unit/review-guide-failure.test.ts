import { describe, expect, test } from 'bun:test'
import { describeGuideFailure } from '@solus/client-core/review-guide-failure'

// A guide failure leads with a sentence a person can act on. The raw error
// stays available as details, because it is what someone debugging needs.

const GONE = `Command failed: git -c credential.helper= fetch --filter=blob:none --force origin 38e602bd:refs/solus/review/base
fatal: remote error: upload-pack: not our ref 38e602bd`

describe('describeGuideFailure', () => {
  test('a revision gone from the remote asks for a refresh and keeps the git output', () => {
    const failure = describeGuideFailure(GONE)
    expect(failure.summary).toContain('Refresh the pull request')
    expect(failure.details).toBe(GONE)
  })

  test('an access refusal points at the connection', () => {
    const failure = describeGuideFailure('Command failed: git clone\nfatal: Authentication failed for https://github.com/a/b.git')
    expect(failure.summary).toContain('could not read this repository')
    expect(failure.details).toContain('Authentication failed')
  })

  test('another git failure hides the command behind details', () => {
    const raw = 'Command failed: git checkout -B x\nfatal: something else'
    expect(describeGuideFailure(raw)).toEqual({ summary: 'A git command failed while Solus prepared the changes.', details: raw })
  })

  test('a short message written for people is shown as it is, with no details', () => {
    expect(describeGuideFailure('No agent is available.')).toEqual({ summary: 'No agent is available.', details: null })
  })

  test('a long or multi-line message gets a plain summary', () => {
    const raw = 'TypeError: x is undefined\n    at f (a.ts:1:1)'
    expect(describeGuideFailure(raw)).toEqual({ summary: 'The guide could not be written.', details: raw })
  })
})
