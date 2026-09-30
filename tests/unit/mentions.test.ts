import { afterAll, describe, expect, test } from 'bun:test'
import { userKey } from '@solus/contracts/user'
import { memberUser, organizationPeople, type OrganizationPeople } from '@solus/workspace-ui/components/users/lib/organization-people'
import type { ShareList } from '@solus/contracts/sharing'
import { mentionedPeople, mentionsAsText, personMentionMarkdown } from '@solus/contracts/mentions'
import {
  parseReferenceTokens,
  serializeReferenceToken,
  type ReferenceToken,
} from '@solus/workspace-ui/components/editor/reference-tokens'
import { createPersonRefExtension } from '@solus/workspace-ui/components/editor/personRefExtension'
import { parseCommentText } from '@solus/workspace-ui/components/comments/lib/comment-text'
import {
  mentionCandidates,
  mentionQuery,
  mentionUser,
  personCanOpen,
  personStanding,
  scopeDirectory,
  type MentionScope,
} from '@solus/workspace-ui/components/mentions/lib/mentions'
import { SvelteRunes } from './helpers/svelte-runes'

// Plan 004 item 13: a mention stores the member's user id; readers show the
// member's current name; a Local record has no one to mention; a mention never
// grants access, so the composer warns about a person who cannot open the record.

const DIRECTORY: OrganizationPeople = organizationPeople({
  organizationId: 'org_1',
  name: 'Acme',
  members: [
    { userId: 'u_zoe', name: 'Zoe Adams', email: 'zoe@acme.dev', role: 'member' },
    { userId: 'u_ann', name: 'Ann Lee', email: 'ann@acme.dev', role: 'member' },
    { userId: 'u_bob', name: 'Bob Ray', email: 'bob@acme.dev', role: 'member' },
  ],
  teams: [{ teamId: 't_ops', name: 'Ops', memberUserIds: ['u_bob'] }],
})

function scope(organizationId: string): MentionScope {
  return { serverId: 'ws', organizationId, resource: { kind: 'work', id: 'w1' }, title: 'Launch', recentUserIds: ['u_bob'] }
}

describe('the person token', () => {
  const token: ReferenceToken = { kind: 'person', userId: 'u_ann', name: 'Ann [Ops] Lee' }

  test('round-trips through Markdown with its user id and saved name', () => {
    const markdown = serializeReferenceToken(token)
    expect(markdown).toBe('[@Ann \\[Ops\\] Lee](person://ref?userId=u_ann)')
    expect(parseReferenceTokens(`ping ${markdown} today`).map((range) => range.token)).toEqual([token])
    // The same text the server and the notifications hub read.
    expect(mentionedPeople(`${markdown} and ${markdown}`)).toEqual([{ userId: 'u_ann', name: 'Ann [Ops] Lee' }])
    expect(mentionsAsText(`ping ${markdown}`)).toBe('ping @Ann [Ops] Lee')
  })

  test('the work body chip writes the same Markdown and shows the current name', () => {
    const extension = createPersonRefExtension((userId) => personStanding(userId, DIRECTORY))
    const attrs = { userId: 'u_ann', name: 'Ann Old-Name' }
    // SAFETY: the renderers read only the node's attributes.
    expect(extension.config.renderText?.({ node: { attrs } } as never)).toBe(serializeReferenceToken({ kind: 'person', ...attrs }))
    const chip = JSON.stringify(extension.config.renderHTML?.({ node: { attrs }, HTMLAttributes: {} } as never))
    expect(chip).toContain('solus-token--person')
    expect(chip).toContain('@Ann Lee')
    // A person who left: the saved name, and no chip.
    const left = JSON.stringify(extension.config.renderHTML?.({ node: { attrs: { userId: 'u_gone', name: 'Gus' } }, HTMLAttributes: {} } as never))
    expect(left).toContain('@Gus')
    expect(left).not.toContain('solus-token')
  })

  test('a mention draws the member as they are named now; one who left is plain text, never a chip', () => {
    // WHY (plans/012 §6): a chip stands for a person the reader can reach. A
    // person who left keeps the name they had when the mention was written.
    const mention = { userId: 'u_ann', name: 'Ann Old-Name' }
    expect(mentionUser(mention, personStanding('u_ann', DIRECTORY))).toEqual(memberUser({ userId: 'u_ann', name: 'Ann Lee', email: 'ann@acme.dev', role: 'member' }))
    expect(mentionUser({ userId: 'u_gone', name: 'Gus' }, personStanding('u_gone', DIRECTORY))).toBeNull()
    // No directory read yet: the saved name, as a chip, until the reader knows better.
    expect(mentionUser(mention, personStanding('u_ann', null))).toEqual({ id: { kind: 'account', accountId: 'u_ann' }, displayName: 'Ann Old-Name' })
  })

  test('a comment keeps the user id in its text', () => {
    const text = `${personMentionMarkdown({ userId: 'u_ann', name: 'Ann Lee' })} please check`
    const [block] = parseCommentText(text)
    expect(block).toEqual({
      kind: 'text',
      segments: [
        { kind: 'person', text: '@Ann Lee', userId: 'u_ann', name: 'Ann Lee' },
        { kind: 'plain', text: ' please check' },
      ],
    })
  })

  test('a comment editor reads plain @name as prose, not as a file chip', () => {
    const text = `@readme ${serializeReferenceToken(token)}`
    expect(parseReferenceTokens(text, { kinds: new Set(['person']) }).map((range) => range.token)).toEqual([token])
  })
})

describe('who the picker offers', () => {
  test('a Local record offers no people', () => {
    expect(scopeDirectory(scope('local'), DIRECTORY)).toBeNull()
    expect(scopeDirectory(null, DIRECTORY)).toBeNull()
    // The directory of another organization is not this record's either.
    expect(scopeDirectory(scope('org_2'), DIRECTORY)).toBeNull()
    expect(scopeDirectory(scope('org_1'), DIRECTORY)).toBe(DIRECTORY)
  })

  test('recent contacts first, then by name; a query matches a word or the email', () => {
    expect(mentionCandidates(DIRECTORY, ['u_bob'], '').map((member) => userKey(member.id))).toEqual(['u_bob', 'u_ann', 'u_zoe'])
    expect(mentionCandidates(DIRECTORY, [], 'lee').map((member) => userKey(member.id))).toEqual(['u_ann'])
    expect(mentionCandidates(DIRECTORY, [], 'zoe@').map((member) => userKey(member.id))).toEqual(['u_zoe'])
  })

  test('the query starts at an @ that begins a word', () => {
    expect(mentionQuery('hi @an')).toBe('an')
    expect(mentionQuery('@')).toBe('')
    expect(mentionQuery('hi @Ann L')).toBe('Ann L')
    expect(mentionQuery('mail ann@acme')).toBeNull()
    expect(mentionQuery('hi @ ')).toBeNull()
  })
})

describe('the access warning', () => {
  const list = (grants: ShareList['grants'], link: ShareList['link'] = null): ShareList => ({
    resource: { kind: 'work', id: 'w1' },
    ownerUserId: 'u_zoe',
    grants,
    callerRole: 'owner',
    link,
  })
  const grant = (subject: ShareList['grants'][number]['subject']) => ({ subject, role: 'viewer' as const, grantedByUserId: 'u_zoe', createdAt: 1 })

  test('warns only for a person with no role on the record', () => {
    const shared = list([grant({ kind: 'user', id: 'u_ann' }), grant({ kind: 'team', id: 't_ops' })], { role: 'viewer' })
    expect(personCanOpen('u_zoe', [shared], DIRECTORY)).toBe(true) // owner
    expect(personCanOpen('u_ann', [shared], DIRECTORY)).toBe(true) // their own row
    expect(personCanOpen('u_bob', [shared], DIRECTORY)).toBe(true) // their team's row
    // A link does not count: the person does not hold its secret.
    expect(personCanOpen('u_new', [shared], { ...DIRECTORY, members: [...DIRECTORY.members, memberUser({ userId: 'u_new', name: 'New', role: 'member' })] })).toBe(false)
  })

  test('an organization row reaches its members; a task the record sits in counts too', () => {
    const organizationWide = list([grant({ kind: 'organization', id: 'org_1' })])
    expect(personCanOpen('u_ann', [organizationWide], DIRECTORY)).toBe(true)
    const privateWork = list([])
    const task = { ...list([grant({ kind: 'user', id: 'u_ann' })]), resource: { kind: 'task' as const, id: 't1' } }
    expect(personCanOpen('u_ann', [privateWork], DIRECTORY)).toBe(false)
    expect(personCanOpen('u_ann', [privateWork, task], DIRECTORY)).toBe(true)
  })

  test('says nothing while the answer is not known', () => {
    expect(personCanOpen('u_ann', [list([])], null)).toBeNull()
    expect(personCanOpen('u_ann', [list([]), undefined], DIRECTORY)).toBeNull()
  })
})

describe('the picker', () => {
  const runes = new SvelteRunes()
  afterAll(() => runes.dispose())
  const pickerModule = runes.source('mention-picker', 'packages/workspace-ui/src/components/mentions/lib/mention-picker.svelte.ts', {
    '../../editor/unified-autocomplete/rows': SvelteRunes.file('packages/workspace-ui/src/components/editor/unified-autocomplete/rows.ts'),
    './mentions': SvelteRunes.file('packages/workspace-ui/src/components/mentions/lib/mentions.ts'),
    './mention-rows': SvelteRunes.file('packages/workspace-ui/src/components/mentions/lib/mention-rows.ts'),
  })

  async function picker(directory: OrganizationPeople | null) {
    const { MentionPicker } = await import(pickerModule)
    const inserted: ReferenceToken[] = []
    let text = ''
    const { organizationMentionSource } = await import(pickerModule)
    const instance = new MentionPicker({
      source: organizationMentionSource({
        directory: () => directory,
        recentUserIds: () => ['u_bob'],
        warm: () => {},
      }),
      editor: () => ({
        textBeforeCursor: () => text,
        cursorRect: () => null,
        insertReference: (token: ReferenceToken) => { inserted.push(token); return true },
        focus: () => {},
      }),
    })
    const type = (next: string) => { text = next; instance.handleEditorChange(next) }
    return { instance, inserted, type }
  }

  test('a Local record opens no menu on @', async () => {
    const { instance, type } = await picker(scopeDirectory(scope('local'), DIRECTORY))
    type('hello @')
    expect(instance.rows).toEqual([])
    expect(instance.open).toBe(false)
  })

  test('Enter inserts the person token with the member user id', async () => {
    const { instance, inserted, type } = await picker(DIRECTORY)
    type('hello @')
    expect(instance.open).toBe(true)
    // SAFETY: the picker reads only the key, the modifiers and the two verbs.
    const event = { key: 'Enter', shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, preventDefault() {}, stopPropagation() {} } as unknown as KeyboardEvent
    expect(instance.handleKeyDown(event)).toBe(true)
    // Bob is a recent contact, so he is first.
    expect(inserted).toEqual([{ kind: 'person', userId: 'u_bob', name: 'Bob Ray' }])
  })
})
