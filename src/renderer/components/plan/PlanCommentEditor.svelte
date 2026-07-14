<script lang="ts">
  import { untrack } from 'svelte'
  import { MarkdownTextarea } from '../ui/markdown-field'
  import { Button } from '../ui/button'

  interface Props {
    initialValue: string
    onSave: (text: string) => void
    onCancel: () => void
    placeholder?: string
    autoFocus?: boolean
  }

  let { initialValue, onSave, onCancel, placeholder = 'Edit comment…', autoFocus = true }: Props = $props()

  let value = $state(untrack(() => initialValue))
  let inputEl: HTMLTextAreaElement | null = $state(null)

  $effect(() => {
    if (autoFocus && inputEl) {
      inputEl.focus()
      const ta = inputEl as HTMLTextAreaElement
      ta.setSelectionRange(value.length, value.length)
    }
  })

  function handleSubmit() {
    if (value.trim()) onSave(value.trim())
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) e.stopPropagation()
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onCancel()
    }
  }
</script>

<div class="flex flex-col gap-1.5">
  <MarkdownTextarea
    bind:ref={inputEl}
    bind:value
    rows={3}
    {placeholder}
    onkeydown={handleKeydown}
    onSubmit={handleSubmit}
    submitOn="enter"
    class="plan-comment-editor__field min-h-16 max-h-56 overflow-y-auto"
  />
  <div class="flex items-center justify-end gap-1.5">
    <Button variant="outline" size="sm" onclick={onCancel} class="text-(--solus-text-tertiary)">Cancel</Button>
    <Button size="sm" disabled={!value.trim()} onclick={handleSubmit}>Comment</Button>
  </div>
</div>
