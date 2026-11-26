import type { z } from 'zod'
import type { AgentId, PluginCommandsResult } from '@solus/contracts/types'
import type { TurnSeat } from '../../seats/seat-manager'
import type { AgentRunRequest } from '../agent-runner'
import type { AcpInitializeResult, AcpStopReason, AcpToolCall } from './acp-protocol'
import type { AcpChildCalls, AcpPlanTool, AcpStepsTool, AcpToolNamer } from './acp-turn-normalizer'

type JsonValue = z.core.util.JSONType

/** How the backend starts one agent process. */
export interface AcpAgentLaunch {
  file: string
  args: string[]
  env: NodeJS.ProcessEnv
  /** Two runs with the same key may share a connection: same binary, profile, and credential. */
  connectionKey: string
  /** The ACP `authenticate` method to call after `initialize`, when the agent offers it. */
  authMethod: string | null
  /**
   * Where each process gets its own temp folder, which Solus removes when the
   * process exits. Null: the process uses the host's temp folder.
   */
  tempRoot: string | null
  /** The agent profile the process runs in; a Solus thread maps to one agent session in each (`acp-thread-places.ts`). */
  place?: string
}

/**
 * What one ACP agent adds to the generic backend (decision 2): how to start
 * it, how it names its tools, and how it says that it needs a sign-in.
 */
export interface AcpAgent {
  readonly id: AgentId
  readonly label: string
  launch(request: Pick<AgentRunRequest, 'seat' | 'providerRuntime'>): AcpAgentLaunch
  /** The `_meta` of `session/new`, which can carry Solus's instructions. */
  sessionMeta(initializeResult: JsonValue | undefined, systemPrompt: string | undefined): JsonValue | undefined
  readonly nameTool: AcpToolNamer
  /** Whether a tool call titled so is the agent's read of a file through `fs/read_text_file`. */
  isClientRead?(title: string): boolean
  /** The tool that carries the agent's checklist, when it reports one that way. */
  readonly stepsTool?: AcpStepsTool
  /** The call that writes the plan in plan mode, when the agent writes it as a file. */
  readonly planTool?: AcpPlanTool
  /** Where the calls of the agent's subagents go, for one session. */
  childCalls?(request: AgentRunRequest, threadId: string): AcpChildCalls
  /** Whether a place holds the agent session; false sends the thread there by handoff. */
  hasThread?(place: string, agentSessionId: string): boolean
  /** A call that leaves work running after its prompt answers, such as a recurring schedule: the connection then stays open. */
  startsDaemon?(toolCall: AcpToolCall): boolean
  isSignInRequired(error: Error): boolean
  /** A permission request that is really a question for the person. */
  isQuestion(toolCallId: string): boolean
  /** Whether a `session/prompt` sent during a turn joins that turn (decision 4). */
  steersWithPrompt(initialize: AcpInitializeResult): boolean
  /** The agent's skills for the slash menu, in a folder and for a seat (the host login's when absent). */
  listCommands(workingDirectory: string, seat: TurnSeat | undefined): PluginCommandsResult
  /** What a person reads when the agent needs a sign-in. */
  readonly signInMessage: string
  /** The name the Solus MCP server has in `session/new`. */
  readonly mcpServerName: string
  /**
   * Called before a turn's first prompt. The check it gives reads, after the
   * turn, an error the agent reported as an answer. Absent: the stop reason is
   * the whole answer.
   */
  watchTurnOutcome?(request: AgentRunRequest, threadId: string): AcpTurnOutcomeCheck
}

/** A turn that ended on an error the agent reported as an answer. */
export interface AcpTurnFailure {
  message: string
  code: string | null
  /** Set when the account reached a limit: the run parks as a rate limit. `resetsAt` is in epoch seconds. */
  usageLimit: { resetsAt: number | null } | null
}

/** Reads, after the turn, how it ended. Null: as its stop reason says. */
export type AcpTurnOutcomeCheck = (stopReason: AcpStopReason) => AcpTurnFailure | null
