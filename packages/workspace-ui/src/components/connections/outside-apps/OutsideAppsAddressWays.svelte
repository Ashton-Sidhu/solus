<script lang="ts">
  /** The three ways to give a host an address apps reach (plans/035 §0.8):
   *  Tailscale (Serve for the tailnet, Funnel for the internet), Solus Cloud,
   *  and the person's own address. The no-address banner, an open row whose
   *  app has no address, and "Set up" under "Where apps reach this host" all
   *  show these. Tailscale and Solus Cloud change only from a local owner's
   *  client; anyone else reads where to do it. */
  import { untrack } from "svelte";
  import { Check as CheckIcon, LoaderCircle as SpinnerIcon } from "@lucide/svelte";
  import type { AppAddressSource } from "@solus/contracts/host-api";
  import { accountStore, connectionsStore, uplinkStore } from "../../../contexts";
  import { hosts } from "../../../contexts/hosts/hosts.svelte";
  import { Button } from "../../ui/button";
  import { hostSettingsStore } from "../../../contexts/app/host-settings.store.svelte";
  import { hostLock } from "../../settings/policy/managed-setting.svelte";
  import ManagedSettingNote from "../../settings/policy/ManagedSettingNote.svelte";
  import { appAddressTestText, tailscaleCard, tailscaleWay, type AppAddressReach } from "../lib/app-addresses";
  import { registerWay, solusAddressState, solusCard, turnOnWay } from "../lib/outside-apps-gate";
  import { outsideApps } from "./outside-apps.svelte";
  import OutsideAppsOwnAddress from "./OutsideAppsOwnAddress.svelte";

  interface Props {
    serverId: string;
    hostName: string;
    reach: AppAddressReach;
    /** The address in use now, from "Change": its way says In use instead of offering itself again. */
    currentSource?: AppAddressSource | null;
  }

  let { serverId, hostName, reach, currentSource = null }: Props = $props();

  const isTailscaleCurrent = $derived(currentSource === "tailscale-funnel" || currentSource === "tailscale-serve");
  const isSolusCurrent = $derived(currentSource === "solus");
  const isOwnCurrent = $derived(currentSource === "custom");

  let isAddingAddress = $state(false);
  /** Remove was pressed once: the card asks before the address goes. */
  let isConfirmingRemove = $state(false);

  const host = $derived(hosts.get(serverId));
  const mayReachLocally = $derived(host.me.may("host.local.reach"));
  const tailscaleStatus = $derived(connectionsStore.appTailscaleFor(serverId) ?? null);
  const tailscale = $derived(tailscaleCard(tailscaleWay(tailscaleStatus, mayReachLocally), tailscaleStatus, reach, hostName));
  const tailscaleError = $derived(connectionsStore.appTailscaleErrorFor(serverId) ?? tailscaleStatus?.error ?? null);
  const isTailscaleBusy = $derived(connectionsStore.appTailscaleBusyServerId === serverId);
  const tailscaleFeature = $derived(reach === "internet" ? "Funnel" : "Serve");

  const uplink = $derived(uplinkStore.statusFor(serverId));
  const isTurningOn = $derived(outsideApps.turningOnServerId === serverId);
  const solusState = $derived(uplink ? solusAddressState(uplink, isTurningOn) : null);
  const cloudLock = $derived(hostLock(serverId, "cloudTunnel"));
  const solus = $derived(solusCard(
    solusState,
    registerWay({ control: uplinkStore.controlFor(serverId), accountAvailable: uplinkStore.accountAvailable, canLink: uplinkStore.canLink }),
    turnOnWay({
      hostKind: host.serverInfo.state === "ready" ? host.serverInfo.value.hostKind : undefined,
      control: uplinkStore.controlFor(serverId),
      mayReachLocally,
      locked: !!cloudLock,
    }),
    hostName,
  ));
  const isSolusBusy = $derived(uplinkStore.busyServerId === serverId || isTurningOn);

  const mayChangeSettings = $derived(host.me.may("host.admin"));
  const ownAddress = $derived(connectionsStore.appEndpointFor(serverId)?.addresses.find((address) => address.source === "custom") ?? null);
  const ownTest = $derived(connectionsStore.appAddressTestsFor(serverId).custom);
  const ownTestText = $derived(ownAddress ? appAddressTestText(ownTest, ownAddress.url) : null);
  const isOwnReachable = $derived(ownTest?.kind === "done" && ownTest.reachable);
  const isRemoving = $derived(!!hostSettingsStore.states.get(serverId)?.saving);

  async function removeOwnAddress() {
    if (await outsideApps.saveAndTestPublicAddress(serverId, "")) isConfirmingRemove = false;
  }

  // The Solus Cloud card reads the link; the page has read the addresses and Tailscale already.
  $effect(() => {
    const targetServerId = serverId;
    untrack(() => { if (!uplinkStore.statusFor(targetServerId)) void outsideApps.readUplink(targetServerId); });
  });

  // A person who signs in here comes back to a host that the owner's client now registers by itself.
  const solusKind = $derived(solusState?.kind);
  $effect(() => {
    if (solusKind !== "not-registered" || !uplinkStore.canLink) return;
    untrack(() => void outsideApps.check(serverId));
  });

  function runSolus() {
    if (solus.action === "sign-in") void accountStore.signIn();
    else if (solus.action === "link") void outsideApps.link(serverId);
    else if (solus.action === "turn-on") void outsideApps.turnOn(serverId);
    else void outsideApps.check(serverId);
  }
</script>

<!-- The ways as a list (docs/outside-apps.md): one row each, what the way is, and its one action, which is
     the only control. No radio: a way cannot be switched in one click. The row in use sits on a soft fill. -->
{#snippet way(title: string, isCurrent: boolean, summary: import("svelte").Snippet, action: import("svelte").Snippet, below?: import("svelte").Snippet)}
  <div class={["flex flex-col gap-3 rounded-[0.625rem] px-3 py-3", isCurrent && "bg-muted"]}>
    <div class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
      <div class="flex min-w-0 flex-1 basis-40 flex-col gap-0.5">
        <span class="truncate text-[0.875rem] leading-4.5 font-medium text-(--solus-text-primary)">{title}</span>
        {@render summary()}
      </div>
      <div class="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
        {#if isCurrent}
          <span class="inline-flex items-center gap-1 text-chrome-dense font-medium text-(--solus-status-complete)"><CheckIcon size={13} strokeWidth={2.5} aria-hidden="true" />In use</span>
        {/if}
        {@render action()}
      </div>
    </div>
    {@render below?.()}
  </div>
{/snippet}

{#snippet line(text: string)}
  <span class="text-chrome-dense text-pretty text-(--solus-text-tertiary) select-text">{text}</span>
{/snippet}

{#snippet tailscaleSummary()}{@render line(isTailscaleCurrent ? "A public address from Tailscale. No account needed." : tailscale.summary)}{/snippet}
{#snippet solusSummary()}{@render line(isSolusCurrent ? "A private tunnel through your Solus account." : solus.summary ?? "A private tunnel through your Solus account.")}{/snippet}
{#snippet ownSummary()}
  {#if isConfirmingRemove && ownAddress}
    {@render line(`Remove ${ownAddress.url}? Cloud apps that use it stop reaching ${hostName}.`)}
  {:else if ownAddress}
    <span class="truncate font-mono text-[0.75rem] leading-4.5 text-(--solus-text-secondary) select-text">{ownAddress.url}</span>
    {#if ownTestText}
      <span role={isOwnReachable || ownTest?.kind === "running" ? "status" : "alert"} class={["text-chrome-dense", isOwnReachable ? "text-(--solus-status-complete)" : ownTest?.kind === "running" ? "text-(--solus-text-tertiary)" : "text-(--solus-status-error)"]}>{ownTestText}</span>
    {/if}
  {:else}
    {@render line(mayChangeSettings ? "A proxy or tunnel you run, over https." : `Ask the owner of ${hostName} to add one.`)}
  {/if}
{/snippet}

{#snippet tailscaleAction()}
  {#if isTailscaleCurrent && !isTailscaleBusy}
    <!-- In use: the address card already checks the address and offers Check again when it fails. -->
  {:else if isTailscaleBusy || tailscale.action === "turn-on"}
    <Button size="sm" disabled={connectionsStore.appTailscaleBusyServerId !== null} onclick={() => void outsideApps.turnOnTailscale(serverId, reach)}>
      {#if isTailscaleBusy}<SpinnerIcon class="motion-safe:animate-spin" />Turning on {tailscaleFeature}…{:else}Turn on {tailscaleFeature}{/if}
    </Button>
  {:else if tailscale.action === "check"}
    <Button variant="ghost" size="sm" class="bg-muted" onclick={() => void outsideApps.check(serverId)}>Check again</Button>
  {/if}
{/snippet}

{#snippet solusAction()}
  {#if isSolusCurrent && !isSolusBusy}
    <!-- In use: the address card already checks the address. -->
  {:else if solus.action === "policy" && cloudLock}
    <ManagedSettingNote note={cloudLock} />
  {:else if solus.action === "sign-in" && accountStore.state.kind === "signing-in"}
    <Button variant="ghost" size="sm" class="bg-muted" onclick={() => accountStore.cancelSignIn()}>Cancel sign-in</Button>
  {:else if solus.action && solus.action !== "policy"}
    <Button
      variant="ghost"
      size="sm"
      class="bg-muted"
      disabled={isSolusBusy || (solus.action === "sign-in" && accountStore.state.kind === "unavailable")}
      onclick={runSolus}
    >
      {#if isTurningOn}<SpinnerIcon class="motion-safe:animate-spin" />Turning on…{:else if solus.action === "sign-in"}Sign in and link{:else if solus.action === "link"}Link{:else if solus.action === "turn-on"}Turn on{:else}Check again{/if}
    </Button>
  {/if}
{/snippet}

{#snippet ownAction()}
  {#if !mayChangeSettings}
    <!-- Only someone who may change the host's settings adds or removes its address. -->
  {:else if isConfirmingRemove}
    <Button variant="ghost" size="sm" class="bg-muted" disabled={isRemoving} onclick={() => (isConfirmingRemove = false)}>Keep</Button>
    <Button variant="destructive" size="sm" disabled={isRemoving} onclick={() => void removeOwnAddress()}>{isRemoving ? "Removing…" : "Remove"}</Button>
  {:else if ownAddress}
    <Button variant="ghost" size="sm" class="bg-muted" aria-expanded={isAddingAddress} onclick={() => (isAddingAddress = !isAddingAddress)}>Change</Button>
    <Button variant="ghost" size="sm" class="text-(--solus-status-error) hover:text-(--solus-status-error)" disabled={isAddingAddress} onclick={() => (isConfirmingRemove = true)}>Remove</Button>
  {:else}
    <Button variant="ghost" size="sm" class="bg-muted" aria-expanded={isAddingAddress} onclick={() => (isAddingAddress = !isAddingAddress)}>Add address</Button>
  {/if}
{/snippet}

{#snippet ownForm()}
  {#if isAddingAddress}
    <div><OutsideAppsOwnAddress {serverId} onDone={() => (isAddingAddress = false)} /></div>
  {/if}
{/snippet}

<div class="flex flex-col gap-1">
  {@render way(reach === "internet" ? "Tailscale Funnel" : "Tailscale", isTailscaleCurrent, tailscaleSummary, tailscaleAction)}
  {@render way("Solus Cloud", isSolusCurrent, solusSummary, solusAction)}
  {@render way("Your own address", isOwnCurrent, ownSummary, ownAction, ownForm)}
  {#if tailscaleError}
    <p role="alert" class="px-3 pb-1 text-chrome-dense text-(--solus-status-error) select-text">{tailscaleError}</p>
  {/if}
</div>
