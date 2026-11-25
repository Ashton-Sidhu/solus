<script lang="ts">
  /** The ways this client reaches a host, the first it tries at the top
   *  (docs/plans/host-routes.md §12): what each one does now (in use, standby,
   *  refused, and so on), and the controls to add
   *  an address, change the order, and remove a route. */
  import { ArrowDown as ArrowDownIcon, ArrowUp as ArrowUpIcon, X as XIcon } from "@lucide/svelte";
  import { routeBlockText, routeKindLabel } from "@solus/client-core/host-route-control";
  import { Button } from "../ui/button";
  import { Input } from "../ui/input";
  import SettingsSection from "../settings/SettingsSection.svelte";
  import { hostRoutesStore } from "./host-routes.store.svelte";
  import RouteStateIcon from "./RouteStateIcon.svelte";

  interface Props {
    serverId: string;
  }

  let { serverId }: Props = $props();

  const isLocal = $derived(hostRoutesStore.isLocal(serverId));
  const localStatus = $derived(hostRoutesStore.localRoutesStatus(serverId));
  const rows = $derived(hostRoutesStore.statesFor(serverId));
  const canChange = $derived(hostRoutesStore.canChange(serverId));
  let address = $state("");
  let isChecking = $state(false);
  let addError = $state<string | null>(null);
  let confirmingRemoveUrl = $state<string | null>(null);

  async function addRoute() {
    if (isChecking || !address.trim()) return;
    isChecking = true;
    addError = await hostRoutesStore.add(serverId, address);
    isChecking = false;
    if (!addError) address = "";
  }

  function removeRoute(url: string) {
    void hostRoutesStore.remove(serverId, url);
    confirmingRemoveUrl = null;
  }
</script>

<SettingsSection
  label="Routes"
  description={isLocal
    ? "Addresses this host shares with other devices. Network settings are in Access."
    : canChange
    ? "Solus uses the first route that answers as this host, and moves back to an earlier route when it answers again. This list is for this device."
    : "These routes are set by the host or its connection."}
>
  {#each rows as row, index (row.url)}
    <div class="flex flex-col gap-2 px-4 py-3">
      <div class="flex items-center gap-2">
        <div class="min-w-0 flex-1">
          <p class="flex items-center gap-2 text-workspace-chrome text-(--solus-text-primary)">
            {#if row.state && row.stateText && row.state !== "blocked"}<RouteStateIcon state={row.state} label={row.stateText} />{/if}
            {routeKindLabel(row.kind)}
          </p>
          <p class="mt-0.5 truncate font-mono text-chrome-dense text-(--solus-text-tertiary)">
            {row.url}{row.isLearned ? " · found automatically" : ""}
          </p>
          {#if row.block}
            <p class="mt-0.5 text-chrome-dense text-(--solus-text-tertiary)">{routeBlockText(row.block)}</p>
          {/if}
        </div>
        {#if canChange}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Move ${row.url} up`}
            disabled={index === 0}
            onclick={() => hostRoutesStore.move(serverId, row.url, -1)}
          >
            <ArrowUpIcon size={16} />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Move ${row.url} down`}
            disabled={index === rows.length - 1}
            onclick={() => hostRoutesStore.move(serverId, row.url, 1)}
          >
            <ArrowDownIcon size={16} />
          </Button>
          {#if row.canRemove}
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Remove ${row.url}`}
              onclick={() => (confirmingRemoveUrl = row.url)}
            >
              <XIcon size={16} />
            </Button>
          {/if}
        {/if}
      </div>
      {#if confirmingRemoveUrl === row.url}
        <div class="flex items-center justify-end gap-3">
          <Button variant="ghost" size="sm" onclick={() => (confirmingRemoveUrl = null)}>Cancel</Button>
          <Button variant="destructive" size="sm" onclick={() => removeRoute(row.url)}>Remove route</Button>
        </div>
      {/if}
    </div>
  {:else}
    <p class="px-4 py-6 text-center text-chrome-dense text-(--solus-text-tertiary)">{localStatus ?? (isLocal ? "This host has no network routes. Check its network settings in Access." : "This device has no route to this host.")}</p>
  {/each}

  {#if canChange}
    <form
      class="flex flex-col gap-2 px-4 py-3"
      onsubmit={(event) => {
        event.preventDefault();
        void addRoute();
      }}
    >
      <div class="flex items-center gap-2">
        <Input
          bind:value={address}
          placeholder="https://solus.example.com or 10.0.0.8:3000"
          aria-label="Address of a new route"
          autocapitalize="off"
          spellcheck={false}
          oninput={() => (addError = null)}
          class="min-w-0 flex-1"
        />
        <Button type="submit" variant="outline" size="sm" class="shrink-0" disabled={isChecking || !address.trim()}>
          {isChecking ? "Checking…" : "Add route"}
        </Button>
      </div>
      {#if addError}
        <p class="cursor-text select-text text-pretty text-chrome-dense text-destructive" role="alert">{addError}</p>
      {/if}
    </form>
  {/if}
</SettingsSection>
