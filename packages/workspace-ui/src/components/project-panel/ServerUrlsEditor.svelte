<script lang="ts">
  import { Dialog } from 'bits-ui';
  import { runningServers } from '../../contexts/running-servers/running-servers.store.svelte';
  import { serverUrlsFromText } from '@solus/contracts/running-servers';
  import { requestInputFocus } from '../../lib/inputFocus';
  import { useScope } from '../../lib/keybindings/use-keybinding.svelte';
  import { Textarea } from '../ui/textarea';
  import { Button } from '../ui/button';

  let { hostId, checkoutPaths, onClose }: { hostId: string; checkoutPaths: readonly string[]; onClose: () => void } = $props();
  const store = $derived(runningServers.forHost(hostId));
  let selectedPath = $state('');
  const checkoutPath = $derived(checkoutPaths.includes(selectedPath) ? selectedPath : checkoutPaths[0]);
  let loadedPath = $state<string | null>(null);
  let value = $state('');
  let loading = $state(true);
  let saving = $state(false);
  let error = $state<string | null>(null);

  /** The URLs box takes focus once it holds the chosen folder's URLs; until then it is disabled. */
  function focusWhenLoaded(element: HTMLTextAreaElement): void {
    if (loading || loadedPath !== checkoutPath) return;
    element.focus();
  }
  useScope('modal-dialog', { exclusive: true, pre: true });
  $effect(() => {
    const path = checkoutPath;
    if (!path) return;
    let cancelled = false;
    loading = true;
    loadedPath = null;
    error = null;
    value = '';
    void store.configuredUrls(path).then((urls) => {
      if (!cancelled) { value = urls.join('\n'); loadedPath = path; }
    }).catch((cause) => { if (!cancelled) error = cause instanceof Error ? cause.message : String(cause); }).finally(() => { if (!cancelled) loading = false; });
    return () => { cancelled = true; };
  });
  async function save() {
    if (!checkoutPath || checkoutPath !== loadedPath) return;
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
      {#if checkoutPaths.length > 1}
        <label class="flex flex-col gap-1">
          Folder
          <select class="w-full rounded-md border border-(--solus-tool-border) bg-(--solus-container-bg) px-2 py-1 focus-visible:outline-2" value={checkoutPath} disabled={saving} onchange={(event) => { selectedPath = event.currentTarget.value; }}>
            {#each checkoutPaths as path (path)}<option value={path}>{path}</option>{/each}
          </select>
        </label>
      {/if}
      <Textarea aria-label="Server URLs" bind:value disabled={loading || saving || loadedPath !== checkoutPath} rows={5} placeholder="https://localhost:3000/admin" {@attach focusWhenLoaded} />
      {#if error}<p role="alert" class="text-(--solus-status-error)">{error}</p>{/if}
      <div class="flex justify-end gap-2"><Button variant="ghost" disabled={saving} onclick={onClose}>Cancel</Button><Button disabled={loading || saving || loadedPath !== checkoutPath} onclick={() => void save()}>{saving ? 'Saving…' : 'Save'}</Button></div>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
