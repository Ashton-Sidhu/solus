<script lang="ts">
  /** The fields of a cloud machine: a name, a size from the catalog, and the
   *  packages and setup script. "Create a cloud machine" on the Add machine page
   *  and the machine card in a conversation both use them. With `setupOnly`, only
   *  the packages and the setup script show, open: the machine card's edit. */
  import { untrack } from "svelte";
  import { ChevronRight } from "@lucide/svelte";
  import type { ManagedHostCatalog } from "@solus/contracts/uplink";
  import { defaultSize } from "../onboarding/lib/cloud-compute";
  import { Input } from "../ui/input";
  import { Textarea } from "../ui/textarea";

  interface Props {
    catalog?: ManagedHostCatalog;
    name?: string;
    /** Null selects the catalog's default size. */
    sizeId?: string | null;
    packages: string;
    setupScript: string;
    setupOnly?: boolean;
    namePlaceholder?: string;
    disabled?: boolean;
    packagesInvalid?: boolean;
    setupScriptInvalid?: boolean;
  }

  let {
    catalog,
    name = $bindable(""),
    sizeId = $bindable(null),
    packages = $bindable(),
    setupScript = $bindable(),
    setupOnly = false,
    namePlaceholder = "Cloud host",
    disabled = false,
    packagesInvalid = false,
    setupScriptInvalid = false,
  }: Props = $props();

  const selectedSizeId = $derived(catalog?.sizes.find((entry) => entry.id === sizeId)?.id ?? defaultSize(catalog)?.id ?? null);
  const takesPackages = $derived(setupOnly || !!catalog?.supportsPackages);
  const takesSetupScript = $derived(setupOnly || !!catalog?.supportsSetupScript);
  // Prefilled packages or a prefilled script open the disclosure once; after that the person opens and closes it.
  let isSetupOpen = $state(untrack(() => !!packages.trim() || !!setupScript.trim()));
</script>

{#snippet setupFields()}
  <div class={["flex flex-col gap-2", !setupOnly && "mt-2"]}>
    {#if takesPackages}
      <Input name="cloud-machine-packages" bind:value={packages} dictation={false} placeholder="apt packages, for example postgresql-client ripgrep" aria-label="Packages"
        aria-invalid={packagesInvalid} {disabled} class="font-mono text-chrome-dense" />
    {/if}
    {#if takesSetupScript}
      <Textarea name="cloud-machine-setup" bind:value={setupScript} rows={3} dictation={false} placeholder="A script that runs when the machine starts" aria-label="Setup script"
        aria-invalid={setupScriptInvalid} {disabled} class="font-mono text-chrome-dense" />
    {/if}
  </div>
{/snippet}

{#if !setupOnly}
  <label class="flex flex-col gap-1.5">
    <span class="text-[0.8125rem] text-(--solus-text-secondary)">Name</span>
    <Input
      name="cloud-machine-name"
      bind:value={name}
      autofocus
      placeholder={namePlaceholder}
      {disabled}
      class="text-workspace-chrome"
    />
  </label>
  {#if catalog && catalog.sizes.length > 1}
    <fieldset class="flex flex-col gap-1.5" {disabled}>
      <legend class="mb-1.5 text-[0.8125rem] text-(--solus-text-secondary)">Size</legend>
      <div class="grid grid-cols-2 gap-2 @container @[34rem]:grid-cols-4" role="radiogroup" aria-label="Size">
        {#each catalog.sizes as entry (entry.id)}
          <button
            type="button"
            role="radio"
            aria-checked={selectedSizeId === entry.id}
            onclick={() => (sizeId = entry.id)}
            class="flex flex-col rounded-lg border px-3 py-2 text-left {selectedSizeId === entry.id ? 'border-(--solus-status-running)/60 bg-(--solus-status-running-bg)' : 'border-border/60 hover:bg-(--wash-1)'}"
          >
            <span class="text-[0.8125rem] font-medium">{entry.label}</span>
            <span class="text-chrome-dense text-muted-foreground">{entry.detail}</span>
          </button>
        {/each}
      </div>
    </fieldset>
  {/if}
  {#if takesPackages || takesSetupScript}
    <details class="group text-[0.8125rem]" bind:open={isSetupOpen}>
      <summary class="flex w-fit cursor-pointer list-none items-center gap-1 text-(--solus-text-secondary) hover:text-foreground">
        <ChevronRight size={12} class="transition-transform group-open:rotate-90 motion-reduce:transition-none" />Packages and setup script
      </summary>
      {@render setupFields()}
    </details>
  {/if}
{:else}
  {@render setupFields()}
{/if}
