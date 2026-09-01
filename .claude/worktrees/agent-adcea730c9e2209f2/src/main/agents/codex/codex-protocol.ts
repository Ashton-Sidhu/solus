import type {
  ClientRequest,
  InitializeResponse,
  RequestId,
  ServerNotification,
  ServerRequest,
} from './generated'
import type {
  DynamicToolSpec,
  ModelListResponse,
  SkillsExtraRootsSetResponse,
  SkillsListResponse,
  ThreadForkParams,
  ThreadForkResponse,
  ThreadGoalClearResponse,
  ThreadGoalGetResponse,
  ThreadGoalSetParams,
  ThreadGoalSetResponse,
  ThreadListResponse,
  ThreadReadResponse,
  ThreadResumeParams,
  ThreadResumeResponse,
  ThreadStartParams,
  ThreadStartResponse,
  TurnInterruptResponse,
  TurnStartParams,
  TurnStartResponse,
} from './generated/v2'

export type JsonRpcId = RequestId
export type CodexServerNotification = ServerNotification
export type CodexServerRequest = ServerRequest
export type CodexClientMethod = ClientRequest['method']

export type CodexClientParams<M extends CodexClientMethod> =
  Extract<ClientRequest, { method: M }>['params']

export interface JsonRpcResponse {
  jsonrpc?: '2.0'
  id: JsonRpcId
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export type JsonRpcRequest = CodexServerRequest & { jsonrpc?: '2.0' }
export type JsonRpcNotification = CodexServerNotification & { jsonrpc?: '2.0' }
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse

export type CodexThreadStartResponse = ThreadStartResponse
export type CodexThreadResumeResponse = ThreadResumeResponse
export type CodexThreadForkResponse = ThreadForkResponse
export type CodexTurnStartResponse = TurnStartResponse
export type CodexThreadListResponse = ThreadListResponse
export type CodexThreadReadResponse = ThreadReadResponse
export type CodexModelListResponse = ModelListResponse
export type CodexSkillsListResponse = SkillsListResponse
export type CodexThreadGoalResponse = ThreadGoalGetResponse | ThreadGoalSetResponse
export type CodexThreadGoalClearResponse = ThreadGoalClearResponse

export type CodexDynamicTool = Omit<Extract<DynamicToolSpec, { type: 'function' }>, 'type'>

export type CodexThreadConfigExtras = {
  dynamicTools?: CodexDynamicTool[]
  experimentalRawEvents?: boolean
  persistExtendedHistory?: boolean
  reasoning_effort?: string
}

export type CodexTurnConfigExtras = {
  reasoning_effort?: string
  collaborationMode?: {
    mode: 'default' | 'plan'
    settings: Record<string, unknown>
  }
}

export type CodexThreadStartParams = ThreadStartParams & CodexThreadConfigExtras
export type CodexThreadResumeParams = ThreadResumeParams & CodexThreadConfigExtras
export type CodexThreadForkParams = ThreadForkParams
export type CodexTurnStartParams = TurnStartParams & CodexTurnConfigExtras
export type CodexThreadGoalSetParams = ThreadGoalSetParams

export interface CodexResponseByMethod {
  initialize: InitializeResponse
  'skills/extraRoots/set': SkillsExtraRootsSetResponse
  'thread/start': CodexThreadStartResponse
  'thread/resume': CodexThreadResumeResponse
  'thread/fork': CodexThreadForkResponse
  'thread/list': CodexThreadListResponse
  'thread/read': CodexThreadReadResponse
  'thread/goal/get': ThreadGoalGetResponse
  'thread/goal/set': ThreadGoalSetResponse
  'thread/goal/clear': ThreadGoalClearResponse
  'turn/start': CodexTurnStartResponse
  'turn/interrupt': TurnInterruptResponse
  'skills/list': CodexSkillsListResponse
  'model/list': CodexModelListResponse
}

export type CodexTypedMethod = keyof CodexResponseByMethod
export type CodexResponseFor<M extends CodexTypedMethod> = CodexResponseByMethod[M]
