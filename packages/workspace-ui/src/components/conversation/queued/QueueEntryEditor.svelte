<script lang="ts">
  import type { OutboundPrompt } from '@solus/contracts/types';
  import { getWorkspaceContext } from '../../../contexts';
  import { QueueEdit } from './lib/queue-edit.svelte';
  import { requestInputFocus } from '../../../lib/inputFocus';
  let { tabId, prompt, onClose }: { tabId: string; prompt: OutboundPrompt; onClose: () => void } = $props();
  const workspace = getWorkspaceContext();
  const edit = new QueueEdit(workspace.queue, tabId, prompt);
  async function save() { if (await edit.save()) close(); }
  function close() { onClose(); requestInputFocus({ tabId }); }
</script>

<div class="flex flex-col gap-2 py-2" aria-label="Edit queued prompt">
  <label class="text-workspace-chrome font-medium" for={`queue-edit-${prompt.queueId}`}>Edit queued prompt</label>
  <textarea id={`queue-edit-${prompt.queueId}`} bind:value={edit.text} disabled={edit.busy} rows={3}
    class="w-full resize-y rounded-lg border border-(--border) bg-(--background) p-2 text-workspace-chrome"
    onkeydown={(event) => { if (event.key === 'Escape') close(); if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void save(); } }} />
  {#each edit.attachments ?? [] as attachment, index (attachment.id)}
    <div class="flex items-center justify-between gap-2 text-workspace-chrome">
      <span class="min-w-0 break-all">{attachment.name}</span>
      <button type="button" disabled={edit.busy} onclick={() => edit.removeAttachment(index)} class="rounded px-2 py-1 hover:bg-(--muted) pointer-coarse:min-h-11" aria-label={`Remove ${attachment.name}`}>Remove</button>
    </div>
  {/each}
  <label class="text-workspace-chrome">Add files
    <input type="file" multiple disabled={edit.busy} class="block w-full text-workspace-chrome"
      onchange={(event) => { void edit.add(Array.from(event.currentTarget.files ?? [])); event.currentTarget.value = ''; }} />
  </label>
  {#if edit.error}<p role="alert" class="text-workspace-chrome text-(--destructive)">{edit.error}</p>{/if}
  <div class="flex flex-wrap justify-end gap-2">
    <button type="button" disabled={edit.busy} onclick={close} class="rounded px-3 py-2 text-workspace-chrome hover:bg-(--muted) pointer-coarse:min-h-11">Cancel</button>
    <button type="button" disabled={edit.busy} onclick={save} class="rounded bg-(--primary) px-3 py-2 text-workspace-chrome text-(--primary-foreground) pointer-coarse:min-h-11">{edit.busy ? 'Saving…' : 'Save'}</button>
  </div>
</div>
