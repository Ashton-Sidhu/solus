<script lang="ts">
  import { MicrophoneIcon, SpinnerGapIcon, XIcon, CheckIcon } from 'phosphor-svelte'
  import { tooltip } from '../../lib/tooltip'
  import WaveformVisualizer from './WaveformVisualizer.svelte'
  import type { VoiceState } from '../../lib/voice-recorder.svelte'

  interface Props {
    /** 'bar' = 36px pill cluster beside the editor (InputBar); 'field' = 24px in-field overlay (Input). */
    variant: 'bar' | 'field'
    state: VoiceState
    rmsRef: { current: number }
    onCancel: () => void
    onConfirm: () => void
    onToggle: () => void
    disabled?: boolean
    /** bar: render the idle mic with the "voice mode waiting" accent treatment. */
    waiting?: boolean
    /** bar: tooltip for the idle mic. */
    idleTooltip?: string
    /** field: whether to render the idle mic at all (the host's `mic` prop). */
    showMic?: boolean
    /** field: top-align the mic for a textarea rather than vertically centering it. */
    micTextarea?: boolean
  }

  let {
    variant,
    state,
    rmsRef,
    onCancel,
    onConfirm,
    onToggle,
    disabled = false,
    waiting = false,
    idleTooltip = 'Voice input (⌥⇧K)',
    showMic = true,
    micTextarea = false,
  }: Props = $props()
</script>

{#if variant === 'bar'}
  {#if state === 'recording'}
    <div class="flex items-center gap-1">
      <button
        onmousedown={(e) => e.preventDefault()}
        onclick={onCancel}
        class="w-9 h-9 rounded-full flex items-center justify-center transition-colors bg-(--solus-surface-hover) text-(--solus-text-tertiary)"
        use:tooltip={"Cancel recording"}
      ><XIcon size={15} weight="bold" /></button>
      <button
        onmousedown={(e) => e.preventDefault()}
        onclick={onConfirm}
        class="w-9 h-9 rounded-full flex items-center justify-center transition-colors bg-(--solus-accent) text-(--solus-text-on-accent)"
        use:tooltip={"Confirm recording"}
      ><CheckIcon size={15} weight="bold" /></button>
    </div>
  {:else if state === 'transcribing'}
    <button
      disabled
      class="w-9 h-9 rounded-full flex items-center justify-center bg-(--solus-mic-bg) text-(--solus-mic-color)"
    ><SpinnerGapIcon size={16} class="animate-spin" /></button>
  {:else}
    <button
      onmousedown={(e) => e.preventDefault()}
      onclick={onToggle}
      {disabled}
      class="w-9 h-9 rounded-full flex items-center justify-center transition-colors"
      style="background:{waiting
        ? 'var(--solus-accent)'
        : 'var(--solus-mic-bg)'};color:{disabled
        ? 'var(--solus-mic-disabled)'
        : waiting
          ? 'var(--solus-text-on-accent)'
          : 'var(--solus-mic-color)'};opacity:{disabled ? 0.4 : 1}"
      use:tooltip={idleTooltip}
    ><MicrophoneIcon size={16} /></button>
  {/if}
{:else if state === 'recording'}
  <span class="rc-row">
    <span class="rc-waveform">
      <WaveformVisualizer {rmsRef} color="var(--solus-accent)" />
    </span>
    <button
      type="button"
      class="rc-action-btn"
      onmousedown={(e) => e.preventDefault()}
      onclick={onCancel}
      use:tooltip={"Cancel recording"}
      aria-label="Cancel recording"
    ><XIcon size={13} weight="bold" /></button>
    <button
      type="button"
      class="rc-action-btn rc-action-btn--confirm"
      onmousedown={(e) => e.preventDefault()}
      onclick={onConfirm}
      use:tooltip={"Confirm recording"}
      aria-label="Confirm recording"
    ><CheckIcon size={13} weight="bold" /></button>
  </span>
{:else if state === 'transcribing'}
  <button
    type="button"
    class="rc-mic"
    class:rc-mic--textarea={micTextarea}
    disabled
    aria-label="Transcribing…"
  ><SpinnerGapIcon size={14} class="animate-spin" /></button>
{:else if showMic}
  <button
    type="button"
    class="rc-mic"
    class:rc-mic--textarea={micTextarea}
    {disabled}
    onmousedown={(e) => e.preventDefault()}
    onclick={onToggle}
    use:tooltip={idleTooltip}
    aria-label="Voice input"
  ><MicrophoneIcon size={14} /></button>
{/if}

<style>
  /* field variant: absolute overlay row shown while recording, positioned
     against the host's relative .inp-mic-wrap. */
  .rc-row {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0 0.375rem;
    overflow: hidden;
  }
  .rc-waveform {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
  }

  /* field action buttons (X / ✓) shown while recording */
  .rc-action-btn {
    flex-shrink: 0;
    width: 1.5rem;
    height: 1.5rem;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    background: var(--solus-surface-hover);
    color: var(--solus-text-tertiary);
    cursor: pointer;
    transition:
      background var(--duration-base) var(--ease-premium),
      color var(--duration-base) var(--ease-premium);
  }
  .rc-action-btn:hover {
    background: var(--solus-surface-active);
    color: var(--solus-text-primary);
  }
  .rc-action-btn--confirm {
    background: var(--solus-accent);
    color: var(--solus-text-on-accent);
  }
  .rc-action-btn--confirm:hover {
    opacity: 0.88;
  }

  /* field idle / transcribing mic button */
  .rc-mic {
    position: absolute;
    right: 0.25rem;
    top: 50%;
    transform: translateY(-50%);
    width: 1.5rem;
    height: 1.5rem;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    background: transparent;
    color: var(--solus-mic-color);
    cursor: pointer;
    transition:
      background var(--duration-base) var(--ease-premium),
      color var(--duration-base) var(--ease-premium);
  }
  .rc-mic--textarea {
    top: 0.375rem;
    transform: none;
  }
  .rc-mic:hover:not(:disabled) {
    background: var(--solus-mic-bg);
  }
  .rc-mic:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
