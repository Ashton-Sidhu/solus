<script lang="ts">
  import { onDestroy } from "svelte";
  import { dictation, isDictationTarget } from "../../lib/dictation.svelte";
  import RecordingControls from "../input/RecordingControls.svelte";

  interface Props {
    el?: HTMLInputElement | HTMLTextAreaElement | null;
    value?: string;
    type?: "text" | "search" | "number" | "textarea";
    variant?: "bare" | "field";
    size?: "sm" | "md" | "lg";
    placeholder?: string;
    disabled?: boolean;
    autofocus?: boolean;
    rows?: number;
    min?: number;
    step?: number;
    /** Show an inline mic button for voice dictation (⌥⇧K works regardless). */
    mic?: boolean;
    /**
     * Minimum ms of detected speech before the VAD silence timer starts.
     * Set to 0 (default) for short-form inputs like search bars.
     * Set to ~300 for conversational inputs to avoid false triggers on brief noise.
     */
    vadMinSpeechMs?: number;
    /**
     * Commit handler for this field. Fired when the user submits via keyboard
     * (see `submitOn`) and after a dictated transcript is inserted (auto-send).
     */
    onSubmit?: () => void;
    /**
     * Which keystroke triggers `onSubmit`. `'enter'` = plain Enter (Shift+Enter
     * still inserts a newline); `'mod-enter'` = ⌘/Ctrl+Enter. Omit to disable
     * keyboard submit. No-op without `onSubmit`.
     */
    submitOn?: "enter" | "mod-enter";
    class?: string;
    "data-testid"?: string;
    oninput?: (e: Event) => void;
    onkeydown?: (e: KeyboardEvent) => void;
    onchange?: (e: Event) => void;
    onfocus?: (e: FocusEvent) => void;
    onblur?: (e: FocusEvent) => void;
  }

  let {
    el = $bindable<HTMLInputElement | HTMLTextAreaElement | null>(null),
    value = $bindable(""),
    type = "text",
    variant = "bare",
    size = "md",
    placeholder,
    disabled = false,
    autofocus = false,
    rows = 1,
    min,
    step,
    mic = false,
    vadMinSpeechMs = 0,
    onSubmit,
    submitOn,
    class: extraClass = "",
    "data-testid": dataTestId,
    oninput,
    onkeydown,
    onchange,
    onfocus,
    onblur,
  }: Props = $props();

  $effect(() => {
    if (autofocus) el?.focus({ preventScroll: true });
  });

  // Register/unregister this field's auto-send handler so dictation (mic click
  // or ⌥⇧K) can submit after inserting. Re-runs when el or onSubmit changes.
  $effect(() => {
    if (!el) return;
    const target = el;
    dictation.registerSubmit(target, onSubmit);
    dictation.registerVadMinSpeechMs(target, vadMinSpeechMs);
    return () => dictation.unregisterSubmit(target);
  });

  onDestroy(() => {
    if (el) dictation.releaseTarget(el);
  });

  const micState = $derived(dictation.target === el ? dictation.state : "idle");

  // Auto voice mode: focusing a dictation-capable field hands the mic to this
  // input (the conversational recorder yields), and starts dictation when voice
  // mode is on so the user can just talk. Blur releases it back.
  function handleFocus(e: FocusEvent) {
    if (el && isDictationTarget(el)) dictation.focusGained(el);
    onfocus?.(e);
  }
  function handleBlur(e: FocusEvent) {
    if (el) dictation.focusLost(el);
    onblur?.(e);
  }

  // Run the consumer's handler first (it may preventDefault, e.g. Escape), then
  // fire onSubmit when the configured submit key is pressed. Centralizes the
  // Enter/⌘↵ submit pattern that every comment/editor bar used to reimplement.
  function handleKeydown(e: KeyboardEvent) {
    onkeydown?.(e);
    if (e.defaultPrevented || !submitOn || !onSubmit) return;
    if (e.key !== "Enter" || e.isComposing) return;
    const mod = e.metaKey || e.ctrlKey;
    if (submitOn === "mod-enter" ? mod : !e.shiftKey && !mod && !e.altKey) {
      e.preventDefault();
      onSubmit();
    }
  }
</script>

<!-- Always render inside the wrapper so the underlying input element is never
     re-mounted. If we conditionally switch between bare and wrapped, `el` gets
     a new DOM node the moment recording starts, leaving dictation.target pointing
     to a detached element — text insertion bails and the waveform never shows. -->
<span
  class="inp-mic-wrap"
  class:inp-mic-wrap--recording={micState === "recording"}
>
  <!-- Keep the real input mounted for value binding; hide it while recording -->
  <span class:inp-hidden={micState === "recording"}>
    {@render control()}
  </span>

  <RecordingControls
    variant="field"
    state={micState}
    rmsRef={dictation.rmsRef}
    showMic={mic}
    micTextarea={type === "textarea" && rows > 1}
    {disabled}
    onCancel={() => dictation.cancel()}
    onConfirm={() => dictation.stop()}
    onToggle={() => {
      if (el) dictation.toggleInto(el);
    }}
  />
</span>

{#snippet control()}
  {#if type === "textarea"}
    <textarea
      bind:this={el as HTMLTextAreaElement}
      {value}
      {placeholder}
      {disabled}
      {rows}
      data-testid={dataTestId}
      class="inp {extraClass}"
      class:inp--bare={variant === "bare"}
      class:inp--field={variant === "field"}
      class:inp--sm={size === "sm"}
      class:inp--md={size === "md"}
      class:inp--lg={size === "lg"}
      class:inp--has-mic={mic}
      oninput={(e) => {
        value = (e.currentTarget as HTMLTextAreaElement).value;
        oninput?.(e);
      }}
      onkeydown={handleKeydown}
      onfocus={handleFocus}
      onblur={handleBlur}
    ></textarea>
  {:else}
    <input
      bind:this={el as HTMLInputElement}
      {value}
      type={type === "search" ? "text" : type}
      {placeholder}
      {disabled}
      {min}
      {step}
      data-testid={dataTestId}
      class="inp {extraClass}"
      class:inp--bare={variant === "bare"}
      class:inp--field={variant === "field"}
      class:inp--sm={size === "sm"}
      class:inp--md={size === "md"}
      class:inp--lg={size === "lg"}
      class:inp--number={type === "number"}
      class:inp--has-mic={mic}
      oninput={(e) => {
        value = (e.currentTarget as HTMLInputElement).value;
        oninput?.(e);
      }}
      onkeydown={handleKeydown}
      {onchange}
      onfocus={handleFocus}
      onblur={handleBlur}
    />
  {/if}
{/snippet}

<style>
  .inp {
    font-family: inherit;
    color: var(--solus-text-primary);
  }
  .inp::placeholder {
    color: var(--solus-placeholder);
  }
  .inp:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* Sizes */
  .inp--sm {
    font-size: 0.6875rem;
  }
  .inp--md {
    font-size: 0.7813rem;
  }
  .inp--lg {
    font-size: 0.8438rem;
  }

  /* bare variant */
  .inp--bare {
    background: transparent;
    border: none;
    outline: none;
    width: 100%;
  }
  textarea.inp--bare {
    padding: 0;
  }

  /* field variant */
  .inp--field {
    width: 100%;
    padding: 0.5rem 0.625rem;
    border-radius: 0.4375rem;
    border: 0.0625rem solid var(--solus-input-focus-border);
    background: transparent;
    outline: none;
    resize: none;
    box-shadow: 0 0 0 0.1875rem var(--solus-input-focus-ring);
    line-height: 1.5;
    transition:
      border-color var(--duration-base) var(--ease-premium),
      box-shadow var(--duration-base) var(--ease-premium);
  }

  /* textarea extras */
  textarea.inp {
    resize: none;
    field-sizing: content;
  }
  textarea.inp--field {
    line-height: 1.5;
  }

  /* mic affordance */
  .inp-mic-wrap {
    position: relative;
    display: flex;
    align-items: center;
    width: 100%;
  }
  .inp.inp--has-mic {
    padding-right: 2rem;
  }

  /* The control wrapper is always a flex child of inp-mic-wrap; it needs to
     fill the available width so the inner textarea grows correctly. */
  .inp-mic-wrap > span:first-child {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
  }

  /* hide actual input while showing recording UI — stays in flow so the
     wrapper keeps its natural height for the absolute overlay to fill */
  .inp-hidden {
    visibility: hidden;
    pointer-events: none;
  }

  /* recording state: wrapper needs enough height for the 20px waveform canvas */
  .inp-mic-wrap--recording {
    min-height: 1.5rem;
  }
  /* number extras */
  .inp--number {
    text-align: center;
    -moz-appearance: textfield;
    appearance: textfield;
  }
  .inp--number::-webkit-inner-spin-button,
  .inp--number::-webkit-outer-spin-button {
    -webkit-appearance: none;
    appearance: none;
    margin: 0;
  }
</style>
