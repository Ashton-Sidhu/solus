import { describe, expect, test } from 'bun:test'
import type { Message } from '@solus/contracts/types'
import type { User } from '@solus/contracts/user'
import { buildTurns, groupMessages } from '@solus/workspace-ui/components/conversation/lib/turns'
import { userBurstAt } from '@solus/workspace-ui/components/conversation/lib/user-burst'
import {
  collageCell,
  fileCardDetail,
  userMessageLayout,
} from '@solus/workspace-ui/components/conversation/lib/user-message-layout'
import { attachmentLabel } from '@solus/workspace-ui/lib/attachment-label'
import { attachmentCardDetail, attachmentDisplayName } from '../../apps/mobile/src/features/conversation/lib/message-attachments'

let clock = 1_000
function msg(partial: Partial<Message> & Pick<Message, 'role'>): Message {
  clock += 1_000
  return { id: `m${clock}`, content: 'hi', timestamp: clock, ...partial }
}
const person = (accountId: string): User => ({ id: { kind: 'account', accountId }, displayName: accountId })

function bursts(messages: Message[], running = false) {
  const turns = buildTurns(groupMessages(messages), { running })
  return turns.map((_, index) => userBurstAt(turns, index))
}

// Back-to-back messages from one person read as one thought: the gap between
// them closes and their name shows once. Anything between them, or another
// sender, keeps them apart.
describe('user message bursts', () => {
  test('two prompts with nothing between them form one burst', () => {
    expect(bursts([msg({ role: 'user' }), msg({ role: 'user', delivery: 'steer' })], true)).toEqual([
      { groupedWithNext: true, continuesBurst: false },
      { groupedWithNext: false, continuesBurst: true },
    ])
  })

  test('a run of three links each pair, the middle one on both sides', () => {
    const [, middle] = bursts([msg({ role: 'user' }), msg({ role: 'user' }), msg({ role: 'user' })])
    expect(middle).toEqual({ groupedWithNext: true, continuesBurst: true })
  })

  test('a reply between two prompts ends the burst', () => {
    const result = bursts([msg({ role: 'user' }), msg({ role: 'assistant', content: 'ok' }), msg({ role: 'user' })])
    expect(result.every((burst) => !burst.groupedWithNext && !burst.continuesBurst)).toBe(true)
  })

  test('another person, an automation, or a host notice never joins a burst', () => {
    const others = bursts([msg({ role: 'user', author: person('ada') }), msg({ role: 'user', author: person('grace') })])
    expect(others[0]!.groupedWithNext).toBe(false)
    const same = bursts([msg({ role: 'user', author: person('ada') }), msg({ role: 'user', author: person('ada') })])
    expect(same[0]!.groupedWithNext).toBe(true)
    const automation = bursts([msg({ role: 'user' }), msg({ role: 'user', via: 'automation' })])
    expect(automation[0]!.groupedWithNext).toBe(false)
    const notice = bursts([msg({ role: 'user' }), msg({ role: 'user', via: 'background-command' })])
    expect(notice[0]!.groupedWithNext).toBe(false)
  })

  test('a second prompt that arrives live joins the first one', () => {
    const first = msg({ role: 'user' })
    expect(bursts([first], true)[0]!.groupedWithNext).toBe(false)
    expect(bursts([first, msg({ role: 'user', delivery: 'steer' })], true)[0]!.groupedWithNext).toBe(true)
  })
})

// Which shape a message gets decides whether the reader sees a picture, a
// card, or a chip: words change how the files and the bubble are drawn.
describe('user message layout', () => {
  test('pictures with words sit above a bubble whose corner tightens', () => {
    expect(userMessageLayout({ hasText: true, imageCount: 1, videoCount: 0, fileCount: 0 })).toEqual({
      images: 'lone', files: 'none', bubbleMeetsMedia: true,
    })
    expect(userMessageLayout({ hasText: true, imageCount: 3, videoCount: 0, fileCount: 0 }).images).toBe('collage')
    expect(userMessageLayout({ hasText: true, imageCount: 0, videoCount: 1, fileCount: 0 }).bubbleMeetsMedia).toBe(true)
    // Media alone has no bubble to meet.
    expect(userMessageLayout({ hasText: false, imageCount: 2, videoCount: 0, fileCount: 0 }).bubbleMeetsMedia).toBe(false)
  })

  test('files are chips beside words and cards without them', () => {
    expect(userMessageLayout({ hasText: true, imageCount: 0, videoCount: 0, fileCount: 1 }).files).toBe('chips')
    expect(userMessageLayout({ hasText: false, imageCount: 0, videoCount: 0, fileCount: 1 }).files).toBe('cards')
    // A file next to a picture does not touch the bubble's corner.
    expect(userMessageLayout({ hasText: true, imageCount: 0, videoCount: 0, fileCount: 2 }).bubbleMeetsMedia).toBe(false)
  })

  test('a collage of three leads with one tall picture; an odd last one spans the row', () => {
    expect(collageCell(3, 0)).toEqual({ spansRows: true, spansColumns: false })
    expect(collageCell(5, 4)).toEqual({ spansRows: false, spansColumns: true })
    expect(collageCell(4, 3)).toEqual({ spansRows: false, spansColumns: false })
  })

  test('a large paste reads as pasted text, on desktop and on the phone', () => {
    const paste = { type: 'file' as const, name: 'pasted text 2026-10-31 142233.txt', size: 40_960 }
    expect(attachmentLabel(paste)).toBe('Pasted text')
    expect(attachmentDisplayName(paste.name)).toBe('Pasted text')
    expect(attachmentLabel({ type: 'file', name: 'notes.txt' })).toBe('notes.txt')
    expect(fileCardDetail(paste, 'sent')).toBe('Text · 40 KB')
    expect(attachmentCardDetail(paste.name, false)).toBe('Text')
  })

  test('a file card on its way says Sending in place of its type and size', () => {
    const pdf = { type: 'file' as const, name: 'spec.pdf', size: 2048 }
    expect(fileCardDetail(pdf, 'sent')).toBe('PDF · 2.0 KB')
    expect(fileCardDetail(pdf, 'steering')).toBe('Sending…')
    expect(fileCardDetail(pdf, 'queueing')).toBe('Sending…')
    // A held prompt is not on its way: it states what it carries.
    expect(fileCardDetail(pdf, 'queued')).toBe('PDF · 2.0 KB')
    expect(attachmentCardDetail('spec.pdf', true)).toBe('Sending…')
  })
})
