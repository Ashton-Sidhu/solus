import type { WorkspaceError } from '@solus/contracts/solus-api'

export class SolusApiError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 412 | 413 | 429 | 500 | 503,
    readonly code: WorkspaceError['error']['code'],
    message: string,
    readonly retryAfter?: number,
  ) {
    super(message)
    this.name = 'SolusApiError'
  }
}
