<script lang="ts">
  import {
    Mic as MicrophoneIcon,
    LoaderCircle as SpinnerGapIcon,
  } from "@lucide/svelte";
  import * as TooltipUI from "@solus/workspace-ui/components/ui/tooltip";
  import WaveformVisualizer from './WaveformVisualizer.svelte'
  import type { VoiceState } from '../../lib/voice-recorder.svelte'

  interface Props {
    /** 'bar' = 30px composer controls (InputBar, prompt composer); 'field' = 24px in-field overlay (Input). */
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
    /** Whether to render the idle mic. Active recording state always renders. */
    showMic?: boolean
    /** field: align the mic on the textarea's first line rather than on the whole box. */
    micTextarea?: boolean
    progressPct?: number | null
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
    idleTooltip = 'Voice input (⌥⇧Space)',
    showMic = true,
    micTextarea = false,
    progressPct = null,
  }: Props = $props()

  function handleWindowKeydown(event: KeyboardEvent): void {
    if (state !== 'recording' || event.key !== 'Escape') return
    event.preventDefault()
    event.stopImmediatePropagation()
    onCancel()
  }
</script>

<svelte:window onkeydown={handleWindowKeydown} />

{#if variant === 'bar'}
  {#if state === 'recording'}
    <TooltipUI.Root>
      <TooltipUI.Trigger>
        {#snippet child({ props: tooltipProps })}
          <button {...tooltipProps}
        type="button"
        onmousedown={(e) => e.preventDefault()}
        onclick={onConfirm}
        aria-label="Finish listening and transcribe"
        class="recording-stop recording-stop--bar pointer-coarse:tap-area"
      ><MicrophoneIcon size={14} class="recording-mic-pulse" /></button>
        {/snippet}
      </TooltipUI.Trigger>
      <TooltipUI.Content value={"Listening · Click to transcribe · Esc to cancel"} />
    </TooltipUI.Root>
  {:else if state === 'transcribing'}
    <button
      type="button"
      disabled
      aria-label="Finishing transcription"
      class="rc-bar-mic text-(--solus-mic-color)"
    ><SpinnerGapIcon size={14} class="animate-spin" /></button>
  {:else if showMic}
    <TooltipUI.Root>
      <TooltipUI.Trigger>
        {#snippet child({ props: tooltipProps })}
          <button {...tooltipProps}
      type="button"
      onmousedown={(e) => e.preventDefault()}
      onclick={onToggle}
      {disabled}
      aria-label="Voice input"
      class="rc-bar-mic pointer-coarse:tap-area transition-[background-color,color,opacity,transform] duration-150 ease-out enabled:hover:bg-(--solus-surface-hover) enabled:active:scale-[0.96]"
      style="{waiting
        ? 'background:var(--solus-accent);'
        : progressPct !== null
          ? `background:conic-gradient(var(--solus-accent) ${progressPct * 3.6}deg, var(--solus-mic-bg) 0deg);`
          : ''}color:{disabled
        ? 'var(--solus-mic-disabled)'
        : waiting
          ? 'var(--solus-text-on-accent)'
          : 'var(--solus-mic-color)'};opacity:{disabled ? 0.4 : 1}"
    >{#if progressPct !== null}<span class="flex size-[1.625rem] items-center justify-center rounded-md bg-(--solus-input-pill-bg)"><MicrophoneIcon size={14} /></span>{:else}<MicrophoneIcon size={14} />{/if}</button>
        {/snippet}
      </TooltipUI.Trigger>
      <TooltipUI.Content value={idleTooltip} />
    </TooltipUI.Root>
  {/if}
{:else if state === 'recording'}
  <TooltipUI.Root>
    <TooltipUI.Trigger>
      {#snippet child({ props: tooltipProps })}
        <button {...tooltipProps}
    type="button"
    class="rc-row"
    onmousedown={(e) => e.preventDefault()}
    onclick={onConfirm}
    aria-label="Finish listening and transcribe"
  >
    <span class="rc-waveform">
      <WaveformVisualizer {rmsRef} color="var(--solus-accent)" />
    </span>
    <span class="recording-stop recording-stop--field" aria-hidden="true"><MicrophoneIcon size={13} class="recording-mic-pulse" /></span>
  </button>
      {/snippet}
    </TooltipUI.Trigger>
    <TooltipUI.Content value={"Click to transcribe · Esc to cancel"} />
  </TooltipUI.Root>
{:else if state === 'transcribing'}
  <button
    type="button"
    class="rc-mic"
    class:rc-mic--textarea={micTextarea}
    disabled
    aria-label="Transcribing…"
  ><SpinnerGapIcon size={14} class="animate-spin" /></button>
{:else if showMic}
  <TooltipUI.Root>
    <TooltipUI.Trigger>
      {#snippet child({ props: tooltipProps })}
        <button {...tooltipProps}
    type="button"
    class="rc-mic"
    class:rc-mic--textarea={micTextarea}
    {disabled}
    onmousedown={(e) => e.preventDefault()}
    onclick={onToggle}
    aria-label="Voice input"
    style={progressPct !== null
      ? `background:conic-gradient(var(--solus-accent) ${progressPct * 3.6}deg, transparent 0deg)`
      : undefined}
  ><MicrophoneIcon size={14} /></button>
      {/snippet}
    </TooltipUI.Trigger>
    <TooltipUI.Content value={idleTooltip} />
  </TooltipUI.Root>
{/if}

<style>
  .recording-stop {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    border: 0.0625rem solid var(--solus-accent-border-medium);
    border-radius: var(--radius-lg);
    background: transparent;
    color: var(--solus-accent);
    transition:
      border-color 150ms ease-out,
      opacity 150ms ease-out,
      scale 150ms ease-out;
  }
  .recording-stop:hover {
    border-color: var(--solus-accent);
  }
  .recording-stop:active {
    scale: 0.96;
  }
  .recording-stop--bar {
    width: 1.875rem;
    height: 1.875rem;
  }
  .rc-bar-mic {
    display: flex;
    width: 1.875rem;
    height: 1.875rem;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    border-radius: var(--radius-lg);
  }
  :global(.recording-mic-pulse) {
    animation: recording-mic-pulse 950ms ease-in-out infinite alternate;
    will-change: opacity;
  }
  @keyframes recording-mic-pulse {
    from {
      opacity: 0.75;
    }
    to {
      opacity: 1;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    :global(.recording-mic-pulse) {
      animation: none;
      opacity: 1;
      will-change: auto;
    }
  }

  /* field variant: absolute overlay row shown while recording, positioned
     against the host's relative .inp-mic-wrap. */
  .rc-row {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    gap: 0.375rem;
    width: 100%;
    padding: 0 0.375rem 0 0.5rem;
    overflow: hidden;
    border-radius: inherit;
    color: var(--solus-text-secondary);
    cursor: pointer;
  }
  .rc-waveform {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
  }

  .recording-stop--field {
    width: 1.75rem;
    height: 1.75rem;
  }

  /* field idle / transcribing mic button */
  .rc-mic {
    position: absolute;
    right: var(--rc-mic-right, 0.25rem);
    top: 50%;
    transform: translateY(-50%);
    width: 1.75rem;
    height: 1.75rem;
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
  /* A textarea grows as you type, so centring on the box drags the mic down the
     field. `--rc-mic-top` is the mic's centre line, measured from the field's
     top edge, and any ancestor may set it:
       - a length pins the mic to the first line (the default matches the stock
         textarea's `py-2` + `leading-4`), which is right when the field's own
         actions sit in a row below it;
       - `50%` tracks the box centre, which is right when the mic shares a
         flex row with an `items-center` control it must stay level with. */
  .rc-mic--textarea {
    top: var(--rc-mic-top, 1rem);
  }
  .rc-mic:hover:not(:disabled) {
    background: var(--solus-mic-bg);
  }
  .rc-mic:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  /* `is-laptop-display` reads the monitor, and a phone screen is narrow enough
     to match it — so this dense rung must be gated on a fine pointer, or the
     bar mic lands at 28px in the hand. */
  @media (pointer: fine) {
    :global(html.is-laptop-display) .recording-stop--bar,
    :global(html.is-laptop-display) .rc-bar-mic {
      width: 1.75rem;
      height: 1.75rem;
    }
  }

  /* Level with the send button beside it, which also steps up for a finger. */
  @media (pointer: coarse) {
    .recording-stop--bar,
    .rc-bar-mic {
      width: 2.25rem;
      height: 2.25rem;
    }
  }
  :global(html.is-laptop-display) .recording-stop--field,
  :global(html.is-laptop-display) .rc-mic {
    width: 1.5rem;
    height: 1.5rem;
  }
</style>
