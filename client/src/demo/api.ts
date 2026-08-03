import { RPC_INVOKE_METHODS } from '../../../src/shared/rpc'
import type { DemoBackend } from './server'

export function createDemoSolusApi(backend: DemoBackend): Window['solus'] {
  const api: Record<string, unknown> = {
    getPlatform: () => 'web',
    getPathForFile: () => '',
    setQuoteContext: () => {},
    onQuoteSelection: () => () => {},
    onAskSelectionInNewSession: () => () => {},
  }

  for (const method of RPC_INVOKE_METHODS) {
    api[method] = (...args: unknown[]) => backend.handle(method, args)
  }

  api.transcribeAudio = async () => ''
  api.attachFiles = async () => null
  api.uploadFiles = async () => null

  return api as unknown as Window['solus']
}
