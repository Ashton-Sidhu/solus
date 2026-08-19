import { describe, expect, test } from 'bun:test'
import {
  removeChecksClientActivity,
  type ClientChecksActivity,
} from '@solus/server/server/handlers/checks-handlers'

describe('PR checks activity ownership', () => {
  test('disconnecting the final active client releases its polling repository', () => {
    const activities = new Map<string, ClientChecksActivity>([
      ['client-a', { repoKey: 'host/owner/repo', reviewSurfaceOpen: true, active: true }],
    ])

    expect(removeChecksClientActivity(activities, 'client-a', 'host/owner/repo')).toEqual({
      removed: true,
      activeRepoKey: null,
    })
    expect(activities.size).toBe(0)
  })

  test('keeps polling for another active client and ignores unknown disconnects', () => {
    const activities = new Map<string, ClientChecksActivity>([
      ['client-a', { repoKey: 'host/owner/old', reviewSurfaceOpen: true, active: true }],
      ['client-b', { repoKey: 'host/owner/current', reviewSurfaceOpen: false, active: true }],
    ])

    expect(removeChecksClientActivity(activities, 'missing', 'host/owner/current')).toEqual({
      removed: false,
      activeRepoKey: 'host/owner/current',
    })
    expect(removeChecksClientActivity(activities, 'client-b', 'host/owner/current')).toEqual({
      removed: true,
      activeRepoKey: 'host/owner/old',
    })
  })
})
