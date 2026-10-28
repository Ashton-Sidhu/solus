<script lang="ts">
  import { onMount, untrack, type Snippet } from "svelte";
  import type { FieldSubmitKey } from "@solus/workspace-ui/lib/field-dictation.svelte.js";
  import { cn } from "@solus/workspace-ui/lib/utils.js";
  import { CommentEditor } from "../comment-editor";
  import { Button } from "../button";
  import EditorVoiceControl from "../../input/EditorVoiceControl.svelte";
  import { formatComboText } from "../../../lib/keybindings/match";

  type CommentComposerSurface = "floating" | "embedded" | "compact";

  // The one comment workflow. Features still own placement and nearby context;
  // this component owns the editor, shortcuts, submission state, and actions.
  interface Props {
    onSave: (comment: string) => void;
    onCancel: () => void;
    /** Mono caption above the field, naming what the comment is attached to. */
    anchorLabel?: string;
    initialValue?: string;
    onFormValueChange?: (value: string) => void;
    placeholder?: string;
    ariaLabel?: string;
    submitLabel?: string;
    submitOn?: FieldSubmitKey;
    surface?: CommentComposerSurface;
    /** Compatibility for existing callers. Prefer `surface`. */
    framed?: boolean;
    autoFocus?: boolean;
    disabled?: boolean;
    maxHeight?: number;
    editorClass?: string;
    leading?: Snippet;
    footer?: Snippet;
    secondaryActions?: Snippet;
    cancelLabel?: string;
    class?: string;
  }

  let {
    onSave,
    onCancel,
    anchorLabel,
    initialValue = "",
    onFormValueChange,
    placeholder = "Add comment…",
    ariaLabel,
    submitLabel = "Comment",
    submitOn = "mod-enter",
    surface,
    framed,
    autoFocus = true,
    disabled = false,
    maxHeight = 120,
    editorClass,
    leading,
    footer,
    secondaryActions,
    cancelLabel = "Cancel",
    class: className,
  }: Props = $props();

  let value = $state(untrack(() => initialValue));
  let lastInitialValue = $state(untrack(() => initialValue));
  let inputEl: ReturnType<typeof CommentEditor> | null = $state(null);
  let hasContent = $state(untrack(() => initialValue.trim().length > 0));
  let uploadingImage = $state(false);
  let editorFocused = $state(false);

  export function focusInput() {
    if (!inputEl) return;
    inputEl.focus();
  }

  onMount(() => {
    if (autoFocus) setTimeout(focusInput, 30);
  });

  $effect(() => {
    if (initialValue === lastInitialValue) return;
    lastInitialValue = initialValue;
    value = initialValue;
    hasContent = initialValue.trim().length > 0;
  });

  const canSave = $derived(hasContent && !uploadingImage && !disabled);
  const hint = $derived(submitOn === "enter" ? "↵ to save" : `${formatComboText({ mod: true, code: "Enter" })} to save`);
  const resolvedSurface = $derived(surface ?? (framed === false ? "embedded" : "floating"));

  function handleSave() {
    const comment = inputEl?.getMarkdown().trim() ?? value.trim();
    if (!comment) return;
    onSave(comment);
  }

  // The composer always sits over a surface with its own key handling — a diff
  // row, a document, a thread card — so the keys it consumes stop here.
  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter" && submitOn === "enter" && !e.shiftKey) e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    }
  }
</script>

{#snippet editor()}
  <CommentEditor
    bind:this={inputEl}
    {value}
    onValueChange={(next) => {
      value = next;
      onFormValueChange?.(next);
    }}
    onEmptyChange={(empty) => (hasContent = !empty)}
    onUploadStateChange={(uploading) => (uploadingImage = uploading)}
    mic={false}
    onFocus={() => (editorFocused = true)}
    onBlur={() => (editorFocused = false)}
    {placeholder}
    {ariaLabel}
    {disabled}
    {maxHeight}
    onKeyDown={(event) => {
      handleKeyDown(event);
      if (
        event.key === "Enter" &&
        ((submitOn === "enter" && !event.shiftKey) ||
          (submitOn === "mod-enter" && (event.metaKey || event.ctrlKey)))
      ) {
        event.preventDefault();
        event.stopPropagation();
        handleSave();
      }
    }}
    class={cn("min-h-8 text-workspace-chrome leading-5!", editorClass)}
  />
{/snippet}

{#snippet actions()}
  {#if footer}{@render footer()}{/if}
  {#if secondaryActions}{@render secondaryActions()}{/if}
  {#if !footer && !secondaryActions}
    <span
      class="mr-auto text-xs text-(--solus-text-tertiary)"
      style="font-family:var(--solus-code-font-family)"
    >
      {hint}
    </span>
  {:else}
    <span class="flex-1"></span>
  {/if}
  <!-- The recorder shares the line with Cancel and the submit button, where it
       stays level with them however tall the field grows. -->
  <span class="comment-composer__mic flex shrink-0 items-center">
    <EditorVoiceControl
      onTranscript={(transcript) => inputEl?.insertTranscript(transcript)}
      focused={editorFocused}
      {disabled}
    />
  </span>
  <Button variant="ghost" size="xs" onclick={onCancel} class="text-(--solus-text-tertiary)">
    {cancelLabel}
  </Button>
  <Button size="xs" disabled={!canSave} onclick={handleSave}>
    {submitLabel}
  </Button>
{/snippet}

<div
  class={cn(
    "comment-composer flex flex-col gap-1.5 font-(family-name:--solus-font-family)",
    resolvedSurface === "floating" && "rounded-2xl bg-(--solus-popover-bg) px-3 py-2.5",
    className,
  )}
  data-surface={resolvedSurface}
  style="{resolvedSurface === "floating"
    ? 'box-shadow:0 0 0 0.0625rem color-mix(in oklab, var(--solus-accent) 30%, transparent), 0 1rem 2.25rem -1.375rem rgba(0, 0, 0, 0.5)'
    : ''}"
>
  {#if anchorLabel}
    <span
      class="inline-block text-xs text-(--solus-text-tertiary) tabular-nums"
      style="font-family:var(--solus-code-font-family)"
    >
      {anchorLabel}
    </span>
  {/if}
  {#if resolvedSurface === "compact"}
    <!-- The mark sits level with the first line however far the note wraps;
         the field's own padding is tightened to the mark's 32px rung. -->
    <div class="flex items-start gap-2">
      {#if leading}<span class="flex h-8 shrink-0 items-center">{@render leading()}</span>{/if}
      {@render editor()}
    </div>
    <div class="flex items-center gap-1.5">
      {@render actions()}
    </div>
  {:else}
    {#if leading}{@render leading()}{/if}
    {@render editor()}
    <div class="flex items-center justify-end gap-1.5">
      {@render actions()}
    </div>
  {/if}
</div>

<style>
  .comment-composer {
    animation: comment-composer-in 0.15s ease-out both;
  }
  .comment-composer[data-surface="compact"] {
    animation: none;
  }
  /* The recorder's own rung is the composer bar's (30px), which stands taller
     than the xs buttons it now shares a row with. Match the button rung so the
     three controls read as one line; a coarse pointer keeps the thumb target. */
  @media (pointer: fine) {
    .comment-composer__mic :global(button) {
      width: 1.5rem;
      height: 1.5rem;
    }
  }
  @keyframes comment-composer-in {
    from { opacity: 0; transform: translateY(-0.1875rem); }
    to   { opacity: 1; transform: translateY(0); }
  }
  @media (prefers-reduced-motion: reduce) {
    .comment-composer {
      animation: none;
    }
  }
</style>
