import { describe, expect, test } from 'bun:test'
import { pastedVariables } from '@solus/workspace-ui/components/settings/lib/env-text'

describe('variables pasted into the environment variables editor', () => {
  test('reads the lines of a .env file, with export, quotes, comments, and blank lines', () => {
    const text = [
      '# OpenSearch',
      'export OPENSEARCH_URL=https://search.example.com:9200',
      '',
      'OPENSEARCH_USERNAME = admin # the admin user',
      'OPENSEARCH_PASSWORD="p#ss \\"word\\""',
      "REGION='eu west'",
      'EMPTY=',
    ].join('\r\n')
    expect(pastedVariables(text)).toEqual([
      { name: 'OPENSEARCH_URL', value: 'https://search.example.com:9200' },
      { name: 'OPENSEARCH_USERNAME', value: 'admin' },
      // WHY: a # inside quotes is part of the password, not a comment.
      { name: 'OPENSEARCH_PASSWORD', value: 'p#ss "word"' },
      { name: 'REGION', value: 'eu west' },
      { name: 'EMPTY', value: '' },
    ])
  })

  test('reads names separated by commas, as the old field took them', () => {
    expect(pastedVariables('OPENSEARCH_URL, OPENSEARCH_USERNAME OPENSEARCH_PASSWORD')).toEqual([
      { name: 'OPENSEARCH_URL', value: '' },
      { name: 'OPENSEARCH_USERNAME', value: '' },
      { name: 'OPENSEARCH_PASSWORD', value: '' },
    ])
  })

  test('leaves one name, and text that is not variables, to the field as pasted', () => {
    // WHY: pasting one name, or a value pasted into the wrong field, must not turn into rows.
    expect(pastedVariables('API_KEY')).toBeNull()
    expect(pastedVariables('sk-live-abc123')).toBeNull()
    expect(pastedVariables('API_KEY=1\nnot a line')).toBeNull()
  })
})
