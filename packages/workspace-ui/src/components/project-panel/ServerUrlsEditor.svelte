<script lang="ts">
  import { Dialog } from 'bits-ui';
  import { runningServers } from '../../contexts/running-servers/running-servers.store.svelte';
  import { serverUrlsFromText } from '@solus/contracts/running-servers';
  import { requestInputFocus } from '../../lib/inputFocus';
  import { useScope } from '../../lib/keybindings/use-keybinding.svelte';
  import { Textarea } from '../ui/textarea';
  import { Button } from '../ui/button';

  let { hostId, checkoutPath, onClose }: { hostId: string; checkoutPath: string; onClose: () => void } = $props();
  const store = $derived(runningServers.forHost(hostId));
  let value = $state('');
  let loading = $state(true);
  let saving = $state(false);
  let error = $state<string | null>(null);
  useScope('modal-dialog', { exclusive: true, pre: true });
  $effect(() => {
    let cancelled = false;
    loading = true;
    void store.configuredUrls(checkoutPath).then((urls) => { if (!cancelled) value = urls.join('\n'); }).catch((cause) => { if (!cancelled) error = cause instanceof Error ? cause.message : String(cause); }).finally(() => { if (!cancelled) loading = false; });
    return () => { cancelled = true; };
  });
  async function save() {
    saving = true;
    error = null;
    try { await store.configureUrls(checkoutPath, serverUrlsFromText(value)); onClose(); }
    catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
    finally { saving = false; }
  }
</script>

<Dialog.Root open onOpenChange={(open) => { if (!open && !saving) onClose(); }}>
  <Dialog.Portal>
    <Dialog.Overlay class="fixed inset-0 z-50 modal-backdrop" />
    <Dialog.Content data-solus-ui onCloseAutoFocus={(event) => { event.preventDefault(); requestInputFocus(); }} class="no-drag fixed inset-0 z-50 m-auto flex h-fit w-[min(30rem,calc(100vw-2rem))] flex-col gap-4 rounded-2xl border border-(--solus-tool-border) bg-(--solus-container-bg) p-6 text-workspace-chrome shadow-(--solus-popover-shadow)">
      <Dialog.Title class="font-medium">Server URLs</Dialog.Title>
      <Dialog.Description class="text-(--solus-text-secondary)">One local HTTP or HTTPS URL per line. Paths and query strings are kept. Solus checks only these URLs.</Dialog.Description>
      <Textarea aria-label="Server URLs" bind:value disabled={loading || saving} rows={5} placeholder="https://localhost:3000/admin" />
      {#if error}<p role="alert" class="text-(--solus-status-error)">{error}</p>{/if}
      <div class="flex justify-end gap-2"><Button variant="ghost" disabled={saving} onclick={onClose}>Cancel</Button><Button disabled={loading || saving} onclick={() => void save()}>{saving ? 'Saving…' : 'Save'}</Button></div>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
