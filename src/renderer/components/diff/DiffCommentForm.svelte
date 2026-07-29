<script lang="ts">
  import { onMount, untrack } from 'svelte'
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

  export function focusInput() {
    if (!inputEl) return
    inputEl.focus()
    const end = inputEl.value.length
    inputEl.setSelectionRange(end, end)
  }

  onMount(() => {
    setTimeout(focusInput, 30)
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

<!-- Defined by an accent ring rather than a border, so the composer reads as a
     card floating over the code rather than another row in it. -->
<div
  class="diff-comment-form flex flex-col gap-1.5 rounded-xl bg-(--solus-popover-bg) px-3 py-2.5 font-(family-name:--solus-font-family)"
  style="box-shadow:0 0 0 0.0625rem color-mix(in oklab, var(--solus-accent) 30%, transparent), 0 1rem 2.25rem -1.375rem rgba(0, 0, 0, 0.5)"
>
  {#if rangeLabel}
    <span
      class="inline-block text-[0.625rem] text-(--solus-text-tertiary) tabular-nums"
      style="font-family:{MONO_FONT}"
    >
      {rangeLabel}
    </span>
  {/if}
  <MarkdownTextarea
    bind:ref={inputEl}
    bind:value
    bare
    mic
    placeholder="What should change here?"
    rows={1}
    oninput={handleInput}
    onkeydown={handleKeyDown}
    onSubmit={handleSave}
    class="min-h-8 max-h-30 overflow-y-auto"
  />
  <div class="flex items-center justify-end gap-1.5">
    <span
      class="mr-auto text-[0.625rem] text-(--solus-text-tertiary)"
      style="font-family:{MONO_FONT}"
    >
      ⌘↵ to save
    </span>
    <Button variant="ghost" size="xs" onclick={onCancel} class="text-(--solus-text-tertiary)">
      Cancel
    </Button>
    <Button size="xs" disabled={!canSave} onclick={handleSave}>
      Add comment
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
