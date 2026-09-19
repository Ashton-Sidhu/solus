import { typeSafeApiKey } from './credentials'
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
  const apiKey = (config.apiKey ?? process.env.TYPESAFE_API_KEY)?.trim()
  if (!apiKey) throw new TypeSafeError('Set TYPESAFE_API_KEY on the host before using TypeSafe.')
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

let sharedClient: TypeSafeApi | undefined
let sharedKey: string | undefined

/** Lazy host client: importing the module does not require a key or make a request. */
export function getTypeSafe(): TypeSafeApi {
  const apiKey = typeSafeApiKey()
  if (!apiKey) {
    sharedClient = undefined
    sharedKey = undefined
    throw new TypeSafeError('Add a TypeSafe API key in Settings → Tools.')
  }
  if (!sharedClient || sharedKey !== apiKey) {
    sharedClient = createTypeSafe({ apiKey })
    sharedKey = apiKey
  }
  return sharedClient
}
