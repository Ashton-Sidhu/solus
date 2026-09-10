import { z } from 'zod'

/** Increment storageEpoch when a file-format change makes binary rollback unsafe. */
export const SERVER_UPDATE_PROTOCOL = 1
export const SERVER_STORAGE_EPOCH = 1
export const serverReleaseManifestSchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  protocol: z.literal(SERVER_UPDATE_PROTOCOL),
  storage: z.string(),
})
export const serverUpdateOperationSchema = z.object({
  operationId: z.uuid(),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  phase: z.enum(['waiting', 'downloading', 'restarting', 'succeeded', 'failed', 'cancelled']),
  message: z.string().optional(),
})
export type ServerUpdateOperation = z.infer<typeof serverUpdateOperationSchema>
export interface ServerUpdateSupport {
  supported: boolean
  reason: string | null
  operation: ServerUpdateOperation | null
}
export const supervisorMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('solus:update'), operation: serverUpdateOperationSchema }),
  z.object({ type: z.literal('solus:update-status'), support: z.object({ supported: z.boolean(), reason: z.string().nullable(), operation: serverUpdateOperationSchema.nullable() }) }),
  z.object({ type: z.literal('solus:stop-for-update'), operationId: z.string() }),
  z.object({ type: z.literal('solus:drained'), operationId: z.string() }),
  z.object({ type: z.literal('solus:cancel-update'), operationId: z.string() }),
  z.object({ type: z.literal('solus:ready'), version: z.string() }),
])
export type SupervisorMessage = z.infer<typeof supervisorMessageSchema>
export function isServerUpdateActive(operation: ServerUpdateOperation | null | undefined): boolean {
  return operation?.phase === 'waiting' || operation?.phase === 'downloading' || operation?.phase === 'restarting'
}
