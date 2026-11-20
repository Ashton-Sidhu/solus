<script lang="ts">
  /*
   * The argument form (docs/plans/mcp-first-class.md §10): one field for each
   * argument, required ones marked. It knows fields and values only, not MCP
   * prompts, so a resource template (§11.3) uses it too. Tab moves between
   * fields, Enter sends, Escape closes; the caller returns the focus to the
   * input bar after either.
   */
  import { onMount, untrack } from "svelte";
  import { X as XIcon } from "@lucide/svelte";
  import { Button } from "../ui/button";
  import { Input } from "../ui/input";
  import {
    missingArguments,
    type ArgumentField,
    type ArgumentValue,
  } from "@solus/client-core/integration-prompts";

  interface Props {
    /** What the form fills, as the person typed it: `/github:review_pr`. */
    title: string;
    description?: string;
    fields: ArgumentField[];
    /** The values the form starts with, in field order; absent fields start empty. */
    initialValues?: ArgumentValue[];
    submitLabel?: string;
    /** The send runs: the fields keep their values and the button waits. */
    isSubmitting?: boolean;
    /** Why the last send failed. The values stay so the person can retry. */
    error?: string;
    onSubmit: (values: ArgumentValue[]) => void;
    onClose: () => void;
  }

  let {
    title,
    description = "",
    fields,
    initialValues = [],
    submitLabel = "Send",
    isSubmitting = false,
    error = "",
    onSubmit,
    onClose,
  }: Props = $props();

  const formId = $props.id();
  let values = $state<ArgumentValue[]>(
    untrack(() =>
      fields.map((field) => ({
        name: field.name,
        value: initialValues.find((entry) => entry.name === field.name)?.value ?? "",
      })),
    ),
  );
  /** Required marks turn red only after a send was tried. */
  let hasTriedSend = $state(false);
  const missing = $derived(missingArguments(fields, values));
  let inputs = $state<(HTMLInputElement | null)[]>([]);

  /** Typing goes to the first empty field when the form opens. */
  onMount(() => {
    (inputs.find((input, index) => input && !values[index]?.value) ?? inputs[0])?.focus();
  });

  function submit() {
    if (isSubmitting) return;
    hasTriedSend = true;
    if (missing.length) {
      inputs[fields.findIndex((field) => field.name === missing[0])]?.focus();
      return;
    }
    onSubmit(values);
  }

  /** On each control of the form: Escape closes it from anywhere in it; Enter in a field sends. */
  function handleKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    } else if (event.key === "Enter" && event.target instanceof HTMLInputElement && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      submit();
    }
  }
</script>

<!-- No border: the form sits inside the composer card, on the card's own
     surface, as the attachment row does. A wash separates it from the well. -->
<form
  class="mx-1.5 mt-1.5 flex flex-col gap-2 rounded-xl bg-(--solus-surface-hover) p-2.5 text-workspace-chrome"
  aria-labelledby="{formId}-title"
  onsubmit={(event) => {
    event.preventDefault();
    submit();
  }}
  data-testid="prompt-argument-form"
>
  <div class="flex min-w-0 items-start gap-2">
    <div class="min-w-0 flex-1">
      <div id="{formId}-title" class="truncate font-mono font-medium text-(--solus-text-primary)">{title}</div>
      {#if description}
        <div class="mt-0.5 line-clamp-2 text-(--solus-text-tertiary)">{description}</div>
      {/if}
    </div>
    <Button variant="ghost" size="icon-sm" type="button" class="pointer-coarse:size-11" aria-label="Close" onclick={onClose} onkeydown={handleKeyDown}>
      <XIcon />
    </Button>
  </div>

  <div class="grid gap-2 @min-[30rem]/composer:grid-cols-2">
    {#each fields as field, index (field.name)}
      {@const isMissing = hasTriedSend && missing.includes(field.name)}
      <label class="flex min-w-0 flex-col gap-1">
        <span class="flex min-w-0 items-baseline gap-1.5">
          <span class="truncate font-mono text-(--solus-text-secondary)">{field.name}</span>
          {#if field.required}
            <span class={isMissing ? "text-(--solus-status-error)" : "text-(--solus-text-tertiary)"}>
              {isMissing ? "Required" : "required"}
            </span>
          {/if}
        </span>
        <Input
          bind:ref={inputs[index]}
          bind:value={values[index].value}
          class="h-8 min-w-0 text-workspace-chrome"
          placeholder={field.description ?? ""}
          aria-required={field.required}
          aria-invalid={isMissing}
          disabled={isSubmitting}
          mic={false}
          onkeydown={handleKeyDown}
        />
      </label>
    {/each}
  </div>

  <div class="flex min-w-0 items-center gap-2">
    <span class="min-w-0 flex-1 truncate {error ? 'text-(--solus-status-error)' : 'text-(--solus-text-tertiary)'}" role={error ? "alert" : undefined}>
      {#if error}
        {error}
      {:else}
        <span class="font-mono text-(--solus-text-primary)">⇥</span> next field ·
        <span class="font-mono text-(--solus-text-primary)">⏎</span> send ·
        <span class="font-mono text-(--solus-text-primary)">esc</span> close
      {/if}
    </span>
    <Button size="sm" type="submit" class="text-workspace-chrome pointer-coarse:min-h-11" disabled={isSubmitting} onkeydown={handleKeyDown}>
      {isSubmitting ? "Sending…" : submitLabel}
    </Button>
  </div>
</form>
