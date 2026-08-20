<script lang="ts">
  import { onMount, untrack } from "svelte";
  import type { FieldSubmitKey } from "@solus/workspace-ui/lib/field-dictation.svelte.js";
  import { cn } from "@solus/workspace-ui/lib/utils.js";
  import { CommentEditor } from "../comment-editor";
  import { Button } from "../button";

  // The one comment box. A note on a diff line, an annotation on a run of prose,
  // and a reply in a thread are the same composer; `framed` is the only real
  // difference — a card when it floats over the thing it annotates, bare when it
  // already sits inside one.
  interface Props {
    onSave: (comment: string) => void;
    onCancel: () => void;
    /** Mono caption above the field, naming what the comment is attached to. */
    anchorLabel?: string;
    initialValue?: string;
    onFormValueChange?: (value: string) => void;
    placeholder?: string;
    submitLabel?: string;
    submitOn?: FieldSubmitKey;
    framed?: boolean;
    autoFocus?: boolean;
    class?: string;
  }

  let {
    onSave,
    onCancel,
    anchorLabel,
    initialValue = "",
    onFormValueChange,
    placeholder = "Add comment…",
    submitLabel = "Comment",
    submitOn = "mod-enter",
    framed = true,
    autoFocus = true,
    class: className,
  }: Props = $props();

  let value = $state(untrack(() => initialValue));
  let lastInitialValue = $state(untrack(() => initialValue));
  let inputEl: ReturnType<typeof CommentEditor> | null = $state(null);
  let hasContent = $state(untrack(() => initialValue.trim().length > 0));

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

  const canSave = $derived(hasContent);
  const hint = $derived(submitOn === "enter" ? "↵ to save" : "⌘↵ to save");

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

<!-- Framed: defined by an accent ring rather than a border, so the composer
     reads as a card floating over the content rather than another row in it.
     The field is bare, so its first line starts at the top edge: the mic rides
     the middle of that line, half of the `leading-5` below it. -->
<div
  class={cn(
    "comment-composer flex flex-col gap-1.5 font-(family-name:--solus-font-family)",
    framed && "rounded-2xl bg-(--solus-popover-bg) px-3 py-2.5",
    className,
  )}
  style="--rc-mic-line-center:0.625rem;{framed
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
  <!-- The shared lightweight field keeps inline diff notes on the same raw
       Markdown input path as task and PR conversation comments. -->
  <CommentEditor
    bind:this={inputEl}
    {value}
    onValueChange={(next) => {
      value = next;
      onFormValueChange?.(next);
    }}
    onEmptyChange={(empty) => (hasContent = !empty)}
    {placeholder}
    maxHeight={120}
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
    class="min-h-8 text-workspace-chrome leading-5!"
  />
  <div class="flex items-center justify-end gap-1.5">
    <span
      class="mr-auto text-xs text-(--solus-text-tertiary)"
      style="font-family:var(--solus-code-font-family)"
    >
      {hint}
    </span>
    <Button variant="ghost" size="xs" onclick={onCancel} class="text-(--solus-text-tertiary)">
      Cancel
    </Button>
    <Button size="xs" disabled={!canSave} onclick={handleSave}>
      {submitLabel}
    </Button>
  </div>
</div>

<style>
  .comment-composer {
    animation: comment-composer-in 0.15s ease-out both;
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
