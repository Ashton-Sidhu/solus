import { sql } from 'drizzle-orm'
import { getDatabase } from '../db/database'
import { PermanentApplyError } from '../outbox/outbox-store'
import {
  insightsMirrorPayloadSchema,
  transcriptMirrorPayloadSchema,
  type InsightsMirrorPayload,
  type RunnerMirrorItem,
  type TranscriptMirrorPayload,
} from '../server/uplink/runner-protocol'
import { insightLogEvents, insightSpans, sessionTranscripts } from './schema'

/**
 * Where a runner's mirrored items land on the workspace service
 * (docs/plans/cloud-service-model.md §6). Each sink is idempotent by the item's
 * own key — a transcript row by its position, a span by its id, a log event by
 * the runner's event id — so a redelivery writes the same row again. A payload
 * the schema does not accept is a `PermanentApplyError`: the stream moves past
 * it, because the runner would only send the same bytes again.
 */

export interface MirrorOrigin {
  organizationId: string
  /** The runner the item came from; part of every key, so two runners never collide. */
  hostId: string
}

async function applyTranscript(origin: MirrorOrigin, payload: TranscriptMirrorPayload): Promise<void> {
  const db = getDatabase()
  if ('truncateFrom' in payload) {
    await db.run(sql`
      DELETE FROM ${sessionTranscripts}
      WHERE organization_id = ${origin.organizationId} AND session_id = ${payload.sessionId} AND position >= ${payload.truncateFrom}
    `)
    return
  }
  await db.run(sql`
    INSERT INTO ${sessionTranscripts} (organization_id, session_id, position, runner_host_id, message, updated_at)
    VALUES (${origin.organizationId}, ${payload.sessionId}, ${payload.position}, ${origin.hostId}, ${JSON.stringify(payload.message ?? null)}, ${Date.now()})
    ON CONFLICT (organization_id, session_id, position) DO UPDATE SET
      runner_host_id = excluded.runner_host_id, message = excluded.message, updated_at = excluded.updated_at
  `)
}

async function applyInsights(origin: MirrorOrigin, payload: InsightsMirrorPayload): Promise<void> {
  const db = getDatabase()
  const { span, events } = payload
  await db.run(sql`
    INSERT INTO ${insightSpans} (
      organization_id, host_id, span_id, parent_span_id, trace_id, kind, name, service,
      session_id, provider, model, project_root, origin, started_at, ended_at, duration_ms, status, attrs
    ) VALUES (
      ${origin.organizationId}, ${origin.hostId}, ${span.spanId}, ${span.parentSpanId ?? null}, ${span.traceId}, ${span.kind}, ${span.name}, ${span.service},
      ${span.sessionId ?? null}, ${span.provider ?? null}, ${span.model ?? null}, ${span.projectRoot ?? null}, ${span.origin ?? null},
      ${span.startedAt}, ${span.endedAt}, ${span.endedAt - span.startedAt}, ${span.status}, ${JSON.stringify(span.attrs ?? {})}
    )
    ON CONFLICT (organization_id, host_id, span_id) DO UPDATE SET
      parent_span_id = excluded.parent_span_id, trace_id = excluded.trace_id, kind = excluded.kind, name = excluded.name,
      service = excluded.service, session_id = excluded.session_id, provider = excluded.provider, model = excluded.model,
      project_root = excluded.project_root, origin = excluded.origin, started_at = excluded.started_at, ended_at = excluded.ended_at,
      duration_ms = excluded.duration_ms, status = excluded.status, attrs = excluded.attrs
  `)
  for (const event of events) {
    await db.run(sql`
      INSERT INTO ${insightLogEvents} (organization_id, host_id, event_id, trace_id, span_id, occurred_at, level, name, tag, file, attrs)
      VALUES (
        ${origin.organizationId}, ${origin.hostId}, ${event.eventId}, ${event.traceId}, ${event.spanId}, ${event.occurredAt},
        ${event.level}, ${event.name}, ${event.tag}, ${event.file}, ${JSON.stringify(event.attrs ?? {})}
      )
      ON CONFLICT (organization_id, host_id, event_id) DO UPDATE SET
        trace_id = excluded.trace_id, span_id = excluded.span_id, occurred_at = excluded.occurred_at, level = excluded.level,
        name = excluded.name, tag = excluded.tag, file = excluded.file, attrs = excluded.attrs
    `)
  }
}

/** Lands one mirrored item in its organization. Throws `PermanentApplyError` for a payload the domain's schema refuses. */
export async function applyMirrorItem(origin: MirrorOrigin, item: Pick<RunnerMirrorItem, 'domain' | 'payload'>): Promise<void> {
  const { domain, payload } = item
  switch (domain) {
    case 'transcripts': {
      const parsed = transcriptMirrorPayloadSchema.safeParse(payload)
      if (!parsed.success) throw new PermanentApplyError(`Malformed transcript mirror payload: ${parsed.error.message}`)
      return applyTranscript(origin, parsed.data)
    }
    case 'insights': {
      const parsed = insightsMirrorPayloadSchema.safeParse(payload)
      if (!parsed.success) throw new PermanentApplyError(`Malformed insights mirror payload: ${parsed.error.message}`)
      return applyInsights(origin, parsed.data)
    }
  }
}
