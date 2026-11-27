<script lang="ts">
  /** "Where apps reach this host" (plans/035 §0.8, docs/outside-apps.md): one
   *  card with the one address cloud apps and your devices use, its test, Copy,
   *  and Change. Change turns the card into the choice of ways to give the host
   *  an address; a host with no address shows that choice at once. The local
   *  address, which needs no setup, is one line under the card. The host tests
   *  the address once the card shows it. */
  import { untrack } from "svelte";
  import { Check as CheckIcon, Copy as CopyIcon } from "@lucide/svelte";
  import { connectionsStore } from "../../../contexts";
  import { Button } from "../../ui/button";
  import MarkdownAlert from "../../ui/MarkdownAlert.svelte";
  import { addressHealth, appAddressSourceLabel, appAddressTestText, hostAppAddress, shownAppAddress } from "../lib/app-addresses";
  import { outsideApps } from "./outside-apps.svelte";
  import OutsideAppsAddressWays from "./OutsideAppsAddressWays.svelte";

  interface Props {
    serverId: string;
    hostName: string;
  }

  let { serverId, hostName }: Props = $props();

  let isChoosing = $state(false);
  let copiedUrl = $state<string | null>(null);

  const endpoint = $derived(connectionsStore.appEndpointFor(serverId));
  const endpointError = $derived(connectionsStore.appEndpointErrorFor(serverId));
  const shown = $derived(endpoint ? hostAppAddress(endpoint.addresses) : null);
  const address = $derived(shown?.address ?? null);
  const test = $derived(address ? connectionsStore.appAddressTestsFor(serverId)[address.source] : undefined);
  const health = $derived(address ? addressHealth(test, address.url) : null);
  const failure = $derived(address && health === "fails" ? appAddressTestText(test, address.url) : null);

  // The address is tested once for its current url; "Check again" tests it again.
  $effect(() => {
    const current = address;
    if (!current || test?.url === current.url) return;
    untrack(() => void connectionsStore.testAppAddress(serverId, current.source));
  });

  async function copy(url: string) {
    if (!(await outsideApps.copy("address", url))) return;
    copiedUrl = url;
    setTimeout(() => { if (copiedUrl === url) copiedUrl = null; }, 1500);
  }
</script>

<!-- One address on its own line: the address without its scheme, and a copy icon. -->
{#snippet addressLine(label: string, url: string)}
  <span class="flex min-w-0 items-center gap-1">
    <span class="shrink-0 text-(--solus-text-tertiary)">{label}</span>
    <span class="min-w-0 truncate font-mono text-[0.75rem] text-(--solus-text-secondary) select-text">{shownAppAddress(url)}</span>
    <Button variant="ghost" size="icon-xs" class="shrink-0 text-(--solus-text-tertiary)" aria-label="Copy {url}" onclick={() => void copy(url)}>
      {#if copiedUrl === url}<CheckIcon class="text-(--solus-status-complete)" />{:else}<CopyIcon />{/if}
    </Button>
  </span>
{/snippet}

{#snippet localLine(localUrl: string)}
  {@render addressLine(`On ${hostName}`, localUrl)}
{/snippet}

<!-- The app's callouts (MarkdownAlert): a Note for a working address, a Warning when its test fails,
     Important when the host has none. The choice of ways is a card under the callout. -->
<section class="flex flex-col gap-3 text-[0.8125rem] leading-5" aria-label="Where apps reach this host">
  {#if endpointError}
    <MarkdownAlert alertType="caution" content={endpointErrorText} />
  {:else if !endpoint}
    <p class="px-0.5 text-(--solus-text-tertiary)">Reading addresses…</p>
  {:else if address && !isChoosing}
    {@const url = address.url}
    {@const localUrl = endpoint.localUrl}
    {#snippet addressText()}
      <div class="flex min-w-0 flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div class="flex min-w-0 flex-1 basis-64 flex-col gap-0.5">
          <p class="m-0 text-pretty" aria-live="polite">
            {#if failure}
              Cloud apps can’t reach {hostName} at this address. {failure}
            {:else if health === "untested"}
              Testing the address of {hostName}…
            {:else if shown?.isDevicesOnly}
              Your devices reach {hostName} through {appAddressSourceLabel(address.source)}. Cloud apps need an internet address.
            {:else}
              Cloud apps and your devices reach {hostName} through {appAddressSourceLabel(address.source)}.
            {/if}
          </p>
          {@render addressLine("At", url)}
          {@render localLine(localUrl)}
        </div>
        <div class="flex shrink-0 items-center gap-1.5">
          {#if failure}
            <Button variant="ghost" size="sm" class="bg-muted" onclick={() => void connectionsStore.testAppAddress(serverId, address.source)}>Check again</Button>
          {/if}
          <Button variant="ghost" size="sm" class="bg-muted" onclick={() => (isChoosing = true)}>Change</Button>
        </div>
      </div>
    {/snippet}
    <MarkdownAlert alertType={failure ? "warning" : "note"} content={addressText} />
  {:else}
    {@const localUrl = endpoint.localUrl}
    {#snippet chooseText()}
      <div class="flex flex-col gap-1">
        <p class="m-0 text-pretty">
          {#if address}
            Choose how cloud apps like Claude and ChatGPT, and your other devices, reach {hostName}.
          {:else}
            Cloud apps can’t reach {hostName} yet. Claude, ChatGPT, and the other cloud apps need an internet address; apps on your computers already work. Pick one way below.
          {/if}
        </p>
        {@render localLine(localUrl)}
      </div>
    {/snippet}
    <MarkdownAlert alertType={address ? "note" : "important"} content={chooseText} />
    <div class="flex flex-col rounded-[0.875rem] bg-(--solus-tx-card-bg) p-2 shadow-[shadow:var(--solus-card-shadow-collapsed)]">
      <OutsideAppsAddressWays {serverId} {hostName} reach="internet" currentSource={address?.source ?? null} />
      {#if address}
        <div class="flex justify-end px-3 pt-1 pb-1.5">
          <Button variant="ghost" size="sm" class="bg-muted" onclick={() => (isChoosing = false)}>Done</Button>
        </div>
      {/if}
    </div>
  {/if}
</section>

{#snippet endpointErrorText()}<p class="m-0">{endpointError}</p>{/snippet}
