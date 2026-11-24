<script lang="ts">
  import { Paperclip as PaperclipIcon, X as XIcon } from '@lucide/svelte';
  import SessionChip from '../../pickers/SessionChip.svelte';
  import { Button } from '../../ui/button';
  import type { QueueEdit } from './lib/queue-edit.svelte';
  import { requestInputFocus } from '../../../lib/inputFocus';
  import { formatComboText } from '../../../lib/keybindings/match';
  const saveKey = formatComboText({ mod: true, code: 'Enter' });
  let { tabId, edit, onClose }: { tabId: string; edit: QueueEdit; onClose: () => void } = $props();
  let editor = $state<HTMLTextAreaElement | null>(null);
  let fileInput = $state<HTMLInputElement | null>(null);
  async function save() { if (await edit.save()) close(); }
  function close() { onClose(); requestInputFocus({ tabId }); }
</script>

<!-- Edits in the queued prompt's own place and shape, so it keeps its slot. -->
<div class="flex justify-end">
  <div class="w-full max-w-[41.25rem] rounded-[0.875rem] bg-[color-mix(in_oklch,var(--foreground)_3.5%,transparent)] py-2 pr-3.5 pl-3 shadow-[inset_0_0_0_0.03125rem_color-mix(in_oklch,var(--foreground)_18%,transparent)]" role="group" aria-label="Edit queued prompt">
    <!-- svelte-ignore a11y_autofocus -->
    <textarea bind:this={editor} bind:value={edit.text} disabled={edit.busy} rows={3} autofocus aria-label="Queued prompt text"
      class="block max-h-[12lh] w-full resize-none bg-transparent field-sizing-content text-transcript-card leading-(--text-transcript-card--line-height) text-(--solus-text-primary) outline-none"
      onkeydown={(event) => { if (event.key === 'Escape') { event.preventDefault(); close(); } if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void save(); } }}></textarea>
    {#if edit.attachments?.length}
      <div class="mt-1.5 flex flex-wrap gap-1.5">
        {#each edit.attachments as attachment, index (attachment.id)}
          <span class="flex max-w-[11.25rem] items-center gap-1 rounded-[0.625rem] bg-[color-mix(in_oklch,var(--foreground)_5%,transparent)] py-0.5 pr-1 pl-2 text-xs text-(--solus-text-secondary)">
            <span class="min-w-0 truncate">{attachment.name}</span>
            <button type="button" disabled={edit.busy} onclick={() => edit.removeAttachment(index)} aria-label={`Remove ${attachment.name}`}
              class="flex shrink-0 cursor-pointer items-center rounded text-(--solus-text-tertiary) hover:text-(--solus-text-primary) focus-visible:text-(--solus-text-primary) focus-visible:outline-none pointer-coarse:min-h-11"><XIcon size={12} /></button>
          </span>
        {/each}
      </div>
    {/if}
    {#if edit.error}<p role="alert" class="mt-1.5 text-transcript-meta text-(--destructive)">{edit.error}</p>{/if}
    <!-- One quiet meta row: the tools on the left at the transcript-meta rung,
         and Save as the only filled control, so the next step reads at a glance. -->
    <div class="mt-2 flex items-center gap-1 border-t border-[color-mix(in_oklch,var(--foreground)_8%,transparent)] pt-2 text-transcript-meta">
      <input bind:this={fileInput} type="file" multiple disabled={edit.busy} class="hidden"
        onchange={(event) => { void edit.add(Array.from(event.currentTarget.files ?? [])); event.currentTarget.value = ''; }} />
      <Button variant="ghost" size="icon-xs" disabled={edit.busy} onclick={() => fileInput?.click()} aria-label="Attach files" title="Attach files"
        class="-ml-1 text-(--solus-text-tertiary) hover:text-(--solus-text-primary) pointer-coarse:size-11"><PaperclipIcon size={14} /></Button>
      <SessionChip {tabId} bind:selection={edit.model} disabled={edit.busy} ariaLabel="Model for this prompt"
        class="h-6 gap-1 rounded-md border-0 px-1.5 text-transcript-meta [&>span:first-child_svg]:size-3.5 pointer-coarse:h-11"
        onSelectionChange={() => edit.markModelChanged()} onReturnFocus={() => editor?.focus()} />
      <span class="flex-1"></span>
      <Button variant="ghost" size="xs" disabled={edit.busy} onclick={close}
        class="text-transcript-meta text-(--solus-text-tertiary) hover:text-(--solus-text-primary) pointer-coarse:h-11">Cancel<span class="opacity-60 pointer-coarse:hidden">Esc</span></Button>
      <Button size="xs" disabled={edit.busy} onclick={save} class="text-transcript-meta pointer-coarse:h-11">
        {edit.busy ? 'Saving…' : 'Save'}<span class="opacity-70 pointer-coarse:hidden">{saveKey}</span>
      </Button>
    </div>
  </div>
</div>
