<script lang="ts">
  import { untrack, type Snippet } from "svelte";
  import { cn } from "@solus/workspace-ui/lib/utils.js";
  import { Button } from "../button";
  import { CommentEditor } from "../comment-editor";

  interface Props {
    value: string;
    onValueChange: (value: string) => void;
    onSubmit: (markdown: string) => void | Promise<void>;
    placeholder?: string;
    submitLabel?: string;
    submitAriaLabel?: string;
    disabled?: boolean;
    maxHeight?: number;
    leading?: Snippet;
    submitContent?: Snippet;
    below?: Snippet;
    editorClass?: string;
    class?: string;
  }

  let {
    value,
    onValueChange,
    onSubmit,
    placeholder = "Leave a comment…",
    submitLabel = "Comment",
    submitAriaLabel = submitLabel,
    disabled = false,
    maxHeight = 160,
    leading,
    submitContent,
    below,
    editorClass,
    class: className,
  }: Props = $props();

  let editor: ReturnType<typeof CommentEditor> | null = $state(null);
  let hasContent = $state(untrack(() => value.trim().length > 0));
  let uploading = $state(false);

  const canSubmit = $derived(hasContent && !uploading && !disabled);

  async function submit() {
    const markdown = editor?.getMarkdown().trim() ?? value.trim();
    if (!markdown || !canSubmit) return;
    await onSubmit(markdown);
    editor?.clear();
    onValueChange("");
  }

</script>

<div
  class={cn(
    "sticky bottom-0 z-10 pt-2.5 pb-[22px] [background:linear-gradient(to_bottom,transparent,var(--background)_22px)]",
    className,
  )}
>
  <div
    class="flex items-center gap-1 rounded-2xl bg-card px-3.5 py-2.5 shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_13%,transparent),0_1px_2px_rgba(24,20,16,.05)] transition-shadow focus-within:shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_13%,transparent),0_0_0_3px_color-mix(in_oklab,var(--ring)_14%,transparent)]"
  >
    {#if leading}{@render leading()}{/if}
    <CommentEditor
      bind:this={editor}
      {value}
      {onValueChange}
      onEmptyChange={(empty) => (hasContent = !empty)}
      onUploadStateChange={(isUploading) => (uploading = isUploading)}
      {disabled}
      {placeholder}
      {maxHeight}
      class={cn(
        "min-w-0 flex-1 [&_.cm-content]:![min-height:1.25rem] [&_.cm-content]:![padding:0.25rem_0] [&_.cm-content]:![font-weight:400]",
        editorClass,
      )}
      onKeyDown={(event) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          event.stopPropagation();
          void submit();
        }
      }}
    />
    <Button
      type="button"
      disabled={!canSubmit}
      class={cn(
        "flex h-7.5 shrink-0 cursor-pointer items-center rounded-lg border-0 bg-[color:color-mix(in_oklab,var(--primary)_14%,transparent)] font-medium text-primary transition-colors hover:bg-[color:color-mix(in_oklab,var(--primary)_22%,transparent)] disabled:cursor-not-allowed disabled:opacity-40 [.is-laptop-display_&]:h-7",
        submitContent ? "w-7.5 justify-center px-0 [.is-laptop-display_&]:w-7" : "px-3",
      )}
      aria-label={submitAriaLabel}
      title={`${submitLabel} · ⌘↵`}
      onclick={submit}
    >
      {#if submitContent}{@render submitContent()}{:else}{submitLabel}{/if}
    </Button>
  </div>
  {#if below}{@render below()}{/if}
</div>
