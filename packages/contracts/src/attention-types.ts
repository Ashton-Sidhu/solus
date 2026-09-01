// Server-side "attention" model — per-session needs-attention state that
// outlives any connected client. Powers future notifications/inbox surfaces.
// The control plane feeds status transitions in; clients read the active
// entries via `listAttention` and stay live off the `attention-changed` topic.

export type AttentionKind = 'needs_approval' | 'question' | 'finished' | 'failed'

export interface AttentionEntry {
  sessionId: string
  kind: AttentionKind
  /** Epoch ms when this attention state began (stable while the kind persists). */
  since: number
  /** Short human-readable summary of what needs attention. */
  summary: string
  /** Best-effort project/repo the session belongs to (for grouping/notifications). */
  projectKey?: string
  /** Reserved: which device resolved this entry. Unused today; kept for the
   *  forthcoming inbox/notification workstream (F2). */
  resolvedBy?: string
}
