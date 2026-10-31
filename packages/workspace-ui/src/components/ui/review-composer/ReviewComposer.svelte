<script lang="ts" generics="Value extends string">
  import type { Snippet } from "svelte";
  import { MessageSquareText, CircleCheck, CircleAlert, ChevronDown } from "@lucide/svelte";
  import { cn } from "../../../lib/utils";
  import { isMac } from "../../../lib/keybindings/match";
  import { CommentEditor } from "../comment-editor";
  import { Button } from "../button";
  import * as TooltipUI from "../tooltip";
  import * as DropdownMenu from "../dropdown-menu";
  import EditorVoiceControl from "../../input/EditorVoiceControl.svelte";
  import { verdictHelp, type ReviewChoice } from "./lib/review-choice";

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
<div class={cn("flex flex-col gap-3 p-4", className)} onkeydown={onKeydown}>
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
    class="border-0 bg-transparent px-0 [&_.cm-content]:![min-height:5.5rem] [&_.cm-content]:![padding:0] [&_.cm-content]:![font-weight:400]"
  />
  {#if comments}{@render comments()}{/if}
  <!-- One neutral submit button names the verdict. With more than one
       verdict it is a split button: its menu picks the verdict and says why
       a locked one is locked. Only the verdict icons carry color. -->
  <footer class="flex items-center gap-2">
    <span class="min-w-0 flex-1 truncate text-chrome-dense text-muted-foreground" aria-live="polite">
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
    <div class="flex shrink-0 items-stretch">
      <TooltipUI.Root>
        <TooltipUI.Trigger>
          {#snippet child({ props })}
            <Button
              {...props}
              size="sm"
              class="bg-foreground text-background hover:bg-foreground/85 pointer-coarse:min-h-11 {choices.length > 1 ? 'rounded-r-none' : ''}"
              disabled={!enabled || uploading}
              data-testid={submitTestId}
              onclick={onSubmit}
            >
              {busy ? "Submitting…" : submitLabel ?? selected?.label}
            </Button>
          {/snippet}
        </TooltipUI.Trigger>
        <TooltipUI.Content value={{ label: "Submit", shortcut: isMac ? "⌘↵" : "Ctrl↵" }} />
      </TooltipUI.Root>
      {#if choices.length > 1}
        <DropdownMenu.Root>
          <DropdownMenu.Trigger disabled={busy}>
            {#snippet child({ props })}
              <Button
                {...props}
                size="icon-sm"
                aria-label="Verdict: {selected?.label}"
                class="w-6.5 rounded-l-none border-l border-l-background/25 bg-foreground text-background hover:bg-foreground/85 aria-expanded:bg-foreground/85 pointer-coarse:min-h-11 pointer-coarse:w-9"
              >
                <ChevronDown class="size-3.5" aria-hidden="true" />
              </Button>
            {/snippet}
          </DropdownMenu.Trigger>
          <DropdownMenu.Content
            align="end"
            class="w-64"
            onCloseAutoFocus={(event) => { event.preventDefault(); editor?.focus(); }}
          >
            <DropdownMenu.RadioGroup bind:value aria-label="Verdict">
              {#each choices as choice (choice.value)}
                {@const Icon = choice.kind === "approve" ? CircleCheck : choice.kind === "request-changes" ? CircleAlert : MessageSquareText}
                <DropdownMenu.RadioItem value={choice.value} disabled={choice.disabled} class="items-start">
                  <Icon class="mt-0.5 size-4" style="color: var(--solus-review-{choice.kind});" aria-hidden="true" />
                  <span class="flex min-w-0 flex-col">
                    <span class="text-foreground">{choice.label}</span>
                    <span class="text-chrome-dense text-muted-foreground">{choice.disabled ? choice.disabledReason : verdictHelp[choice.kind]}</span>
                  </span>
                </DropdownMenu.RadioItem>
              {/each}
            </DropdownMenu.RadioGroup>
          </DropdownMenu.Content>
        </DropdownMenu.Root>
      {/if}
    </div>
  </footer>
</div>
