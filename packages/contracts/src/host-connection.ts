import { z } from 'zod'

/**
 * The parts of the way to a host, in order (docs/plans/host-readiness.md). A host
 * with a tunnel route has all four. A host with only direct routes has `device` and
 * `host`.
 */
export const connectionStageSchema = z.enum(['device', 'cloud', 'tunnel', 'host'])
export type ConnectionStage = z.infer<typeof connectionStageSchema>

/**
 * `failed`: the check ran and did not pass from where it ran. `unknown`: no evidence
 * from where the check ran. A guess is never `ok`.
 */
export const connectionStageResultSchema = z.enum(['ok', 'failed', 'unknown'])
export type ConnectionStageResult = z.infer<typeof connectionStageResultSchema>

export const connectionStageReportSchema = z.object({
  stage: connectionStageSchema,
  label: z.string(),
  result: connectionStageResultSchema,
  /** What was seen at this stage. */
  detail: z.string().nullable(),
})
export type ConnectionStageReport = z.infer<typeof connectionStageReportSchema>

/** Why a host's self-test failed. */
export const hostSelfTestCauseSchema = z.enum([
  'link-rejected',
  'cloud-unreachable',
  'cloudflared-missing',
  'connector-stopped',
  'connector-connecting',
  'edge-blocked',
  'no-connector',
  'origin-unreachable',
  'port-conflict',
  'listener-silent',
  'other-host-answered',
  'unexpected-answer',
  'dns-failed',
  'address-timeout',
  'address-unreachable',
])
export type HostSelfTestCause = z.infer<typeof hostSelfTestCauseSchema>

export const hostSelfTestProblemSchema = z.object({
  stage: connectionStageSchema,
  cause: hostSelfTestCauseSchema,
  reason: z.string(),
  fix: z.string(),
  /** A likely reason for the cause, such as a Tailscale exit node. */
  hint: z.string().nullable(),
})
export type HostSelfTestProblem = z.infer<typeof hostSelfTestProblemSchema>

/**
 * What a host found when it tested its own connection (`hostSelfTest`). The host
 * writes the words, so the CLI and every client show the same text.
 */
export const hostSelfTestSchema = z.object({
  checkedAt: z.number(),
  /** The host's public address answered as this host, from this host. Null: the host has no public address. */
  reachable: z.boolean().nullable(),
  summary: z.string(),
  stages: z.array(connectionStageReportSchema),
  /** Null when no stage failed. */
  problem: hostSelfTestProblemSchema.nullable(),
  facts: z.array(z.object({ label: z.string(), value: z.string() })),
})
export type HostSelfTest = z.infer<typeof hostSelfTestSchema>

const STAGE_RESULT_LABELS = { ok: 'OK', failed: 'Failed', unknown: 'Unknown' } satisfies { [result in ConnectionStageResult]: string }

export function connectionStageResultLabel(result: ConnectionStageResult): string {
  return STAGE_RESULT_LABELS[result]
}

/** One stage as plain text, for the CLI and for a support message. */
export function connectionStageLine(report: ConnectionStageReport): string {
  return `${report.label}: ${STAGE_RESULT_LABELS[report.result]}${report.detail ? ` (${report.detail})` : ''}`
}
