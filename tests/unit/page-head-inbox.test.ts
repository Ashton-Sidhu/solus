import { describe, expect, test } from 'bun:test'
import { inInboxScope } from '@solus/workspace-ui/components/ui/list-page/list-page'
import { inboxScopeOptions } from '@solus/workspace-ui/components/tasks/lib/inbox-scope'

describe('narrowing the inbox to some projects', () => {
  const rows = [
    { projectKeys: ['/src/aethos'] },
    { projectKeys: ['/src/aethos'] },
    { projectKeys: ['/src/solus-web', '/src/solus-web-clone'] },
  ]
  const labelFor = (projectKey: string) => projectKey.split('/').pop() ?? projectKey

  test('offers only projects that could change the list', () => {
    // WHY: the menu is built from the rows on screen, not from the project
    // switcher — a project with nothing in your inbox is a row that can only
    // empty the list.
    expect(inboxScopeOptions(rows, labelFor)).toEqual([
      { value: '/src/aethos', projectKey: '/src/aethos', label: 'aethos', count: 2 },
      {
        value: '/src/solus-web',
        projectKey: '/src/solus-web',
        label: 'solus-web',
        count: 1,
      },
      {
        value: '/src/solus-web-clone',
        projectKey: '/src/solus-web-clone',
        label: 'solus-web-clone',
        count: 1,
      },
    ])
  })

  test('keeps a narrowing project on the menu after it empties', () => {
    // WHY: otherwise the filter that emptied the inbox disappears with the rows
    // it hid, and there is nothing left to click to undo it.
    const options = inboxScopeOptions(rows, labelFor, ['/src/gone'])
    expect(options.find((option) => option.value === '/src/gone')).toEqual({
      value: '/src/gone',
      projectKey: '/src/gone',
      label: 'gone',
      count: 0,
    })
  })

  test('an empty selection is every project, not none of them', () => {
    // WHY: no narrowing is the inbox's resting scope — the state the crumb is
    // describing when it says "All projects".
    expect(inInboxScope(['/src/aethos'], [])).toBe(true)
    expect(inInboxScope([], [])).toBe(true)
    expect(inInboxScope(['/src/aethos'], ['/src/solus-web'])).toBe(false)
  })

  test('a row cloned into two projects survives either one', () => {
    // WHY: one upstream ticket can be merged from two clones of the same repo.
    // Narrowing to either clone must still show it.
    expect(inInboxScope(['/src/a', '/src/b'], ['/src/b'])).toBe(true)
  })
})
