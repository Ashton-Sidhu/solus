<script lang="ts">
  import { onMount } from "svelte";
  import { ChevronRight } from "@lucide/svelte";
  import { localApi } from "@solus/client-core/local-api";
  import { accountStore, managedHostsStore, serversStore } from "../../contexts";
  import { consolePageUrl } from "../session/lib/account-menu";
  import SettingsSelect from "../settings/SettingsSelect.svelte";
  import { Input } from "../ui/input";
  import { Textarea } from "../ui/textarea";
  import { connectionsNav } from "../connections/connections-nav.svelte";
  import { defaultSize, newCloudHostRequest } from "../onboarding/lib/cloud-compute";
  import { Button } from "../ui/button";

  /** "Create a cloud machine": a name, a size from the account's catalog, and
   *  optional packages and a setup script. It opens the new host's page when the
   *  directory lists it. A cloud machine belongs to an organization, so a person
   *  who is signed out signs in here, and a person with several organizations
   *  chooses one here: the way to the form is on the form's own place. */
  let name = $state("");
  let sizeId = $state<string | null>(null);
  let packages = $state("");
  let setupScript = $state("");

  const catalog = $derived(managedHostsStore.catalog ?? undefined);
  const organization = $derived(serversStore.organizations.find((entry) => entry.organizationId === managedHostsStore.organizationId) ?? null);
  const size = $derived(catalog?.sizes.find((entry) => entry.id === sizeId) ?? defaultSize(catalog));
  const request = $derived(newCloudHostRequest({ name, size, packages, setupScript }, organization, catalog));
  const isCreating = $derived(managedHostsStore.busy?.action === "create");

  const account = $derived(accountStore.state);
  const isSigningIn = $derived(account.kind === "signing-in");
  let signInFailed = $state(false);

  onMount(() => void managedHostsStore.loadCatalog());

  async function signIn() {
    signInFailed = false;
    const ended = await accountStore.signIn();
    // The organizations come with the account: read them again so the form opens.
    if (ended === "approved") await Promise.all([managedHostsStore.loadCatalog(), serversStore.refreshDirectory()]);
    else if (ended === "error") signInFailed = true;
  }

  async function create() {
    if (!request.ok || isCreating) return;
    const serverId = await managedHostsStore.create({ label: request.label, spec: request.spec });
    if (serverId) connectionsNav.open(serverId);
  }
</script>

{#if account.kind !== "signed-in"}
  <div class="flex flex-wrap items-center justify-between gap-3">
    <p class="min-w-0 flex-1 basis-60 text-[0.8125rem] text-pretty text-(--solus-text-secondary)">
      {accountStore.isAvailable
        ? "A cloud machine belongs to an organization. Sign in to Solus to create one."
        : "A cloud machine belongs to an organization. Open Solus from your Solus Cloud account, or use the desktop app, to create one."}
    </p>
    {#if accountStore.isAvailable}
      <Button size="sm" disabled={isSigningIn} onclick={() => void signIn()}>{isSigningIn ? "Waiting for the browser…" : "Sign in"}</Button>
    {/if}
  </div>
  {#if signInFailed}<p class="mt-2 text-chrome-dense text-(--solus-status-error)" role="alert">Solus could not sign you in. Try again.</p>{/if}
{:else if serversStore.organizations.length === 0 && managedHostsStore.organizationId === null}
  <div class="flex flex-wrap items-center justify-between gap-3">
    <p class="min-w-0 flex-1 basis-60 text-[0.8125rem] text-pretty text-(--solus-text-secondary)">
      A cloud machine belongs to an organization. Create or join one on Solus Cloud, then come back here.
    </p>
    <Button variant="outline" size="sm" onclick={() => void localApi.openExternal(consolePageUrl(account.consoleUrl, "organizations"))}>Open Solus Cloud</Button>
  </div>
{:else if !managedHostsStore.canCreate}
  <div class="flex flex-wrap items-center justify-between gap-3">
    <p class="min-w-0 flex-1 basis-60 text-[0.8125rem] text-pretty text-(--solus-text-secondary)">Choose the organization that the machine is for.</p>
    <SettingsSelect
      options={serversStore.organizations.map((entry) => ({ value: entry.organizationId, label: entry.name }))}
      value={managedHostsStore.organizationId ?? ""}
      onSelect={(organizationId) => serversStore.selectOrganization(organizationId)}
      ariaLabel="Organization"
    />
  </div>
{:else}
  <form class="flex flex-col gap-4" onsubmit={(event) => { event.preventDefault(); void create(); }}>
    <label class="flex flex-col gap-1.5">
      <span class="text-[0.8125rem] text-(--solus-text-secondary)">Name</span>
      <Input
        name="cloud-machine-name"
        bind:value={name}
        autofocus
        placeholder={organization ? `${organization.name} cloud host` : "Cloud host"}
        class="text-workspace-chrome"
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
            <Input name="cloud-machine-packages" bind:value={packages} dictation={false} placeholder="apt packages, for example postgresql-client ripgrep" aria-label="Packages"
              class="font-mono text-chrome-dense" />
          {/if}
          {#if catalog?.supportsSetupScript}
            <Textarea name="cloud-machine-setup" bind:value={setupScript} rows={3} dictation={false} placeholder="A script that runs when the machine starts" aria-label="Setup script"
              class="font-mono text-chrome-dense" />
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
