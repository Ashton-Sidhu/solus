<script lang="ts">
  import { Paperclip as PaperclipIcon, X as XIcon } from '@lucide/svelte';
  import type { OutboundPrompt } from '@solus/contracts/types';
  import { getWorkspaceContext } from '../../../contexts';
  import { QueueEdit } from './lib/queue-edit.svelte';
  import { requestInputFocus } from '../../../lib/inputFocus';
  let { tabId, prompt, onClose }: { tabId: string; prompt: OutboundPrompt; onClose: () => void } = $props();
  const workspace = getWorkspaceContext();
  const edit = new QueueEdit(workspace.queue, tabId, prompt);
  let fileInput = $state<HTMLInputElement | null>(null);
  async function save() { if (await edit.save()) close(); }
  function close() { onClose(); requestInputFocus({ tabId }); }
</script>

<!-- Edits in the queued prompt's own place and shape, so it keeps its slot. -->
<div class="flex justify-end">
  <div class="w-full max-w-[41.25rem] rounded-[0.875rem] bg-[color-mix(in_oklch,var(--foreground)_3.5%,transparent)] py-2 pr-3.5 pl-3 shadow-[inset_0_0_0_0.03125rem_color-mix(in_oklch,var(--foreground)_18%,transparent)]" role="group" aria-label="Edit queued prompt">
    <!-- svelte-ignore a11y_autofocus -->
    <textarea bind:value={edit.text} disabled={edit.busy} rows={3} autofocus aria-label="Queued prompt text"
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
    <div class="mt-2 flex items-center gap-2.5 border-t border-[color-mix(in_oklch,var(--foreground)_8%,transparent)] pt-1.5 text-transcript-meta">
      <input bind:this={fileInput} type="file" multiple disabled={edit.busy} class="hidden"
        onchange={(event) => { void edit.add(Array.from(event.currentTarget.files ?? [])); event.currentTarget.value = ''; }} />
      <button type="button" disabled={edit.busy} onclick={() => fileInput?.click()}
        class="flex cursor-pointer items-center gap-1 text-(--solus-text-tertiary) transition-colors duration-100 hover:text-(--solus-text-primary) focus-visible:text-(--solus-text-primary) focus-visible:outline-none disabled:opacity-40 pointer-coarse:min-h-11"><PaperclipIcon size={12} />Attach</button>
      <span class="text-(--solus-text-tertiary) pointer-coarse:hidden">⌘Enter to save · Esc to cancel</span>
      <span class="flex-1"></span>
      <button type="button" disabled={edit.busy} onclick={close}
        class="cursor-pointer text-(--solus-text-tertiary) transition-colors duration-100 hover:text-(--solus-text-primary) focus-visible:text-(--solus-text-primary) focus-visible:outline-none pointer-coarse:min-h-11">Cancel</button>
      <button type="button" disabled={edit.busy} onclick={save}
        class="cursor-pointer font-medium text-(--solus-text-primary) transition-opacity duration-100 hover:opacity-80 focus-visible:underline focus-visible:outline-none disabled:opacity-40 pointer-coarse:min-h-11">{edit.busy ? 'Saving…' : 'Save'}</button>
    </div>
  </div>
</div>
