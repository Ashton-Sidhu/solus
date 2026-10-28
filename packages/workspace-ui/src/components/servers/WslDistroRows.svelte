<script lang="ts">
  /** The WSL distros of a Windows host that it does not reach yet, each with
   *  Add (docs/plans/windows.md §5.13). State lives in `addWslDistroStore`. */
  import { LoaderCircle as LoaderIcon } from "@lucide/svelte";
  import { wslHostLabel } from "@solus/contracts/remote-machines";
  import { Button } from "../ui/button";
  import HostOperatingSystemIcon from "./HostOperatingSystemIcon.svelte";
  import { addWslDistroStore as store } from "./add-wsl-distro.store.svelte";

  interface Props {
    hostId: string;
    /** Say why the host offers no distro. Off in the nearby list, where a Windows host without WSL is the usual case. */
    reportsUnavailable?: boolean;
  }

  let { hostId, reportsUnavailable = false }: Props = $props();

  $effect(() => store.watch(hostId));

  const listing = $derived(store.listings.get(hostId));
  const distros = $derived(store.addableDistros(hostId));
</script>

{#each distros as distro (distro.name)}
  {@const isThisAdding = store.isAdding && store.hostId === hostId && store.distro === distro.name}
  <div class="flex items-center gap-3 px-4 py-3">
    <span
      class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-(--solus-surface-hover) text-(--solus-text-tertiary)"
    >
      <HostOperatingSystemIcon os="linux" size={15} />
    </span>
    <div class="min-w-0 flex-1">
      <p class="truncate text-workspace-chrome font-medium text-(--solus-text-primary)">
        {wslHostLabel(distro.name)}
      </p>
      <p class="mt-0.5 truncate text-chrome-dense text-(--solus-text-tertiary)">
        {distro.isDefault ? "Default · " : ""}WSL {distro.version} · Solus installs itself there
      </p>
    </div>
    <Button
      variant="outline"
      size="sm"
      class="shrink-0"
      aria-label={`Add ${wslHostLabel(distro.name)}`}
      disabled={store.isAdding}
      onclick={() => void store.add(hostId, distro.name)}
    >
      {#if isThisAdding}
        <LoaderIcon size={13} class="animate-spin motion-reduce:animate-none" />
        Adding…
      {:else}
        Add
      {/if}
    </Button>
  </div>
{/each}

{#if reportsUnavailable && listing?.status === "unavailable"}
  <p class="px-4 py-3 text-pretty text-chrome-dense text-(--solus-text-tertiary)">{listing.message}</p>
{/if}
