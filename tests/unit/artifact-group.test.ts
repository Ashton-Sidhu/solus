import { describe, expect, test } from 'bun:test'
import type { Message } from '@solus/contracts/types'
import {
  emptyGrouping,
  finishGrouping,
  groupInto,
  groupMessages,
  itemKey,
  resumeGrouping,
} from '@solus/workspace-ui/components/conversation/lib/turns'
import {
  artifactGroupSummary,
  artifactGroupTabs,
  lastWrittenWorkId,
  latestVersion,
  nextTabIndex,
  revisionVersion,
  wasCreatedInTurn,
} from '@solus/workspace-ui/components/conversation/lib/artifact-group'
import { artifactRevisionIndex, artifactRevisions } from '@solus/workspace-ui/components/conversation/lib/artifact-revisions'

let clock = 1_000
function msg(partial: Partial<Message> & Pick<Message, 'role'>): Message {
  clock += 1_000
  return { id: `m${clock}`, content: '', timestamp: clock, ...partial }
}
const prompt = (content = 'Go') => msg({ role: 'user', content })
const prose = (content: string) => msg({ role: 'assistant', content })
const call = () => msg({ role: 'tool', toolName: 'mcp__solus__update_work', toolInput: '{}', toolStatus: 'completed' })
function saved(workId: string, contentVersion: number, html = `<p>${workId} v${contentVersion}</p>`): Message {
  return msg({ role: 'assistant', artifact: { kind: 'html', html }, workRef: { workId, title: `Work ${workId}`, workType: 'artifact', contentVersion } })
}

/** The rows a running transcript shows: each message grouped onto the last, as a segment streams. */
function streamed(messages: Message[]) {
  let grouping = emptyGrouping()
  for (let i = 0; i < messages.length; i++) {
    const next = resumeGrouping(grouping)
    groupInto(next, messages, i, i + 1)
    grouping = next
  }
  return finishGrouping(grouping)
}

describe('artifact group card', () => {
  test('two works in one turn are one card at the first write, and the rows between stay below it', () => {
    // WHY: three updates made four rows of renders and "earlier version"
    // cards. One act of the turn is one card, as documents and sub-agents are.
    const messages = [prompt(), call(), saved('a', 4), prose('Next one.'), call(), saved('b', 5)]
    const items = groupMessages(messages)
    expect(items.map((item) => item.kind)).toEqual(['user', 'tool-group', 'artifact-group', 'assistant', 'tool-group'])
    const group = items[2]
    expect(group.kind === 'artifact-group' && group.messages.map((m) => m.workRef?.workId)).toEqual(['a', 'b'])
    expect(itemKey(group)).toBe(`ar-${messages[2].id}`)
  })

  test('a work written twice in a grouped turn is one tab that shows the newest write', () => {
    const messages = [prompt(), saved('a', 2), saved('b', 1), saved('a', 3)]
    const items = groupMessages(messages)
    expect(items.map((item) => item.kind)).toEqual(['user', 'artifact-group'])
    const group = items[1]
    if (group.kind !== 'artifact-group') throw new Error('no group')
    const tabs = artifactGroupTabs(group.messages)
    expect(tabs.map((tab) => [tab.workId, tab.message.workRef?.contentVersion])).toEqual([['a', 3], ['b', 1]])
    expect(lastWrittenWorkId(group.messages)).toBe('a')
  })

  test('one work in a turn makes no group: each write keeps its own row', () => {
    // WHY: a single artifact is a flush render with its version line. A card
    // around one work would add chrome and hide nothing.
    const once = groupMessages([prompt(), saved('a', 1)])
    expect(once.map((item) => item.kind)).toEqual(['user', 'artifact'])
    const twice = groupMessages([prompt(), saved('a', 1), prose('Fixed it.'), saved('a', 2)])
    expect(twice.map((item) => item.kind)).toEqual(['user', 'artifact', 'assistant', 'artifact'])
  })

  test('a second work turns the rows of the first into the card, and later cards keep their place', () => {
    const doc = msg({ role: 'assistant', workRef: { workId: 'doc', title: 'Notes', workType: 'doc', contentVersion: 1 } })
    const messages = [prompt(), saved('a', 1), prose('Again.'), saved('a', 2), doc, saved('b', 1), msg({ role: 'assistant', workRef: { workId: 'doc2', title: 'More', workType: 'doc', contentVersion: 1 } })]
    const items = groupMessages(messages)
    expect(items.map((item) => item.kind)).toEqual(['user', 'artifact-group', 'assistant', 'document'])
    const documents = items[3]
    expect(documents.kind === 'document' && documents.messages.map((m) => m.workRef?.workId)).toEqual(['doc', 'doc2'])
  })

  test('a new turn closes the group', () => {
    const items = groupMessages([prompt(), saved('a', 1), saved('b', 1), prompt('More'), saved('c', 1)])
    expect(items.map((item) => item.kind)).toEqual(['user', 'artifact-group', 'user', 'artifact'])
  })

  test('a fence artifact is reply text and stays out of the group', () => {
    const fence = prose('```html artifact=chart\n<p>Chart</p>\n```')
    const items = groupMessages([prompt(), saved('a', 1), fence, saved('b', 1)])
    expect(items.map((item) => item.kind)).toEqual(['user', 'artifact-group', 'assistant'])
  })

  test('streaming one message at a time gives the same rows as grouping all at once', () => {
    // WHY: a segment groups its last message onto the grouping of the rest
    // (resumeGrouping). The card must grow there exactly as a full regroup does.
    const doc = msg({ role: 'assistant', workRef: { workId: 'doc', title: 'Notes', workType: 'doc', contentVersion: 1 } })
    const messages = [prompt(), saved('a', 1), prose('x'), saved('a', 2), doc, call(), saved('b', 1), saved('c', 1), saved('a', 3)]
    const shape = (items: ReturnType<typeof groupMessages>) => items.map((item) =>
      'messages' in item ? `${item.kind}:${item.messages.map((m) => m.id).join(',')}` : `${item.kind}:${item.message.id}`)
    expect(shape(streamed(messages))).toEqual(shape(groupMessages(messages)))
  })
})

describe('artifact group labels', () => {
  test('a revision shows the version the host saved, the same number its frame shows', () => {
    // WHY: the line said "v5 of 5" (its place in the chain) while the frame
    // said "v4" (the saved version). One work has one version number.
    const messages = [saved('a', 2), saved('a', 3), saved('a', 4)]
    const chain = artifactRevisionIndex(artifactRevisions(messages)).get('work:a')!
    expect(revisionVersion(chain, 0)).toBe(2)
    expect(latestVersion(chain)).toBe(4)
    const unversioned = artifactRevisionIndex(artifactRevisions([msg({ role: 'assistant', artifact: { kind: 'html', html: '<p>x</p>' }, workRef: { workId: 'b', title: 'B', workType: 'artifact' } })])).get('work:b')!
    expect(revisionVersion(unversioned, 0)).toBe(1)
  })

  test('the folded line counts the works and says which the turn created', () => {
    const messages = [saved('a', 4), saved('b', 1), saved('c', 2)]
    const tabs = artifactGroupTabs(messages)
    const chains = artifactRevisionIndex(artifactRevisions(messages))
    const summary = artifactGroupSummary(tabs, (tab) => wasCreatedInTurn(tab, chains.get(`work:${tab.workId}`)))
    expect(summary).toEqual({ count: '3 artifacts', detail: '2 updated · 1 new' })
    expect(artifactGroupSummary(tabs, () => false).detail).toBe('3 updated')
  })

  test('arrow keys move between tabs and wrap; other keys do not', () => {
    expect(nextTabIndex(2, 'ArrowRight', 3)).toBe(0)
    expect(nextTabIndex(0, 'ArrowLeft', 3)).toBe(2)
    expect(nextTabIndex(1, 'End', 3)).toBe(2)
    expect(nextTabIndex(1, 'Enter', 3)).toBeNull()
  })
})
