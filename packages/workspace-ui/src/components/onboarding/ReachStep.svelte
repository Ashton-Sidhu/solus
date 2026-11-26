<script lang="ts">
  /**
   * Reach it from anywhere, the optional last step of the desktop account flow
   * (docs/plans/one-page-onboarding.md decision 4). Link this Mac shows the
   * host's own link state and is off until the person turns it on; sharing
   * with the organization needs the link, and is made on the Solus Cloud page
   * of the host, which owns organizations and their membership.
   */
  import { onMount } from "svelte";
  import { LOCAL_SERVER_ID } from "@solus/client-core/known-host";
  import { localApi } from "@solus/client-core/local-api";
  import { ArrowUpRight as ExternalIcon, Smartphone as PhoneIcon } from "@lucide/svelte";
  import { accountStore, uplinkStore } from "../../contexts";
  import { hostWebsiteUrl } from "../../contexts/connections/host-routes";
  import { Button } from "../ui/button";
  import { reachRows } from "./lib/onboarding-model";

  let { machineNoun }: { machineNoun: string } = $props();

  const uplink = $derived(uplinkStore.statusFor(LOCAL_SERVER_ID));
  const busy = $derived(uplinkStore.busyServerId === LOCAL_SERVER_ID);
  const rows = $derived(reachRows({ linked: uplink?.link.linked, busy, signedIn: accountStore.isSignedIn }));
  const registration = $derived(uplink?.registration.registered ? uplink.registration.registration : null);
  const email = $derived(accountStore.state.kind === "signed-in" ? accountStore.state.identity.email : null);

  onMount(() => void uplinkStore.refresh(LOCAL_SERVER_ID));

  function toggleLink() {
    if (rows.link.disabled) return;
    void (rows.link.checked ? uplinkStore.unlink(LOCAL_SERVER_ID) : uplinkStore.link(LOCAL_SERVER_ID));
  }

  function openSharing() {
    if (registration) void localApi.openExternal(hostWebsiteUrl(registration.directoryUrl, registration.hostId));
  }
</script>

<button
  type="button"
  role="switch"
  aria-checked={rows.link.checked}
  disabled={rows.link.disabled}
  class="flex min-h-13 w-full min-w-0 items-center gap-3.5 overflow-hidden rounded-md text-left focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default"
  onclick={toggleLink}
>
  {#if rows.link.checked}
    <span class="flex size-4 shrink-0 items-center justify-center rounded-[4px] bg-(--solus-text-primary)" aria-hidden="true">
      <svg width="10" height="10" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="var(--background)" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round" /></svg>
    </span>
  {:else}
    <span class="size-4 shrink-0 rounded-[4px] border-[1.5px] border-border" aria-hidden="true"></span>
  {/if}
  <span class="flex min-w-0 flex-1 flex-col gap-0.5">
    <span class="text-[14px] leading-5 font-medium text-(--solus-text-primary)">Link this {machineNoun} to your account</span>
    <span class="text-[13px] leading-4.5 text-(--solus-text-tertiary)">
      {busy ? "Changing the link…" : rows.link.checked ? "Linked · open it from the web and your phone" : "Open it from the web and your phone, through a private tunnel"}
    </span>
  </span>
</button>

<div class="flex min-h-13 items-center gap-3.5" class:opacity-45={rows.share.disabled}>
  <span class="size-4 shrink-0" aria-hidden="true"></span>
  <span class="flex min-w-0 flex-1 flex-col gap-0.5">
    <span class="text-[14px] leading-5 font-medium text-(--solus-text-primary)">Share it with the organization</span>
    <span class="text-[13px] leading-4.5 text-(--solus-text-tertiary)">{rows.share.detail}</span>
  </span>
  <div class="flex w-30 shrink-0 justify-end">
    <Button variant="outline" size="sm" class="h-7.5 gap-1 rounded-md px-3 text-[13px]" disabled={rows.share.disabled || !registration} onclick={openSharing}>
      Share <ExternalIcon size={12} />
    </Button>
  </div>
</div>

<div class="flex min-h-13 items-center gap-3.5">
  <span class="flex size-4 shrink-0 justify-center text-(--solus-text-secondary)"><PhoneIcon size={16} strokeWidth={1.8} /></span>
  <span class="flex min-w-0 flex-1 flex-col gap-0.5">
    <span class="text-[14px] leading-5 font-medium text-(--solus-text-primary)">Phone app</span>
    <span class="text-[13px] leading-4.5 text-(--solus-text-tertiary)">Install Solus for iPhone or Android, then sign in{email ? ` as ${email}` : ""}</span>
  </span>
</div>
