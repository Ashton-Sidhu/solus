<script lang="ts">
  import { onMount } from "svelte";
  import { ChevronRight } from "@lucide/svelte";
  import { managedHostsStore, serversStore } from "../../contexts";
  import { connectionsNav } from "../connections/connections-nav.svelte";
  import { defaultSize, newCloudHostRequest } from "../onboarding/lib/cloud-compute";
  import { Button } from "../ui/button";

  /** "Create a cloud machine" (D8): a name, a size from the account's catalog, and
   *  optional packages and a setup script. It opens the new host's page when the
   *  directory lists it. */
  let name = $state("");
  let sizeId = $state<string | null>(null);
  let packages = $state("");
  let setupScript = $state("");

  const catalog = $derived(managedHostsStore.catalog ?? undefined);
  const organization = $derived(serversStore.organizations.find((entry) => entry.organizationId === managedHostsStore.organizationId) ?? null);
  const size = $derived(catalog?.sizes.find((entry) => entry.id === sizeId) ?? defaultSize(catalog));
  const request = $derived(newCloudHostRequest({ name, size, packages, setupScript }, organization, catalog));
  const isCreating = $derived(managedHostsStore.busy?.action === "create");

  onMount(() => void managedHostsStore.loadCatalog());

  async function create() {
    if (!request.ok || isCreating) return;
    const serverId = await managedHostsStore.create({ label: request.label, spec: request.spec });
    if (serverId) connectionsNav.open(serverId);
  }
</script>

{#if !managedHostsStore.canCreate}
  <p class="text-[0.8125rem] text-pretty text-(--solus-text-secondary)">
    A cloud machine belongs to an organization. Sign in to Solus, and create or join an organization on Solus Cloud.
  </p>
{:else}
  <form class="flex flex-col gap-4" onsubmit={(event) => { event.preventDefault(); void create(); }}>
    <label class="flex flex-col gap-1.5">
      <span class="text-[0.8125rem] text-(--solus-text-secondary)">Name</span>
      <input
        name="cloud-machine-name"
        bind:value={name}
        {@attach (element) => element.focus()}
        placeholder={organization ? `${organization.name} cloud host` : "Cloud host"}
        class="h-8 rounded-lg border border-border/60 bg-background px-2.5 text-workspace-chrome outline-none focus:border-(--solus-status-running)/50 max-sm:text-base"
      />
    </label>
    {#if catalog && catalog.sizes.length > 1}
      <fieldset class="flex flex-col gap-1.5">
        <legend class="mb-1.5 text-[0.8125rem] text-(--solus-text-secondary)">Size</legend>
        <div class="grid grid-cols-2 gap-2 @container @[34rem]:grid-cols-4" role="radiogroup" aria-label="Size">
          {#each catalog.sizes as entry (entry.id)}
            <button
              type="button"
              role="radio"
              aria-checked={size?.id === entry.id}
              onclick={() => (sizeId = entry.id)}
              class="flex flex-col rounded-lg border px-3 py-2 text-left {size?.id === entry.id ? 'border-(--solus-status-running)/60 bg-(--solus-status-running-bg)' : 'border-border/60 hover:bg-(--wash-1)'}"
            >
              <span class="text-[0.8125rem] font-medium">{entry.label}</span>
              <span class="text-chrome-dense text-muted-foreground">{entry.detail}</span>
            </button>
          {/each}
        </div>
      </fieldset>
    {/if}
    {#if catalog?.supportsPackages || catalog?.supportsSetupScript}
      <details class="group text-[0.8125rem]">
        <summary class="flex w-fit cursor-pointer list-none items-center gap-1 text-(--solus-text-secondary) hover:text-foreground">
          <ChevronRight size={12} class="transition-transform group-open:rotate-90 motion-reduce:transition-none" />Packages and setup script
        </summary>
        <div class="mt-2 flex flex-col gap-2">
          {#if catalog?.supportsPackages}
            <input name="cloud-machine-packages" bind:value={packages} placeholder="apt packages, for example postgresql-client ripgrep" aria-label="Packages"
              class="h-8 rounded-lg border border-border/60 bg-background px-2.5 font-mono text-chrome-dense outline-none focus:border-(--solus-status-running)/50 max-sm:text-base" />
          {/if}
          {#if catalog?.supportsSetupScript}
            <textarea name="cloud-machine-setup" bind:value={setupScript} rows="3" placeholder="A script that runs when the machine starts" aria-label="Setup script"
              class="rounded-lg border border-border/60 bg-background p-2.5 font-mono text-chrome-dense outline-none focus:border-(--solus-status-running)/50 max-sm:text-base"></textarea>
          {/if}
        </div>
      </details>
    {/if}
    {#if !request.ok}<p class="text-chrome-dense text-(--solus-status-error)" role="alert">{request.error}</p>{/if}
    {#if managedHostsStore.error && !isCreating}<p class="text-chrome-dense text-(--solus-status-error)" role="alert">{managedHostsStore.error}</p>{/if}
    <div class="flex items-center justify-between gap-3">
      <p class="text-chrome-dense text-muted-foreground">It is ready in about a minute. A stopped machine costs only its disk.</p>
      <Button type="submit" size="sm" disabled={!request.ok || isCreating}>{isCreating ? "Creating…" : "Create machine"}</Button>
    </div>
  </form>
{/if}
