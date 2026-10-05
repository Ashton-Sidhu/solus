<script lang="ts" generics="Value extends string">
  import type { Snippet } from "svelte";
  import { MessageSquareText, CircleCheck, CircleAlert } from "@lucide/svelte";
  import { cn } from "../../../lib/utils";
  import { isMac } from "../../../lib/keybindings/match";
  import { CommentEditor } from "../comment-editor";
  import { Button } from "../button";
  import * as TooltipUI from "../tooltip";
  import EditorVoiceControl from "../../input/EditorVoiceControl.svelte";
  import type { ReviewChoice } from "./lib/review-choice";

  let {
    value = $bindable(), body = $bindable(""), choices, busy = false,
    canSubmit = true, needsContent = false, maxLength, submitLabel,
    submitTestId, onSubmit, comments, actions, hint, class: className,
  }: {
    value: Value;
    body?: string;
    choices: ReviewChoice<Value>[];
    busy?: boolean;
    canSubmit?: boolean;
    needsContent?: boolean;
    maxLength?: number;
    submitLabel?: string;
    submitTestId?: string;
    onSubmit: () => void;
    comments?: Snippet;
    actions?: Snippet;
    hint?: Snippet;
    class?: string;
  } = $props();

  const selected = $derived(choices.find((choice) => choice.value === value) ?? choices[0]);
  const tooLong = $derived(maxLength !== undefined && body.length > maxLength);
  const enabled = $derived(canSubmit && !busy && !tooLong && !!selected && !selected.disabled);
  let editor: ReturnType<typeof CommentEditor> | null = $state(null);
  let focused = $state(false);
  let uploading = $state(false);
  $effect(() => { editor?.focus(); });

  function onKeydown(event: KeyboardEvent) {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && enabled && !uploading) {
      event.preventDefault();
      onSubmit();
    }
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class={cn("flex flex-col gap-3.5 p-4", className)} onkeydown={onKeydown}>
  <CommentEditor
    bind:this={editor}
    value={body}
    onValueChange={(markdown) => (body = markdown)}
    onFocus={() => (focused = true)}
    onBlur={() => (focused = false)}
    onUploadStateChange={(value) => (uploading = value)}
    disabled={busy}
    mic={false}
    maxHeight={360}
    ariaLabel="Review summary"
    placeholder={needsContent ? "Write a summary…" : "Add a summary (optional)…"}
    class="rounded-xl border border-border bg-transparent px-3 transition-colors focus-within:border-foreground/25 [&_.cm-content]:![min-height:8rem] [&_.cm-content]:![padding:0.5rem_0] [&_.cm-content]:![font-weight:400]"
  />
  {#if comments}{@render comments()}{/if}
  <!-- The verdict buttons fill one row; under them, the voice control and
       the submit button. The verdict carries the color; submit is always the
       primary call to action, and its label names the verdict. -->
  {#if choices.length > 1}
    <div role="radiogroup" aria-label="Verdict" class="flex gap-1.5">
      {#each choices as choice (choice.value)}
        {@const isSelected = value === choice.value}
        {@const Icon = choice.kind === "approve" ? CircleCheck : choice.kind === "request-changes" ? CircleAlert : MessageSquareText}
        <TooltipUI.Root>
          <TooltipUI.Trigger>
            {#snippet child({ props })}
              <Button
                {...props}
                variant="outline"
                size="sm"
                role="radio"
                aria-checked={isSelected}
                disabled={busy}
                aria-disabled={choice.disabled}
                style="--ev:var(--solus-review-{choice.kind});"
                class="h-8 min-w-0 flex-1 gap-1.5 overflow-hidden bg-transparent text-workspace-chrome pointer-coarse:h-11 dark:bg-transparent {isSelected
                  ? 'border-transparent bg-(--ev) text-white hover:bg-(--ev) hover:text-white hover:opacity-90 dark:bg-(--ev) dark:hover:bg-(--ev)'
                  : choice.disabled
                    ? 'cursor-not-allowed text-muted-foreground opacity-40 hover:bg-transparent'
                    : 'text-muted-foreground hover:bg-[var(--wash-1)] dark:hover:bg-[var(--wash-1)]'}"
                onclick={() => { if (!choice.disabled) value = choice.value; }}
              >
                <Icon class="size-4 shrink-0" aria-hidden="true" />
                <span class="truncate">{choice.label}</span>
              </Button>
            {/snippet}
          </TooltipUI.Trigger>
          <TooltipUI.Content value={choice.disabledReason} />
        </TooltipUI.Root>
      {/each}
    </div>
  {/if}
  <footer class="flex items-center gap-2">
    <span class="min-w-0 flex-1 truncate text-workspace-chrome text-muted-foreground" aria-live="polite">
      {#if tooLong}
        Use {maxLength} characters or fewer
      {:else if hint}
        {@render hint()}
      {/if}
    </span>
    {#if actions}{@render actions()}{/if}
    <span class="flex shrink-0 items-center">
      <EditorVoiceControl onTranscript={(transcript) => editor?.insertTranscript(transcript)} {focused} disabled={busy || uploading} />
    </span>
    <TooltipUI.Root>
      <TooltipUI.Trigger>
        {#snippet child({ props })}
          <Button {...props} size="sm" class="pointer-coarse:min-h-11" disabled={!enabled || uploading} data-testid={submitTestId} onclick={onSubmit}>
            {busy ? "Submitting…" : submitLabel ?? selected?.label}
          </Button>
        {/snippet}
      </TooltipUI.Trigger>
      <TooltipUI.Content value={{ label: "Submit", shortcut: isMac ? "⌘↵" : "Ctrl↵" }} />
    </TooltipUI.Root>
  </footer>
</div>
