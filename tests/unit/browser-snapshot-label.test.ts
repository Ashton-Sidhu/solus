import { describe, expect, test } from 'bun:test'
import { browserSnapshotLabel } from '@solus/client-core/browser-snapshot-label'

describe('browser snapshot card label', () => {
  test('keeps a title the page gave itself', () => {
    expect(browserSnapshotLabel({ title: 'Settings — Solus', url: 'http://localhost:5173/settings' })).toBe('Settings — Solus')
  })

  test('names the file when Chromium used the address as the title', () => {
    const url = 'http://[::1]:5173/@fs/Users/me/solus/mockups/empty%20state.html'
    expect(browserSnapshotLabel({ title: '[::1]:5173/@fs/Users/me/solus/mockups/empty%20state.html', url })).toBe('empty state.html')
    expect(browserSnapshotLabel({ title: url, url })).toBe('empty state.html')
  })

  test('names the file when the page has no title', () => {
    expect(browserSnapshotLabel({ title: '', url: 'http://localhost:5173/assets/6b9c3cb5.png' })).toBe('6b9c3cb5.png')
  })

  test('falls back to a plain name when the path has no last part', () => {
    expect(browserSnapshotLabel({ title: 'localhost:5173', url: 'http://localhost:5173/' })).toBe('Browser screenshot')
    expect(browserSnapshotLabel({ title: '', url: '' })).toBe('Browser screenshot')
  })
})
