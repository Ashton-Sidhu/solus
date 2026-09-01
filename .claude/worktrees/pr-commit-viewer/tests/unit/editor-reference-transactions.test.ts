import { describe, expect, test } from 'bun:test'
import { Schema, type Node } from '@tiptap/pm/model'
import { EditorState } from '@tiptap/pm/state'
import { transactionChangesTrackedRefs } from '../../src/renderer/components/editor/references'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block' },
    text: { group: 'inline' },
    planReference: {
      inline: true,
      group: 'inline',
      atom: true,
      attrs: { planId: {}, title: { default: null } },
    },
    workReference: {
      inline: true,
      group: 'inline',
      atom: true,
      attrs: { workId: {}, title: { default: null } },
    },
    fileReference: {
      inline: true,
      group: 'inline',
      atom: true,
      attrs: { path: {} },
    },
  },
})

function stateWith(content: Node[]): EditorState {
  return EditorState.create({
    schema,
    doc: schema.node('doc', null, [schema.node('paragraph', null, content)]),
  })
}

describe('transactionChangesTrackedRefs', () => {
  test('ignores ordinary text edits and untracked file references', () => {
    // WHY: normal typing is the hot path and must not trigger a full reference scan.
    const textState = stateWith([schema.text('hello')])
    expect(transactionChangesTrackedRefs(textState.tr.insertText('!', 2))).toBe(false)

    const fileRef = schema.nodes.fileReference.create({ path: 'src/app.ts' })
    expect(transactionChangesTrackedRefs(textState.tr.insert(2, fileRef))).toBe(false)
  })

  test('detects tracked reference insertion and deletion', () => {
    // WHY: optimizing ordinary typing must not leave plan/work attachment state stale.
    const plainState = stateWith([schema.text('ab')])
    const planRef = schema.nodes.planReference.create({ planId: 'plan-1' })
    expect(transactionChangesTrackedRefs(plainState.tr.insert(2, planRef))).toBe(true)

    const referencedState = stateWith([
      schema.text('a'),
      schema.nodes.workReference.create({ workId: 'work-1' }),
      schema.text('b'),
    ])
    expect(transactionChangesTrackedRefs(referencedState.tr.delete(2, 3))).toBe(true)
  })

  test('detects metadata-only updates with an empty step map', () => {
    const referencedState = stateWith([
      schema.text('a'),
      schema.nodes.planReference.create({ planId: 'plan-1', title: 'Old' }),
    ])
    expect(
      transactionChangesTrackedRefs(
        referencedState.tr.setNodeAttribute(2, 'title', 'Updated'),
      ),
    ).toBe(true)
  })
})
