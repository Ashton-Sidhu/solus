import type { IpcContext } from '../../../../shared/types'

/**
 * `providerConnect` only reads the session's directory, to pick a provider for
 * that repo's host. There is no session on the host being prepared, so an empty
 * directory is passed deliberately: the handler then falls back to GitHub.
 */
export function hostProviderContext(): IpcContext {
  return { session: { projectPath: '', workingDirectory: '' } } as unknown as IpcContext
}

/** A host RPC failure as the one line a setup surface shows for it. */
export function messageFor(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
