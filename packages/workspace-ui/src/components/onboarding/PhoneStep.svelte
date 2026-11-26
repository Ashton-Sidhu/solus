<script lang="ts">
  /**
   * Your phone: the existing local-network pairing as one row and a QR code.
   * The code is made when the step opens; a code that could not be made, or a
   * host with no network address, says so and offers to try again.
   */
  import { onMount } from "svelte";
  import { Smartphone as PhoneIcon } from "@lucide/svelte";
  import { connectionsStore as connections } from "../../contexts";
  import { Button } from "../ui/button";
  import { pairQrSvgPath } from "../connections/lib/qrcode";
  import { phonePairLink } from "./lib/phone-pairing";
  import { onboardingStore as store } from "./onboarding.store.svelte";

  let isLoading = $state(true);

  const link = $derived(phonePairLink(connections.endpoints, connections.activePair?.token ?? null));
  const qr = $derived.by(() => {
    if (!link) return null;
    try {
      return pairQrSvgPath(link);
    } catch {
      return null;
    }
  });

  async function makeCode() {
    const serverId = store.serverId;
    if (!serverId) return;
    isLoading = true;
    await connections.refreshServerMetadata(serverId);
    await connections.generatePairToken(serverId);
    isLoading = false;
  }

  onMount(() => void makeCode());
</script>

<div class="flex min-h-24 items-center gap-3.5">
  <span class="flex w-5 shrink-0 justify-center text-(--solus-text-secondary)"><PhoneIcon size={16} strokeWidth={1.8} /></span>
  <div class="flex min-w-0 flex-1 flex-col gap-0.5">
    <span class="text-[14px] leading-5 font-medium text-(--solus-text-primary)">Solus for iPhone and Android</span>
    {#if !isLoading && !qr}
      <span class="text-[13px] leading-4.5 text-(--solus-text-tertiary)">Solus could not make a pairing code for your network.</span>
      <Button variant="outline" size="sm" class="mt-1.5 h-7.5 self-start rounded-md px-3 text-[13px]" onclick={() => void makeCode()}>Try again</Button>
    {:else}
      <span class="text-[13px] leading-4.5 text-(--solus-text-tertiary)">Scan to install and pair. Works while your phone is on this network.</span>
    {/if}
  </div>
  <div class="flex size-20 shrink-0 items-center justify-center rounded-md border border-(--hairline) p-1.75">
    {#if qr}
      <svg class="size-full text-(--solus-text-primary)" viewBox={qr.viewBox} role="img" aria-label="QR code to pair your phone" shape-rendering="crispEdges">
        <path d={qr.path} fill="currentColor" />
      </svg>
    {:else}
      <span class="size-full rounded-sm bg-(--wash-2)" aria-hidden="true"></span>
    {/if}
  </div>
</div>
