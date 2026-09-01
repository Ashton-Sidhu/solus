import type { Logger } from '../logger'

export interface AdapterCliFallbackOptions<Result> {
  operation: string
  log: Logger
  adapter: (() => Promise<Result>) | null
  cli: () => Promise<Result>
}

/**
 * Prefer the connected provider adapter, then use the provider CLI when the
 * adapter is unavailable or rejects the operation. Both attempts are logged at
 * this one boundary so callers cannot silently invent different fallback rules.
 */
export async function withAdapterCliFallback<Result>(
  options: AdapterCliFallbackOptions<Result>,
): Promise<Result> {
  let adapterErrorMessage: string | null = null
  if (options.adapter) {
    options.log.debug('provider_adapter_attempted', { operation: options.operation })
    try {
      const result = await options.adapter()
      options.log.info('provider_adapter_succeeded', { operation: options.operation })
      return result
    } catch (error) {
      adapterErrorMessage = error instanceof Error ? error.message : String(error)
      options.log.warn('provider_adapter_failed', {
        operation: options.operation,
        error: adapterErrorMessage,
      })
    }
  } else {
    options.log.debug('provider_adapter_unavailable', { operation: options.operation })
  }

  options.log.info('provider_cli_fallback_attempted', { operation: options.operation })
  try {
    const result = await options.cli()
    options.log.info('provider_cli_fallback_succeeded', { operation: options.operation })
    return result
  } catch (cliError) {
    const cliErrorMessage = cliError instanceof Error ? cliError.message : String(cliError)
    options.log.error('provider_cli_fallback_failed', {
      operation: options.operation,
      adapterError: adapterErrorMessage,
      cliError: cliErrorMessage,
    })
    if (!adapterErrorMessage) throw cliError
    throw new Error(
      `${options.operation} failed through the provider adapter and CLI. Adapter: ${adapterErrorMessage} CLI: ${cliErrorMessage}`,
      { cause: cliError },
    )
  }
}
