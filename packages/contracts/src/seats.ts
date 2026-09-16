/**
 * Provider seats — one member's own Claude or Codex login on a shared host
 * (docs/plans/multiplayer-sharing.md §5; Step 2 plan). Every agent turn runs under
 * the seat of the person who wrote the prompt. The host owns the credential files;
 * the cloud never sees them. Zod is the contract so the clients, the Lab, and the
 * host decode one shape.
 */

import { z } from 'zod'

export const seatProviderSchema = z.enum(['claude-code', 'codex'])
export type SeatProvider = z.infer<typeof seatProviderSchema>

export const SEAT_PROVIDERS: readonly SeatProvider[] = seatProviderSchema.options

/**
 * `none`: no credential for this member. `connecting`: a relayed sign-in is waiting
 * on the member's browser. `connected`: a turn can run. `expired`: the provider
 * refused the credential during a turn; reconnect to continue.
 */
export const seatStateSchema = z.enum(['none', 'connecting', 'connected', 'expired'])
export type SeatState = z.infer<typeof seatStateSchema>

export const seatStatusSchema = z.object({
  provider: seatProviderSchema,
  state: seatStateSchema,
  /** How the credential was connected: a relayed browser login or a pasted token. */
  method: z.enum(['login', 'token']).optional(),
  /** False for a pasted inference-only token: the usage meter cannot read this seat. */
  usageCapable: z.boolean(),
  connectedAt: z.number().optional(),
  /** Why the last connect attempt ended without a seat. */
  error: z.string().optional(),
  /** The host's own login, which the owner's turns run on: it is signed in through the CLI, never disconnected from Solus. */
  hostLogin: z.boolean().optional(),
})
export type SeatStatus = z.infer<typeof seatStatusSchema>

export const seatProviderRequestSchema = z.object({ provider: seatProviderSchema }).strict()
export type SeatProviderRequest = z.infer<typeof seatProviderRequestSchema>

/** `seatConnectStart` answers once the provider CLI has printed where to sign in. */
export const seatConnectStartResultSchema = z.object({
  verificationUrl: z.string().min(1),
  /** Present for a device-code flow (Codex). Claude asks for a code from the browser instead. */
  userCode: z.string().optional(),
  /** True when the browser hands back a code the member must paste into Solus. */
  requiresCodeInput: z.boolean(),
})
export type SeatConnectStartResult = z.infer<typeof seatConnectStartResultSchema>

export const seatConnectCodeRequestSchema = z.object({
  provider: seatProviderSchema,
  code: z.string().min(1).max(4096),
}).strict()
export type SeatConnectCodeRequest = z.infer<typeof seatConnectCodeRequestSchema>

/**
 * `seatConnectToken`: a credential the member made elsewhere. Claude: the output of
 * `claude setup-token` (inference-only, so no usage meter). Codex: the contents of
 * the member's `auth.json`.
 */
export const seatConnectTokenRequestSchema = z.object({
  provider: seatProviderSchema,
  token: z.string().min(1).max(65536),
}).strict()
export type SeatConnectTokenRequest = z.infer<typeof seatConnectTokenRequestSchema>

/** `seatRemove` (host administrator): every seat of a member, or one provider's. */
export const seatRemoveRequestSchema = z.object({
  userId: z.string().min(1),
  provider: seatProviderSchema.optional(),
}).strict()
export type SeatRemoveRequest = z.infer<typeof seatRemoveRequestSchema>

/** Sent to the member whose seat changed; other clients never hear it. */
export interface SeatChangedEvent {
  userId: string
  provider: SeatProvider
  state: SeatState
  error?: string
}

/** The refusal a prompt gets when its author has no seat for the session's provider. */
export const SEAT_REQUIRED_CODE = 'SEAT_REQUIRED'
