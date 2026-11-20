import { z } from 'zod'
import type {
  TaskInspection,
  TaskReactionContent,
  TaskTemplate
} from '@solus/contracts/task-inspection'
import { linearRequest } from './linear-api'
import { TaskProviderError } from './types'

const EMOJI = {
  THUMBS_UP: '👍',
  THUMBS_DOWN: '👎',
  LAUGH: '😄',
  HOORAY: '🎉',
  CONFUSED: '😕',
  HEART: '❤️',
  ROCKET: '🚀',
  EYES: '👀'
} satisfies Record<TaskReactionContent, string>
const EMOJI_NAMES = {
  THUMBS_UP: '+1',
  THUMBS_DOWN: '-1',
  LAUGH: 'smile',
  HOORAY: 'tada',
  CONFUSED: 'confused',
  HEART: 'heart',
  ROCKET: 'rocket',
  EYES: 'eyes'
} satisfies Record<TaskReactionContent, string>
const reaction = z.object({
  id: z.string(),
  emoji: z.string(),
  user: z.object({ id: z.string() }).nullable()
})
const event = z.object({
  id: z.string(),
  createdAt: z.string(),
  actor: z.object({ name: z.string() }).nullable(),
  fromState: z.object({ name: z.string() }).nullable(),
  toState: z.object({ name: z.string() }).nullable(),
  fromTitle: z.string().nullable(),
  toTitle: z.string().nullable(),
  addedLabels: z.array(z.object({ name: z.string() })).nullable(),
  removedLabels: z.array(z.object({ name: z.string() })).nullable()
})
const issueSchema = z.object({
  id: z.string(),
  creator: z.object({ name: z.string() }).nullable(),
  assignee: z.object({ email: z.string(), avatarUrl: z.string().nullable() }).nullable(),
  reactions: z.array(reaction),
  comments: z.object({
    nodes: z.array(z.object({ id: z.string(), reactions: z.array(reaction) })),
    pageInfo: z.object({ hasNextPage: z.boolean() })
  }),
  history: z.object({
    nodes: z.array(event),
    pageInfo: z.object({ hasPreviousPage: z.boolean(), startCursor: z.string().nullable() })
  }),
  attachments: z.object({ nodes: z.array(z.object({ title: z.string(), url: z.string() })) })
})
const inspectionSchema = z.object({
  organization: z.object({ id: z.string() }),
  viewer: z.object({ id: z.string() }),
  issue: issueSchema
})

export async function inspectLinearIssue(
  workspaceId: string,
  issueId: string,
  before?: string
): Promise<TaskInspection> {
  const result = await linearRequest(
    `query($id: String!, $before: String) { organization { id } viewer { id } issue(id: $id) {
    id creator { name } assignee { email avatarUrl } reactions { id emoji user { id } }
    comments(first: 100) { nodes { id reactions { id emoji user { id } } } pageInfo { hasNextPage } }
    history(last: 50, before: $before) { nodes { id createdAt actor { name } fromState { name } toState { name } fromTitle toTitle addedLabels { name } removedLabels { name } } pageInfo { hasPreviousPage startCursor } }
    attachments(first: 100) { nodes { title url } }
  } }`,
    { id: issueId, before: before ?? null },
    inspectionSchema
  )
  if (result.organization.id !== workspaceId)
    throw new TaskProviderError('no_access', 'This issue belongs to another Linear workspace.')
  const issue = result.issue
  const reactions: TaskInspection['reactions'] = []
  for (const target of [{ id: issue.id, reactions: issue.reactions }, ...issue.comments.nodes]) {
    for (const content of Object.keys(EMOJI).filter(
      (key): key is TaskReactionContent => key in EMOJI
    )) {
      const matching = target.reactions.filter(
        (entry) => entry.emoji === EMOJI[content] || entry.emoji === EMOJI_NAMES[content]
      )
      if (matching.length)
        reactions.push({
          targetId: target.id,
          content,
          count: matching.length,
          viewerHasReacted: matching.some((entry) => entry.user?.id === result.viewer.id)
        })
    }
  }
  return {
    commentsTruncated: issue.comments.pageInfo.hasNextPage,
    author: issue.creator?.name ?? null,
    assignees: issue.assignee
      ? [{ login: issue.assignee.email, avatarUrl: issue.assignee.avatarUrl ?? undefined }]
      : [],
    reactions,
    events: issue.history.nodes.map((entry) => ({
      id: entry.id,
      at: Date.parse(entry.createdAt),
      actor: entry.actor?.name ?? null,
      text:
        entry.toTitle !== null
          ? `changed the title to “${entry.toTitle}”`
          : entry.toState
            ? `moved the issue to ${entry.toState.name}`
            : entry.addedLabels?.length
              ? `added labels: ${entry.addedLabels.map((label) => label.name).join(', ')}`
              : entry.removedLabels?.length
                ? `removed labels: ${entry.removedLabels.map((label) => label.name).join(', ')}`
                : 'updated the issue'
    })),
    historyCursor: issue.history.pageInfo.hasPreviousPage
      ? issue.history.pageInfo.startCursor
      : null,
    pullRequests: issue.attachments.nodes.flatMap((attachment) => {
      const match = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/([1-9]\d*)\/?$/.exec(
        attachment.url
      )
      return match
        ? [
            {
              url: attachment.url,
              number: Number(match[1]),
              title: attachment.title,
              state: 'unknown' as const,
              closesIssue: false
            }
          ]
        : []
    }),
    capabilities: { history: true, reactions: true, multipleAssignees: false, templates: true }
  }
}

export async function reactToLinearIssue(
  workspaceId: string,
  issueId: string,
  targetId: string,
  content: TaskReactionContent,
  add: boolean
): Promise<void> {
  // Prove the target is this issue or one of its comments. This does not trust a client-supplied UUID.
  const result = await linearRequest(
    'query($id: String!) { organization { id } viewer { id } issue(id: $id) { id reactions { id emoji user { id } } } }',
    { id: issueId },
    z.object({
      organization: z.object({ id: z.string() }),
      viewer: z.object({ id: z.string() }),
      issue: z.object({ id: z.string(), reactions: z.array(reaction) })
    })
  )
  if (result.organization.id !== workspaceId)
    throw new TaskProviderError('no_access', 'This issue belongs to another Linear workspace.')
  let held = result.issue.reactions
  if (targetId !== issueId) {
    const comment = await linearRequest(
      'query($id: String!) { comment(id: $id) { issue { id } reactions { id emoji user { id } } } }',
      { id: targetId },
      z.object({
        comment: z.object({
          issue: z.object({ id: z.string() }).nullable(),
          reactions: z.array(reaction)
        })
      })
    )
    if (comment.comment.issue?.id !== issueId)
      throw new Error('This comment does not belong to the issue.')
    held = comment.comment.reactions
  }
  const mine = held.filter(
    (entry) =>
      entry.user?.id === result.viewer.id &&
      [EMOJI[content], EMOJI_NAMES[content]].includes(entry.emoji)
  )
  if (add && mine.length === 0) {
    const response = await linearRequest(
      'mutation($input: ReactionCreateInput!) { reactionCreate(input: $input) { success } }',
      {
        input: {
          ...(targetId === issueId ? { issueId } : { commentId: targetId }),
          emoji: EMOJI[content]
        }
      },
      z.object({ reactionCreate: z.object({ success: z.boolean() }) })
    )
    if (!response.reactionCreate.success) throw new Error('Linear did not accept the reaction.')
  } else if (!add)
    for (const entry of mine) {
      const response = await linearRequest(
        'mutation($id: String!) { reactionDelete(id: $id) { success } }',
        { id: entry.id },
        z.object({ reactionDelete: z.object({ success: z.boolean() }) })
      )
      if (!response.reactionDelete.success) throw new Error('Linear did not remove the reaction.')
    }
}

export async function linearTemplates(
  workspaceId: string,
  teamId: string,
  teamKey: string
): Promise<TaskTemplate[]> {
  const result = await linearRequest(
    'query { organization { id templates(first: 100) { nodes { id name description hasFormFields type team { id } } } } }',
    {},
    z.object({
      organization: z.object({
        id: z.string(),
        templates: z.object({
          nodes: z.array(
            z.object({
              id: z.string(),
              name: z.string(),
              description: z.string().nullable(),
              hasFormFields: z.boolean(),
              type: z.string(),
              team: z.object({ id: z.string() }).nullable()
            })
          )
        })
      })
    })
  )
  if (result.organization.id !== workspaceId)
    throw new TaskProviderError('no_access', 'This team belongs to another Linear workspace.')
  // The native form preserves all template fields, including states, labels and assignees.
  return result.organization.templates.nodes
    .filter(
      (template) => template.type === 'issue' && (!template.team || template.team.id === teamId)
    )
    .map((template) => ({
      id: template.id,
      name: template.name,
      description: template.description ?? '',
      title: '',
      body: '',
      url: `https://linear.app/team/${encodeURIComponent(teamKey)}/new?template=${encodeURIComponent(template.id)}`
    }))
}
