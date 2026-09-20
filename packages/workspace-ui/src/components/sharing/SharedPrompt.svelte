<script lang="ts">
  import { SharedPromptStore } from '../../contexts/sharing/shared-prompt.store.svelte'
  import { Button } from '../ui/button'
  let { serverId, sessionId, editable, ownAccount = false }: { serverId: string; sessionId: string; editable: boolean; ownAccount?: boolean } = $props()
  const store = new SharedPromptStore()
  $effect(() => store.watch(serverId, sessionId))
  let input: HTMLTextAreaElement | undefined = $state()
  async function send() {
    await store.send(serverId, sessionId)
    input?.focus()
  }
</script>
<div class="px-4 py-3 text-workspace-chrome" data-testid="guest-composer">
  <div class="mx-auto flex max-w-(--solus-reading-max) items-end gap-2 rounded-xl border border-(--hairline) p-3">
    <textarea bind:this={input} bind:value={store.text} disabled={!editable || !store.available || store.sending} aria-label="Prompt" rows="2" class="min-w-0 flex-1 resize-none bg-transparent outline-none" placeholder={editable ? 'Send a prompt to this session…' : 'You can view this session but not send prompts.'} onkeydown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (editable && store.text.trim() && !store.sending) void send() } }}></textarea>
    <Button disabled={!editable || !store.available || !store.text.trim() || store.sending} onclick={() => void send()}>{store.sending ? 'Sending…' : 'Send'}</Button>
  </div>
  <p class="mx-auto max-w-(--solus-reading-max) pt-2 text-muted-foreground" role={store.error ? 'alert' : undefined}>{store.error ?? (!store.available ? 'This session’s runner is offline. You can still read its cloud transcript.' : editable ? ownAccount ? 'Prompts run on your cloud account. Connect a provider in Solus cloud first.' : 'Prompts run on the sharer’s account. The runner must be online. Tool approvals stay with the sharer.' : 'This link allows viewing only.')}</p>
</div>
