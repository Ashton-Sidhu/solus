import { describe, expect, test } from 'bun:test'
import { fieldLabel, modelResultTree } from '@solus/client-core/model-result'

describe('modelResultTree', () => {
  test('a finding reads as a titled record: short values beside their labels, prose below', () => {
    const tree = modelResultTree({
      summary: 'The clearest measured opportunities are repeated dependency installs and long platform build steps.',
      findings: [{ title: 'Windows install dominates packaging', priority: 'high', evidence: 'Install dependencies took 3m25s in run 43373338009, and the post-job cache save took 35s.' }],
    })

    expect(tree).toEqual({
      kind: 'record',
      title: null,
      facts: [],
      fields: [
        { label: 'Summary', node: { kind: 'text', text: 'The clearest measured opportunities are repeated dependency installs and long platform build steps.' } },
        {
          label: 'Findings',
          node: {
            kind: 'items',
            items: [{
              kind: 'record',
              title: 'Windows install dominates packaging',
              facts: [{ label: 'Priority', text: 'high' }],
              fields: [{ label: 'Evidence', node: { kind: 'text', text: 'Install dependencies took 3m25s in run 43373338009, and the post-job cache save took 35s.' } }],
            }],
          },
        },
      ],
    })
  })

  test('a list of short values is a row of tags, and an id keeps its digits', () => {
    expect(modelResultTree(['build', 43373338009, true])).toEqual({ kind: 'tags', items: ['build', '43373338009', 'Yes'] })
  })

  test('a plain text result stays prose', () => {
    expect(modelResultTree('Line one\nLine two')).toEqual({ kind: 'text', text: 'Line one\nLine two' })
  })

  test('data nested past the layout depth falls back to JSON', () => {
    expect(modelResultTree({ a: { b: { c: { d: { e: 1 } } } } })).toMatchObject({
      fields: [{ node: { fields: [{ node: { fields: [{ node: { fields: [{ node: { kind: 'json' } }] } }] } }] } }],
    })
  })
})

describe('fieldLabel', () => {
  test('a key reads as words, and an acronym stays', () => {
    expect(fieldLabel('expectedImpact')).toBe('Expected impact')
    expect(fieldLabel('job_ids')).toBe('Job ids')
    expect(fieldLabel('runID')).toBe('Run ID')
  })
})
