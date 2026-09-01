<script lang="ts">
  import { onMount, untrack } from 'svelte'
  import { XIcon } from 'phosphor-svelte'
  import { MONO_FONT } from '../../lib/diffTheme'
  import { MarkdownTextarea } from '../ui/markdown-field'
  import { Button } from '../ui/button'

  interface Props {
    onSave: (comment: string) => void
    onCancel: () => void
    rangeLabel?: string
    initialValue?: string
    onFormValueChange?: (value: string) => void
  }

  let {
    onSave,
    onCancel,
    rangeLabel,
    initialValue = '',
    onFormValueChange,
  }: Props = $props()
  let value = $state(untrack(() => initialValue))
  let lastInitialValue = $state(untrack(() => initialValue))
  let inputEl: HTMLTextAreaElement | null = $state(null)

  onMount(() => {
    setTimeout(() => inputEl?.focus(), 30)
  })

  $effect(() => {
    if (initialValue === lastInitialValue) return
    lastInitialValue = initialValue
    value = initialValue
  })

  const canSave = $derived(value.trim().length > 0)

  function handleInput(e: Event) {
    value = (e.target as HTMLTextAreaElement).value
    onFormValueChange?.(value)
  }

  function handleSave() {
    if (!canSave) return
    onSave(value.trim())
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
    }
  }
</script>

<div class="diff-comment-form flex flex-col gap-1.5 rounded-[0.625rem] border border-(--solus-accent-border) bg-(--solus-popover-bg) px-2.5 py-2 font-(family-name:--solus-font-family) shadow-(--solus-popover-shadow) backdrop-blur-xl">
  {#if rangeLabel}
    <span
      class="text-[0.625rem] font-medium tracking-wider text-(--solus-text-tertiary) uppercase inline-block"
      style="font-family:{MONO_FONT}"
    >
      {rangeLabel}
    </span>
  {/if}
  <MarkdownTextarea
    bind:ref={inputEl}
    bind:value
    bare
    placeholder="Add a comment… ⌘↵"
    rows={1}
    oninput={handleInput}
    onkeydown={handleKeyDown}
    onSubmit={handleSave}
    class="min-h-8 max-h-30 overflow-y-auto"
  />
  <div class="flex items-center justify-end gap-1.5">
    <Button variant="ghost" size="icon-sm" onclick={onCancel} class="text-(--solus-text-tertiary)">
      <XIcon size={13} />
    </Button>
    <Button size="sm" disabled={!canSave} onclick={handleSave}>
      Comment
    </Button>
  </div>
</div>

<style>
  .diff-comment-form {
    animation: diff-comment-in 0.15s ease-out both;
  }
  @keyframes diff-comment-in {
    from { opacity: 0; transform: translateY(-0.1875rem); }
    to   { opacity: 1; transform: translateY(0); }
  }
</style>
