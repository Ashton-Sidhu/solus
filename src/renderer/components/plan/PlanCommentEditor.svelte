<script lang="ts">
  import { untrack } from 'svelte'
  import Input from '../ui/Input.svelte'
  import Button from '../ui/Button.svelte'

  interface Props {
    initialValue: string
    onSave: (text: string) => void
    onCancel: () => void
    placeholder?: string
    autoFocus?: boolean
  }

  let { initialValue, onSave, onCancel, placeholder = 'Edit comment…', autoFocus = true }: Props = $props()

  let value = $state(untrack(() => initialValue))
  let inputEl: HTMLInputElement | HTMLTextAreaElement | null = $state(null)

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

  // Mirror the create form: Enter commits, Shift+Enter inserts a newline, Esc cancels.
  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      e.stopPropagation()
      handleSubmit()
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onCancel()
    }
  }
</script>

<div class="flex flex-col gap-1.5">
  <Input
    bind:el={inputEl}
    bind:value
    type="textarea"
    variant="field"
    rows={3}
    {placeholder}
    onkeydown={handleKeydown}
    class="plan-comment-editor__field min-h-16 max-h-56 overflow-y-auto"
  />
  <div class="flex items-center justify-end gap-1.5">
    <Button variant="outline" size="sm" onclick={onCancel} class="text-(--solus-text-tertiary)">Cancel</Button>
    <Button variant="primary" size="sm" disabled={!value.trim()} onclick={handleSubmit}>Comment</Button>
  </div>
</div>
