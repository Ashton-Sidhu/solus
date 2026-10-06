<script lang="ts">
  /** A long-form settings text field. The field edits in place, and its expand
   *  button opens the same text in a large dialog. Both editors write through
   *  `onValueChange`; `onBlur` runs once when the user leaves the field or
   *  closes the dialog, never when focus moves between the two. */
  import { Dialog } from "bits-ui";
  import { Maximize2 as ExpandIcon, X as XIcon } from "@lucide/svelte";
  import { Button } from "../ui/button";
  import PlainTextEditor from "../ui/plain-text-editor/plain-text-editor.svelte";

  interface Props {
    /** Names the field for assistive technology and titles the dialog. */
    label: string;
    value: string;
    onValueChange: (value: string) => void;
    onBlur?: () => void;
    placeholder?: string;
    maxHeight?: number;
    /** Classes for the inline editor. */
    class?: string;
  }

  let { label, value, onValueChange, onBlur, placeholder = "", maxHeight = 220, class: klass = "" }: Props = $props();

  let expanded = $state(false);
  let dialogEditor: PlainTextEditor | null = $state(null);

  function leaveInlineEditor() {
    // Opening the dialog moves focus into it; that is not leaving the field.
    if (!expanded) onBlur?.();
  }

  function setExpanded(next: boolean) {
    expanded = next;
    if (!next) onBlur?.();
  }
</script>

<div class="group/text-field relative">
  <PlainTextEditor
    {value}
    {onValueChange}
    onBlur={leaveInlineEditor}
    ariaLabel={label}
    enterInsertsNewline
    hidePlaceholderOnFocus
    {maxHeight}
    dictation
    {placeholder}
    class={klass}
  />
  <Button
    variant="ghost"
    size="icon-xs"
    aria-label="Expand {label}"
    title="Expand"
    class="absolute right-1.5 bottom-1.5 z-10 bg-(--solus-container-bg) text-(--solus-text-tertiary) opacity-0 transition-opacity group-hover/text-field:opacity-100 group-focus-within/text-field:opacity-100 hover:text-(--solus-text-primary) focus-visible:opacity-100 pointer-coarse:size-9 pointer-coarse:opacity-100"
    onpointerdown={(event) => event.preventDefault()}
    onclick={() => setExpanded(true)}
  >
    <ExpandIcon size={14} />
  </Button>
</div>

<Dialog.Root open={expanded} onOpenChange={setExpanded}>
  <Dialog.Portal>
    <Dialog.Overlay class="fixed inset-0 z-50 bg-(--solus-modal-scrim)" />
    <Dialog.Content
      class="text-workspace-chrome fixed top-1/2 left-1/2 z-50 flex h-[min(48rem,calc(100dvh-2rem))] w-[min(56rem,calc(100vw-2rem))] -translate-1/2 flex-col overflow-hidden rounded-2xl border border-(--solus-tool-border) bg-(--solus-container-bg) shadow-(--solus-popover-shadow)"
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        dialogEditor?.focus();
      }}
    >
      <div class="flex shrink-0 items-center justify-between gap-3 border-b border-(--solus-tool-border) px-4 py-2.5">
        <Dialog.Title class="min-w-0 truncate font-medium text-(--solus-text-primary)">{label}</Dialog.Title>
        <Dialog.Close>
          {#snippet child({ props })}
            <Button {...props} variant="ghost" size="icon-xs" class="pointer-coarse:size-11" aria-label="Close {label}"><XIcon size={16} /></Button>
          {/snippet}
        </Dialog.Close>
      </div>
      <div class="min-h-0 flex-1 overflow-hidden px-5">
        <PlainTextEditor
          bind:this={dialogEditor}
          {value}
          {onValueChange}
          ariaLabel={label}
          enterInsertsNewline
          dictation
          micPlacement="beside"
          {placeholder}
          class="h-full [--plain-editor-line-height:1.6] [--plain-editor-padding:1rem_0] [&>div:first-child]:h-full [&_.cm-content]:![font-weight:400] [&_.cm-editor]:h-full [&_.cm-scroller]:!max-h-none"
        />
      </div>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
