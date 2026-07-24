import { RPC_INVOKE_METHODS } from '../../../src/shared/rpc'
import type { RpcTopic } from '../../../src/shared/rpc'
import type { DemoBackend } from './server'

type Listener = (...payload: unknown[]) => void

export function createDemoSolusApi(backend: DemoBackend): Window['solus'] {
  const api: Record<string, unknown> = {
    getPlatform: () => 'web',
    getPathForFile: () => '',
    setQuoteContext: () => {},
    onQuoteSelection: () => () => {},
  }

  for (const method of RPC_INVOKE_METHODS) {
    api[method] = (...args: unknown[]) => backend.handle(method, args)
  }

  api.transcribeAudio = async () => ''
  api.attachFiles = async () => null
  api.uploadFiles = async () => null

  const on = (topic: RpcTopic) => (callback: Listener) => backend.subscribe(topic, callback)
  api.onEvent = on('normalized-event')
  api.onError = on('enriched-error')
  api.onSkillStatus = on('skill-status')
  api.onThemeChange = on('theme-changed')
  api.onEnterDesignMode = on('enter-design-mode')
  api.onWindowShown = on('window-shown')
  api.onWindowHidden = on('window-hidden')
  api.onSessionScan = on('session-scan')
  api.onSessionIndexUpdated = on('session-index-updated')
  api.onReviewProgress = on('review-progress')
  api.onRunStatus = on('run-status')
  api.onRunLog = on('run-log')
  api.onVoiceModelStatus = on('voice-model-status')
  api.onSetupStatus = on('setup-status')
  api.onSetupLog = on('setup-log')
  api.onAutomationsChanged = on('automations-changed')
  api.onProviderDeviceCode = on('provider-device-code')
  api.onTasksChanged = on('tasks-changed')
  api.onPrsChanged = on('prs-changed')
  api.onAttentionChanged = on('attention-changed')

  let resetRuntimeCallback: (() => void) | null = null
  api.onResetRuntime = (callback: () => void) => {
    resetRuntimeCallback = callback
    return () => {
      if (resetRuntimeCallback === callback) resetRuntimeCallback = null
    }
  }

  return api as unknown as Window['solus']
}
