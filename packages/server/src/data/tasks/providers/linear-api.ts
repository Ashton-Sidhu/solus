import { z } from 'zod'
import { linearDeliverySchema, type ProviderRef } from '@solus/contracts/vault'
import { currentPersonKey } from '../../../vault/acting-scope'
import { vault } from '../../../vault/vault'
import { TaskProviderError } from './types'

const LINEAR_REF: ProviderRef = { kind: 'provider', provider: 'linear' }
export interface LinearInput {
  commentId?: string
  emoji?: string
  teamId?: string
  title?: string
  description?: string
  stateId?: string
  assigneeId?: string | null
  priority?: number
  dueDate?: string | null
  labelIds?: string[]
  issueId?: string
  body?: string
}
export interface LinearVariables {
  id?: string
  teamId?: string
  input?: LinearInput
  text?: string
  after?: string | null
  before?: string | null
}
export const linearStateSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  position: z.number().optional()
})
export const linearPersonSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  avatarUrl: z.string().nullish()
})
export const linearIssueSchema = z.object({
  id: z.string(),
  identifier: z.string(),
  title: z.string(),
  description: z.string().nullish(),
  url: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  priority: z.number(),
  dueDate: z.string().nullish(),
  state: linearStateSchema,
  team: z.object({ id: z.string(), key: z.string() }),
  assignee: linearPersonSchema.nullable(),
  creator: linearPersonSchema.nullish(),
  labels: z.object({ nodes: z.array(z.object({ id: z.string(), name: z.string() })) })
})
export const LINEAR_ISSUE_FIELDS = `id identifier title description url createdAt updatedAt priority dueDate
 state { id name type } team { id key } assignee { id name email avatarUrl } creator { id name email avatarUrl } labels(first: 100) { nodes { id name } }`

/** Fixed endpoint: credentials never follow a URL supplied by a client. */
export async function linearRequest<Schema extends z.ZodType>(
  query: string,
  variables: LinearVariables,
  schema: Schema,
  key?: string,
  fetcher: typeof fetch = fetch
): Promise<z.infer<Schema>> {
  const saved = key
    ? { key }
    : await vault().read(currentPersonKey(), LINEAR_REF, linearDeliverySchema)
  if (!saved) throw new TaskProviderError('not_connected', 'Connect Linear to read these tasks.')
  const response = await fetcher('https://api.linear.app/graphql', {
    method: 'POST',
    headers: { authorization: saved.key, 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(20_000),
    redirect: 'error'
  })
  if (response.status === 401)
    throw new TaskProviderError('reconnect', 'Linear rejected this API key. Connect Linear again.')
  if (response.status === 403)
    throw new TaskProviderError('no_access', 'This Linear account cannot read that team or issue.')
  if (response.status === 429)
    throw new TaskProviderError('error', 'Linear has limited requests. Wait before you retry.')
  if (!response.ok)
    throw new TaskProviderError('error', `Linear request failed (${response.status}).`)
  const result = z
    .object({
      data: z.unknown().optional(),
      errors: z.array(z.object({ message: z.string() })).optional()
    })
    .parse(await response.json())
  if (result.errors?.length)
    throw new TaskProviderError('error', result.errors.map((error) => error.message).join('; '))
  return schema.parse(result.data)
}

const connectionSchema = z.object({
  viewer: z.object({ name: z.string() }),
  organization: z.object({ id: z.string(), urlKey: z.string() }),
  teams: z.object({
    nodes: z.array(z.object({ id: z.string(), key: z.string(), name: z.string() }))
  })
})
export async function linearConnection() {
  return linearRequest(
    'query { viewer { name } organization { id urlKey } teams(first: 100) { nodes { id key name } } }',
    {},
    connectionSchema
  )
}
export function linearCategory(type: string): 'open' | 'active' | 'done' {
  return ['completed', 'canceled'].includes(type) ? 'done' : type === 'started' ? 'active' : 'open'
}
