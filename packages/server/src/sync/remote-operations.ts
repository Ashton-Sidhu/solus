import { WorkspaceRequestError, type SolusApiClient } from '@solus/contracts/solus-api/client'
import { workspaceErrorCodeSchema } from '@solus/contracts/solus-api'
import { SolusApiError } from '../admission/workspace-error'
import type { WorkspaceOperations } from '../data/workspace/operations'

/**
 * The record operations of an organization run, answered by its Solus API
 * (organization-vms §3). An agent tool in a session whose home is the API calls
 * the same `WorkspaceOperations` it calls for a Local session; these send each
 * one to the API as the person the run's authority names, synchronously, so a
 * create is readable the moment it returns. The API checks scope and access; the
 * context argument is the host's and is not sent. A failure answers the API's
 * own code, or that the API cannot be reached: nothing falls back to a Local
 * record.
 */
export function remoteWorkspaceOperations(
  client: SolusApiClient,
  /** Waits until the session a write names has reached the API; its first report may still be queued. */
  sessionReported: (recordId: string) => Promise<boolean>,
): WorkspaceOperations {
  const call = async <T>(request: () => Promise<T>): Promise<T> => {
    try {
      return await request()
    } catch (error) {
      if (error instanceof SolusApiError) throw error
      if (error instanceof WorkspaceRequestError) throw fromRequestError(error)
      throw new SolusApiError(503, 'CAPABILITY_UNAVAILABLE', `The organization's Solus API is not reachable: ${error instanceof Error ? error.message : String(error)}. Nothing was saved; try again when it is back.`, 5)
    }
  }
  return {
    listTasks: (_context, query) => call(() => client.request('listTasks', { query })),
    getTask: (_context, taskId) => call(() => client.request('getTask', { id: taskId })),
    createTask: async (_context, input, key) => {
      if (input.originSessionId) await sessionReported(input.originSessionId)
      return call(() => client.request('createTask', { body: input, key }))
    },
    updateTask: (_context, taskId, input, version) => call(() => client.request('updateTask', { id: taskId, body: input, version })),
    deleteTask: (_context, taskId, version) => call(() => client.request('deleteTask', { id: taskId, version })),
    listWorks: (_context, query) => call(() => client.request('listWorks', { query })),
    importWork: async (_context, input, key) => {
      if (input.originSessionId) await sessionReported(input.originSessionId)
      return call(() => client.request('importWork', { body: input, key }))
    },
    publishWork: (_context, workId, input) => call(() => client.request('publishWork', { id: workId, body: input })),
    pullWorkUpstream: (_context, workId) => call(() => client.request('pullWorkUpstream', { id: workId, body: {} })),
    requestWorkReview: (_context, workId, input) => call(() => client.request('requestWorkReview', { id: workId, body: input })),
    searchWorks: (_context, query) => call(() => client.request('searchWorks', { query })),
    getWorkVersion: async (_context, workId) => (await call(() => client.request('getWork', { id: workId }))).version,
    getWork: (_context, workId) => call(() => client.request('getWork', { id: workId })),
    createWork: async (_context, input, key) => {
      if (input.originSessionId) await sessionReported(input.originSessionId)
      return call(() => client.request('createWork', { body: input, key }))
    },
    updateWork: (_context, workId, input, version) => call(() => client.request('updateWork', { id: workId, body: input, version })),
    deleteWork: (_context, workId, version) => call(() => client.request('deleteWork', { id: workId, version })),
    listSessions: (_context, query) => call(() => client.request('listSessions', { query })),
    searchSessions: (_context, query) => call(() => client.request('searchSessions', { query })),
    admitSession: (_context, input) => call(() => client.request('admitSession', { body: input })),
    getSession: (_context, sessionId) => call(() => client.request('getSession', { id: sessionId })),
    listSessionMessages: (_context, sessionId, query) => call(() => client.request('listSessionMessages', { id: sessionId, query })),
    listInsights: (_context, query) => call(() => client.request('listInsights', { query })),
    getInsight: (_context, insightId) => call(() => client.request('getInsight', { id: insightId })),
    listTaskActivity: (_context, taskId, query) => call(() => client.request('listTaskActivity', { id: taskId, query })),
    listWorkActivity: (_context, workId, query) => call(() => client.request('listWorkActivity', { id: workId, query })),
    listSessionActivity: (_context, sessionId, query) => call(() => client.request('listSessionActivity', { id: sessionId, query })),
    listMyActivity: (_context, query) => call(() => client.request('listMyActivity', { query })),
  }
}

const STATUSES = [400, 401, 403, 404, 409, 412, 413, 429, 500, 503] as const

/** The API's own answer, with its status and code, as the shared operations report it. */
function fromRequestError(error: WorkspaceRequestError): SolusApiError {
  const status = STATUSES.find((candidate) => candidate === error.status) ?? 503
  const code = workspaceErrorCodeSchema.safeParse(error.code)
  return new SolusApiError(status, code.success ? code.data : status === 404 ? 'NOT_FOUND' : 'CAPABILITY_UNAVAILABLE', error.message)
}
