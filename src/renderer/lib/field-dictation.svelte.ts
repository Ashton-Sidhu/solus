import { onDestroy } from 'svelte'
import { getVoiceModelStore } from '../contexts/voice-model.store.svelte'
import { dictation, isDictationTarget, type DictationTarget } from './dictation.svelte'

export type FieldSubmitKey = 'enter' | 'mod-enter'

interface FieldDictationOptions {
  getRef: () => DictationTarget | null
  getDisabled: () => boolean
  getEnabled: () => boolean
  getOnSubmit: () => (() => void) | undefined
  getSubmitOn: () => FieldSubmitKey | undefined
  getVadMinSpeechMs: () => number
  getOnkeydown: () => ((event: KeyboardEvent) => void) | undefined
  getOnfocus: () => ((event: FocusEvent) => void) | undefined
  getOnblur: () => ((event: FocusEvent) => void) | undefined
}

export function createFieldDictation(options: FieldDictationOptions) {
  const voiceModel = getVoiceModelStore()

  $effect(() => {
    const ref = options.getRef()
    if (!options.getEnabled() || !ref) return
    dictation.registerSubmit(ref, options.getOnSubmit())
    dictation.registerVadMinSpeechMs(ref, options.getVadMinSpeechMs())
    return () => dictation.unregisterSubmit(ref)
  })

  onDestroy(() => {
    const ref = options.getRef()
    if (ref) dictation.releaseTarget(ref)
  })

  function handleKeydown(event: KeyboardEvent): void {
    options.getOnkeydown()?.(event)
    const submitOn = options.getSubmitOn()
    const onSubmit = options.getOnSubmit()
    if (event.defaultPrevented || !submitOn || !onSubmit) return
    if (event.key !== 'Enter' || event.isComposing) return
    const mod = event.metaKey || event.ctrlKey
    if (submitOn === 'mod-enter' ? mod : !event.shiftKey && !mod && !event.altKey) {
      event.preventDefault()
      onSubmit()
    }
  }

  function handleFocus(event: FocusEvent): void {
    const ref = options.getRef()
    if (options.getEnabled() && ref && isDictationTarget(ref)) dictation.focusGained(ref)
    options.getOnfocus()?.(event)
  }

  function handleBlur(event: FocusEvent): void {
    const ref = options.getRef()
    if (options.getEnabled() && ref) dictation.focusLost(ref)
    options.getOnblur()?.(event)
  }

  return {
    get micState() {
      const ref = options.getRef()
      return options.getEnabled() && dictation.target === ref ? dictation.state : 'idle'
    },
    get micDisabled() {
      return options.getDisabled() || !voiceModel.ready
    },
    get idleMicTooltip() {
      if (voiceModel.ready) return 'Voice input'
      if (voiceModel.status.state === 'downloading' && voiceModel.progressPct !== null) {
        return `Downloading voice model - ${voiceModel.progressPct}%`
      }
      if (voiceModel.status.state === 'error') return 'Voice model failed to download - retry in Settings'
      return 'Voice model is preparing'
    },
    get progressPct() {
      return voiceModel.ready ? null : voiceModel.progressPct
    },
    get rmsRef() {
      return dictation.rmsRef
    },
    handleKeydown,
    handleFocus,
    handleBlur,
    toggle() {
      const ref = options.getRef()
      if (ref) dictation.toggleInto(ref)
    },
    confirm() {
      dictation.stop()
    },
    cancel() {
      dictation.cancel()
    },
  }
}
