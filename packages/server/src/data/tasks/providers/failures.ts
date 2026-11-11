import { z } from 'zod'
import { TASKS_AUTH_ERROR_PREFIX, type TaskSourceHealth } from '@solus/contracts/task-types'
import { GitHubReauthRequiredError } from '../../../providers/github/octokit'
import { JiraRequestError, TaskProviderError } from './types'

/** What a failed provider call means for the person's connection. */
export interface ProviderFailure {
  health: Exclude<TaskSourceHealth, 'ok'>
  /** Why, in words a person can read. */
  message: string
}

const statusSchema = z.object({ status: z.number() })
const graphqlErrorsSchema = z.object({ errors: z.array(z.object({ type: z.string().optional() })) })

/**
 * Classify a failed provider call (docs/plans/provider-owned-tasks.md §5):
 * no connection is `not_connected`; a connection that lacks a permission, or
 * that the provider does not take any more, is `reconnect`; a refusal of this
 * one source or task (403, 404) is `no_access`; each other failure is `error`.
 * An adapter that knows more throws `TaskProviderError` and is believed.
 */
export function classifyProviderFailure<Failure>(error: Failure): ProviderFailure {
  const message = error instanceof Error ? error.message : String(error)
  if (error instanceof TaskProviderError) return { health: error.health, message }
  // `runGithubRequest` says this when the person has no GitHub credential at all.
  if (message === 'GitHub is not connected') return { health: 'not_connected', message: 'Connect GitHub to read these tasks.' }
  if (error instanceof GitHubReauthRequiredError) return { health: 'reconnect', message }
  const graphql = graphqlErrorsSchema.safeParse(error)
  const errorTypes = graphql.success ? graphql.data.errors.map((entry) => entry.type) : []
  if (errorTypes.includes('INSUFFICIENT_SCOPES')) {
    return { health: 'reconnect', message: 'Connect GitHub again to give Solus the permission that GitHub Projects need.' }
  }
  if (errorTypes.includes('FORBIDDEN') || errorTypes.includes('NOT_FOUND')) return { health: 'no_access', message }
  const status = error instanceof JiraRequestError ? error.status : statusSchema.safeParse(error).data?.status
  if (status === 401) return { health: 'reconnect', message }
  if (status === 403 || status === 404) return { health: 'no_access', message }
  return { health: 'error', message }
}

/**
 * The error a failed task write gives its caller. A connection problem carries
 * the marker that lets a client offer to connect the provider.
 */
export function taskWriteError<Failure>(error: Failure): Error {
  const { health, message } = classifyProviderFailure(error)
  if (health !== 'not_connected' && health !== 'reconnect') return error instanceof Error ? error : new Error(message)
  return new Error(message.startsWith(TASKS_AUTH_ERROR_PREFIX) ? message : `${TASKS_AUTH_ERROR_PREFIX}${message}`)
}
