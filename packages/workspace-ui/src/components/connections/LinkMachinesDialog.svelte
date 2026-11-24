<script lang="ts">
  /** Link one machine to several others at once (docs/host-pairing.md): the
   *  source gets owner access on each selected machine. Opened from the host
   *  map: its toolbar, a host's menu, and the Machine links section. A machine
   *  that fails stays selected, so Link tries it again. */
  import { onMount, untrack } from "svelte";
  import { Dialog } from "bits-ui";
  import { X } from "@lucide/svelte";
  import { SvelteMap, SvelteSet } from "svelte/reactivity";
  import { linkMachines, machineLinkChoices, type MachineLinkOutcome } from "@solus/client-core/host-linking";
  import { routeKindLabel } from "@solus/client-core/host-route-control";
  import { MachineLinks } from "../../contexts/connections/machine-links.svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import SettingsSelect from "../settings/SettingsSelect.svelte";
  import { Button } from "../ui/button";
  import { Checkbox } from "../ui/checkbox";

  interface Props {
    /** The host that gets owner access. Without one, the first owner machine. */
    sourceServerId?: string;
    /** The machines selected when it opens, as Link back selects the machine to link back to. */
    targetIds?: string[];
    onClose: () => void;
  }

  let { sourceServerId, targetIds, onClose }: Props = $props();
  let open = $state(true);
  let topology = $state<MachineLinks>();
  /** The source picked in the dialog; until then, the host it was opened for. */
  let pickedSourceId = $state("");
  let isLinking = $state(false);
  let notice = $state("");
  const selected = new SvelteSet<string>(untrack(() => targetIds) ?? []);
  const outcomes = new SvelteMap<string, MachineLinkOutcome>();
  const sources = $derived([...(topology?.machines.entries() ?? [])].map(([serverId, machine]) => ({ serverId, machine })));
  const sourceEntry = $derived(sourceServerId && !pickedSourceId
    ? sources.find((entry) => entry.serverId === sourceServerId)
    : sources.find((entry) => entry.serverId === pickedSourceId) ?? sources[0]);
  const source = $derived(sourceEntry?.machine);
  const choices = $derived(source ? machineLinkChoices(source, sources.map((entry) => entry.machine)) : []);
  const linkable = $derived(choices.filter((choice) => outcomes.get(choice.id) !== "linked"));
  const chosen = $derived(linkable.filter((choice) => selected.has(choice.id)));
  const sourceOptions = $derived(sources.map((entry) => ({ value: entry.serverId, label: entry.machine.label })));

  onMount(() => {
    const links = new MachineLinks();
    topology = links;
    return () => links.dispose();
  });

  function pickSource(serverId: string) {
    pickedSourceId = serverId;
    selected.clear();
    outcomes.clear();
    notice = "";
  }

  function chooseAll(isChosen: boolean) {
    for (const choice of linkable) {
      if (isChosen) selected.add(choice.id);
      else selected.delete(choice.id);
    }
  }

  async function link() {
    if (!source || isLinking || !chosen.length) return;
    isLinking = true;
    notice = "";
    try {
      await linkMachines(source, chosen, (id, outcome) => {
        outcomes.set(id, outcome);
        if (outcome === "linked") selected.delete(id);
      });
      if ([...outcomes.values()].some((outcome) => outcome === "failed")) notice = "Some links failed. The failed machines stay selected.";
      else open = false;
    } finally { isLinking = false; }
  }
</script>

<Dialog.Root bind:open onOpenChangeComplete={(isOpen) => { if (!isOpen) { onClose(); requestInputFocus(); } }}>
  <Dialog.Portal>
    <Dialog.Overlay class="fixed inset-0 z-[10001] modal-backdrop duration-150 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 motion-reduce:animate-none" />
    <Dialog.Content
      class="text-workspace-chrome fixed inset-0 z-[10001] m-auto flex h-fit max-h-[calc(100dvh-2rem)] w-[min(32rem,calc(100vw-2rem))] flex-col gap-4 overflow-y-auto rounded-2xl bg-(--solus-popover-bg) p-6 shadow-(--solus-popover-shadow) duration-150 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 motion-reduce:animate-none"
    >
      <Dialog.Close>
        {#snippet child({ props })}
          <Button {...props} variant="ghost" size="icon-sm" class="absolute top-4 right-4 text-muted-foreground pointer-coarse:tap-area" aria-label="Close"><X size={16} /></Button>
        {/snippet}
      </Dialog.Close>

      <div class="flex flex-col gap-1 pr-8">
        <Dialog.Title class="font-medium text-foreground">Link machines</Dialog.Title>
        <Dialog.Description class="text-pretty text-chrome-dense text-(--solus-text-secondary)">
          {source ? `${source.label} gets owner access on each machine you select.` : "One machine gets owner access on each machine you select."}
        </Dialog.Description>
      </div>

      {#if !topology || (!sources.length && !sourceServerId)}
        <p class="text-(--solus-text-secondary)">Connect to a machine you own to link it to others.</p>
      {:else if !source}
        <p role="status" class="text-(--solus-text-secondary)">Solus can link from this machine only while it is connected and you own it.</p>
      {:else}
        {#if sources.length > 1}
          <div class="flex flex-wrap items-center gap-2 text-chrome-dense text-(--solus-text-secondary)">
            Link from
            <SettingsSelect options={sourceOptions} value={sourceEntry?.serverId ?? ""} onSelect={pickSource} disabled={isLinking} ariaLabel="Link from" compact />
          </div>
        {/if}
        {#if !choices.length}
          <p class="text-(--solus-text-secondary)">No other machine with a pairing route is available.</p>
        {:else}
          <fieldset class="overflow-hidden rounded-lg border border-border" disabled={isLinking}>
            <legend class="sr-only">Machines to link from {source.label}</legend>
            <label class="flex cursor-pointer items-center gap-3 border-b border-border px-3 py-2 text-chrome-dense text-(--solus-text-secondary) pointer-coarse:min-h-11">
              <Checkbox
                checked={linkable.length > 0 && chosen.length === linkable.length}
                indeterminate={chosen.length > 0 && chosen.length < linkable.length}
                disabled={!linkable.length}
                onCheckedChange={(isChosen) => chooseAll(isChosen)}
              />
              Select all
            </label>
            {#each choices as choice (choice.id)}
              {@const outcome = outcomes.get(choice.id)}
              <label class="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-(--solus-surface-hover) has-disabled:cursor-default pointer-coarse:min-h-11">
                <Checkbox
                  checked={selected.has(choice.id) || outcome === "linked"}
                  disabled={outcome === "linked"}
                  onCheckedChange={(isChosen) => { if (isChosen) selected.add(choice.id); else selected.delete(choice.id); }}
                />
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-(--solus-text-primary)">{choice.label}</span>
                  <span class="block truncate text-chrome-dense text-(--solus-text-tertiary)">{routeKindLabel(choice.route.kind)} · {choice.route.url}{choice.viaLabel ? ` · via ${choice.viaLabel}` : ""}</span>
                </span>
                {#if outcome === "failed"}<span class="shrink-0 text-chrome-dense text-(--solus-status-error)">Link failed</span>{/if}
                {#if outcome === "linked"}<span class="shrink-0 text-chrome-dense text-(--solus-text-tertiary)">Linked</span>{/if}
              </label>
            {/each}
          </fieldset>
        {/if}
      {/if}

      {#if notice}<p role="status" class="text-chrome-dense text-(--solus-status-error)">{notice}</p>{/if}

      <div class="flex justify-end gap-2 pt-1">
        <Button variant="outline" size="sm" class="pointer-coarse:min-h-11" onclick={() => { open = false; }}>Cancel</Button>
        <Button size="sm" class="pointer-coarse:min-h-11" disabled={isLinking || !chosen.length} onclick={() => void link()}>
          {isLinking ? "Linking…" : chosen.length ? `Link ${chosen.length} ${chosen.length === 1 ? "machine" : "machines"}` : "Link machines"}
        </Button>
      </div>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
