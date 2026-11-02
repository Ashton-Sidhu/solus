import { describe, expect, test } from 'bun:test'
import { browserUrlForLog } from '@solus/server/browser/surface-driver'

describe('a browser page address in a log', () => {
  // WHY: an OAuth redirect carries its `code` and `state` in the query or the
  // fragment. Anyone who can read dev.log could replay them.
  test('drops the query and the fragment', () => {
    expect(browserUrlForLog('https://app.example.com/callback?code=secret&state=xyz#access_token=t'))
      .toBe('https://app.example.com/callback')
  })

  test('writes only the header of a data: URL', () => {
    expect(browserUrlForLog('data:text/html;base64,PGh0bWw+')).toBe('data:text/html;base64,…')
  })
})
