import { typeSafeKey } from './credentials'
import { TypeSafeClient, TypeSafeError, type TypeSafeClientConfig } from '@typesafe-ai/sdk'

// Keep SDK imports here. Features use this module for questions, calls, and errors.
export {
  choice, noul, score,
  TypeSafeError, APIError, APIConnectionError, APITimeoutError, APIUserAbortError,
  AuthenticationError, BadRequestError, PermissionDeniedError, NotFoundError,
  UnprocessableEntityError, RateLimitError, InternalServerError,
} from '@typesafe-ai/sdk'
export type {
  ChoiceQuestion, ChoiceResponse, NoulQuestion, NoulResponse, ScoreQuestion,
  ScoreResponse, Question, Questions, SystemOneRequest, SystemOneResult,
  ModelCard, Usage, RequestOptions, WithResponse,
} from '@typesafe-ai/sdk'

/** Server configuration only; credentials must never be returned through the client RPC boundary. */
export type TypeSafeConfig = Pick<TypeSafeClientConfig,
  'apiKey' | 'baseURL' | 'defaultModel' | 'timeout' | 'retry' | 'fetch'>

/** Preserve SDK inference and response metadata without exposing its transport. */
export type TypeSafeApi = Pick<TypeSafeClient, 'systemOne' | 'models'>

/** Create an isolated client for an explicit configuration or an injected test transport. */
export function createTypeSafe(config: TypeSafeConfig = {}): TypeSafeApi {
  const apiKey = config.apiKey?.trim()
  if (!apiKey) throw new TypeSafeError('A TypeSafe client needs an API key.')
  return new TypeSafeClient({
    ...config,
    apiKey,
    timeout: config.timeout ?? 10_000,
    retry: { maxRetries: 2, ...config.retry },
    // SDK debug logging includes state and question bodies. Keep it off even if
    // TYPESAFE_LOG_LEVEL is set in the host environment.
    logLevel: 'off',
    dangerouslyAllowBrowser: false,
  })
}

/** The acting person has no TypeSafe key. Its message says where to add one and carries no credential. */
export class TypeSafeKeyMissingError extends TypeSafeError {}

const MISSING_KEY = {
  host: 'Add a TypeSafe API key in Settings → Tools.',
  account: 'Add your TypeSafe key in your Solus account.',
  none: 'Ask Jev needs your own TypeSafe key, and a guest has none on this host.',
} as const

/** The acting person's client (docs/plans/access-model.md §2.6): their own key, never the host's. */
export async function getTypeSafe(): Promise<TypeSafeApi> {
  const key = await typeSafeKey()
  if (!key.apiKey) throw new TypeSafeKeyMissingError(MISSING_KEY[key.location])
  return createTypeSafe({ apiKey: key.apiKey })
}
