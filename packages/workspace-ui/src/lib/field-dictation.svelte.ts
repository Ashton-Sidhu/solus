import { onDestroy } from 'svelte'
import { hosts } from '../contexts/hosts/hosts.svelte'
import { dictation, isDictationTarget, type DictationTarget } from './dictation.svelte'
import { comboHint } from './keybindings/manifest'

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
  // A surface with no host to transcribe (a page on the account site) has no
  // voice model: the field types like any other, with no mic and no dictation target.
  const voiceHost = $derived(hosts.transcription)
  const enabled = () => voiceHost !== null && options.getEnabled()

  $effect(() => {
    const ref = options.getRef()
    if (!enabled() || !ref) return
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
    if (enabled() && ref && isDictationTarget(ref)) dictation.focusGained(ref)
    options.getOnfocus()?.(event)
  }

  function handleBlur(event: FocusEvent): void {
    const ref = options.getRef()
    if (enabled() && ref) dictation.focusLost(ref)
    options.getOnblur()?.(event)
  }

  return {
    get micState() {
      const ref = options.getRef()
      return enabled() && dictation.target === ref ? dictation.state : 'idle'
    },
    /** False with no voice model, or on a host with no transcription backend: hide the mic and reclaim its gutter. */
    get micVisible() {
      return voiceHost?.transcribes ?? false
    },
    get micDisabled() {
      return options.getDisabled() || !voiceHost?.voiceReady
    },
    get idleMicTooltip() {
      if (!voiceHost) return ''
      if (voiceHost.voiceReady) return `Voice input (${comboHint('voice.toggle-recorder')})`
      if (voiceHost.voiceStatus.state === 'downloading' && voiceHost.voiceProgressPct !== null) {
        return `Downloading voice model - ${voiceHost.voiceProgressPct}%`
      }
      if (voiceHost.voiceStatus.state === 'error') return 'Voice model failed to download - retry in Settings'
      return 'Voice model is preparing'
    },
    get progressPct() {
      return !voiceHost || voiceHost.voiceReady ? null : voiceHost.voiceProgressPct
    },
    get rmsRef() {
      return dictation.rmsRef
    },
    handleKeydown,
    handleFocus,
    handleBlur,
    toggle() {
      const ref = options.getRef()
      if (enabled() && ref) dictation.toggleInto(ref)
    },
    confirm() {
      dictation.stop()
    },
    cancel() {
      dictation.cancel()
    },
  }
}
