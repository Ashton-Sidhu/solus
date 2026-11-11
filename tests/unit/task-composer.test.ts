import { describe, expect, test } from 'bun:test'
import { addLabel, composerFieldsFor, labelSuggestions } from '@solus/workspace-ui/components/tasks/lib/task-composer'

describe('the fields the composer shows for a source', () => {
  // WHY: the composer hides a field the provider would drop, so a person
  // never sets a priority that is lost when the task is created.

  test('a GitHub repository takes labels, and no priority or due date', () => {
    // A new issue is on no Project, so it has no priority or due date field.
    expect(composerFieldsFor('github-repo')).toEqual({ labels: true, planning: false })
  })

  test('a GitHub Project creates a draft item: a title and a body only', () => {
    expect(composerFieldsFor('github-project')).toEqual({ labels: false, planning: false })
  })

  test('a Jira project and a Jira board take labels, priority and due date', () => {
    expect(composerFieldsFor('jira-project')).toEqual({ labels: true, planning: true })
    expect(composerFieldsFor('jira-board')).toEqual({ labels: true, planning: true })
  })

  test('with no source chosen, no optional field shows', () => {
    // WHY: until the source is known, each optional field could be one that
    // the provider drops.
    expect(composerFieldsFor(undefined)).toEqual({ labels: false, planning: false })
  })
})

describe('labels in the composer', () => {
  test('a typed label is trimmed, and a blank or a duplicate in another case is refused', () => {
    // WHY: GitHub labels do not distinguish case, so `Bug` and `bug` would be
    // one label sent twice.
    expect(addLabel(['bug'], '  design ')).toEqual(['bug', 'design'])
    expect(addLabel(['bug'], 'BUG')).toEqual(['bug'])
    expect(addLabel(['bug'], '   ')).toEqual(['bug'])
  })

  test('suggestions are the labels of the project that are not chosen yet and match the text', () => {
    const known = ['backend', 'bug', 'design', 'docs']
    expect(labelSuggestions(known, ['Bug'], 'b')).toEqual(['backend'])
    expect(labelSuggestions(known, [], '')).toEqual(known)
    expect(labelSuggestions(Array.from({ length: 20 }, (_, index) => `label-${index}`), [], 'label')).toHaveLength(8)
  })
})
