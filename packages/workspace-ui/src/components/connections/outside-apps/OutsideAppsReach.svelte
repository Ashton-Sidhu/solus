<script lang="ts">
  /** "Where apps reach this host" (plans/035 §0.8, docs/outside-apps.md): one
   *  card with the one address cloud apps and your devices use, its test, Copy,
   *  and Change. Change turns the card into the choice of ways to give the host
   *  an address; a host with no address shows that choice at once. The local
   *  address, which needs no setup, is one line under the card. The host tests
   *  the address once the card shows it. */
  import { untrack } from "svelte";
  import { Check as CheckIcon, Copy as CopyIcon, Info as InfoIcon, TriangleAlert as WarningIcon } from "@lucide/svelte";
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
    <Button variant="ghost" size="icon-xs" class="shrink-0 text-muted-foreground pointer-coarse:tap-area" aria-label="Copy {url}" onclick={() => void copy(url)}>
      {#if copiedUrl === url}<CheckIcon class="text-(--solus-status-complete)" />{:else}<CopyIcon />{/if}
    </Button>
  </span>
{/snippet}

{#snippet localLine(localUrl: string)}
  {@render addressLine(`On ${hostName}`, localUrl)}
{/snippet}

<!-- A host with an address shows the address callout. The prose callouts (MarkdownAlert) are for an
     error and for the choice of ways: Important when the host has no address. -->
<section class="flex flex-col gap-3 text-[0.8125rem] leading-5" aria-label="Where apps reach this host">
  {#if endpointError}
    <MarkdownAlert alertType="caution" content={endpointErrorText} />
  {:else if !endpoint}
    <p class="px-0.5 text-(--solus-text-tertiary)">Reading addresses…</p>
  {:else if address && !isChoosing}
    {@const url = address.url}
    <!-- The address callout: a boxed Note (a Warning when the test fails) in the colours of the
         app's callouts. Its title row holds the actions; the address that apps use is the main value. -->
    <div
      class="flex min-w-0 flex-col gap-2.5 rounded-xl border border-[color-mix(in_oklch,var(--callout)_24%,transparent)] bg-[color-mix(in_oklch,var(--callout)_6%,transparent)] px-4 pt-3 pb-3.5 {failure ? '[--callout:var(--solus-art-2)]' : '[--callout:var(--solus-art-5)]'}"
      role="note"
    >
      <div class="flex min-w-0 items-center justify-between gap-3">
        <p class="m-0 flex items-center gap-1.5 font-medium text-[color:color-mix(in_oklch,var(--callout)_78%,var(--solus-text-primary))]">
          {#if failure}<WarningIcon size={15} aria-hidden="true" />Warning{:else}<InfoIcon size={15} aria-hidden="true" />Note{/if}
        </p>
        <div class="flex shrink-0 items-center gap-1">
          {#if failure}
            <Button variant="ghost" size="sm" class="h-7 px-2 text-(--solus-text-secondary) pointer-coarse:min-h-11" onclick={() => void connectionsStore.testAppAddress(serverId, address.source)}>Check again</Button>
          {/if}
          <Button variant="ghost" size="sm" class="h-7 px-2 text-(--solus-text-secondary) pointer-coarse:min-h-11" onclick={() => (isChoosing = true)}>Change</Button>
        </div>
      </div>
      <p class="m-0 text-pretty text-(--solus-text-primary)" aria-live="polite">
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
      <div class="flex min-w-0 items-center gap-2 rounded-lg border border-border bg-(--solus-tx-card-bg) py-1 pr-1 pl-3">
        <span class="min-w-0 flex-1 truncate font-mono text-[0.8125rem] text-(--solus-text-primary) select-text" title={url}>{shownAppAddress(url)}</span>
        <Button variant="ghost" size="icon-sm" class="shrink-0 text-muted-foreground pointer-coarse:tap-area" aria-label="Copy {url}" onclick={() => void copy(url)}>
          {#if copiedUrl === url}<CheckIcon class="text-(--solus-status-complete)" />{:else}<CopyIcon />{/if}
        </Button>
      </div>
      <div class="text-chrome-dense">{@render localLine(endpoint.localUrl)}</div>
    </div>
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
          <Button variant="ghost" size="sm" class="text-muted-foreground pointer-coarse:min-h-11" onclick={() => (isChoosing = false)}>Done</Button>
        </div>
      {/if}
    </div>
  {/if}
</section>

{#snippet endpointErrorText()}<p class="m-0">{endpointError}</p>{/snippet}
