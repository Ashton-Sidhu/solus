<script lang="ts">
  /**
   * "Where do your agents run?" — the first question of cloud onboarding
   * (docs/plans/cloud-onboarding.md §3.1). Agents run on a machine, never in
   * this browser: the organization's cloud host, a computer this account
   * linked, or one another member shared. A linked computer stays private until
   * its owner shares it; the cloud host is the organization's. "Not now" goes on
   * without a machine, and `agents` is then passed over.
   */
  import { localApi } from "@solus/client-core/local-api";
  import {
    Check as CheckIcon,
    Cloud as CloudIcon,
    Copy as CopyIcon,
    Download as DownloadIcon,
    Laptop as LaptopIcon,
    Server as ServerIcon,
  } from "@lucide/svelte";
  import { onMount } from "svelte";
  import { serversStore } from "../../contexts";
  import { CLOUD_HOST_LABEL } from "../../contexts/connections/host-label";
  import { Button } from "../ui/button";
  import { isManagedHost } from "../servers/lib/managed-host";
  import { cloudOnboardingStore as cloud } from "./cloud-onboarding.store.svelte";
  import { cloudHostDetail, isSharedWith, machineDetail } from "./lib/cloud-compute";
  import { onboardingStore as store } from "./onboarding.store.svelte";
  import OnboardingRow from "./OnboardingRow.svelte";
  import OnboardingStageActions from "./OnboardingStageActions.svelte";

  const choices = $derived(cloud.choices);
  const organization = $derived(cloud.organization);
  const organizationName = $derived(organization?.name ?? "your organization");
  const chosen = $derived(cloud.chosenHost);
  let copiedCode = $state(false);

  onMount(() => {
    void serversStore.refreshDirectory().then(() => cloud.chooseDefaultHost());
    cloud.chooseDefaultHost();
    return () => cloud.stopWatching();
  });

  /** The chosen cloud host is started when stopped, and reached, so `agents` finds it up. */
  async function continueWithChoice() {
    if (chosen && isManagedHost(chosen.uplink) && chosen.status !== "online") {
      await cloud.startCloudHost(chosen.id);
      if (cloud.hostError) return;
    }
    store.advance();
  }

  function goOnWithoutMachine() {
    cloud.choose(null);
    store.advance();
  }

  function copyCode() {
    if (!cloud.linkCode) return;
    void navigator.clipboard?.writeText(cloud.linkCode.ticket);
    copiedCode = true;
    setTimeout(() => (copiedCode = false), 1500);
  }
</script>

<div class="flex min-h-full flex-col items-center justify-center px-6 py-10 sm:px-10 sm:py-12">
  <h1 class="onboarding-title m-0 shrink-0 text-center text-2xl font-medium leading-[1.12]">
    Where do your agents run?
  </h1>
  <p
    class="onboarding-title mt-3 max-w-[40ch] shrink-0 text-center text-sm leading-[1.6] text-muted-foreground"
    style="animation-delay: 0.06s"
  >
    Agents run on a machine, not in this browser. Close the tab and they keep going.
  </p>

  <div class="mt-8 flex w-full max-w-[28.25rem] shrink-0 flex-col gap-2.5 sm:mt-10">
    {#if choices.cloudHost}
      {@const host = choices.cloudHost}
      <OnboardingRow
        name={host.label}
        detail={cloudHostDetail(host, organizationName)}
        tint="var(--chart-2)"
        state={(cloud.hostBusy === "starting" || cloud.hostBusy === "connecting") && chosen?.id === host.id
          ? "busy"
          : chosen?.id === host.id
            ? "done"
            : "available"}
        statusText={cloud.hostBusy === "starting" ? "Starting…" : "Connecting…"}
        actionLabel="Use"
        onaction={() => cloud.choose(host.id)}
      >
        {#snippet mark()}<CloudIcon size={18} />{/snippet}
      </OnboardingRow>
    {:else if organization?.mayCreateManagedHost}
      <OnboardingRow
        name={CLOUD_HOST_LABEL}
        detail="A machine for {organizationName}. It takes a few minutes to set up."
        tint="var(--chart-2)"
        state={cloud.hostBusy === "creating" ? "busy" : "available"}
        statusText="Creating…"
        actionLabel="Create"
        onaction={() => void cloud.createCloudHost()}
      >
        {#snippet mark()}<CloudIcon size={18} />{/snippet}
      </OnboardingRow>
    {:else}
      <OnboardingRow
        name={CLOUD_HOST_LABEL}
        detail="Cloud hosts are not available for {organizationName} yet."
        tint="var(--chart-2)"
        state="available"
      >
        {#snippet mark()}<CloudIcon size={18} />{/snippet}
      </OnboardingRow>
    {/if}

    {#each choices.ownMachines as machine, index (machine.id)}
      {@const shared = isSharedWith(machine, organization?.organizationId ?? null)}
      <OnboardingRow
        name={machine.label}
        detail={machineDetail(machine, organization, true)}
        delay={(index + 1) * 0.07}
        tint="var(--chart-1)"
        state={chosen?.id === machine.id ? "done" : "available"}
        actionLabel="Use"
        onaction={() => cloud.choose(machine.id)}
        expanded={!!organization && !!machine.uplink?.hostId}
      >
        {#snippet mark()}<LaptopIcon size={18} />{/snippet}
        {#snippet expansion()}
          <div class="flex items-center justify-between gap-3 text-sm">
            <span class="text-muted-foreground">
              {shared
                ? `Members of ${organizationName} can run agents on it.`
                : `Members of ${organizationName} cannot see it.`}
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={cloud.sharingServerId === machine.id}
              onclick={() => void cloud.setShared(machine, !shared)}
            >
              {shared ? "Stop sharing" : `Share with ${organizationName}`}
            </Button>
          </div>
        {/snippet}
      </OnboardingRow>
    {/each}

    {#each choices.sharedMachines as machine, index (machine.id)}
      <OnboardingRow
        name={machine.label}
        detail={machineDetail(machine, organization, false)}
        delay={(choices.ownMachines.length + index + 1) * 0.07}
        tint="var(--chart-3)"
        state={chosen?.id === machine.id ? "done" : "available"}
        actionLabel="Use"
        onaction={() => cloud.choose(machine.id)}
      >
        {#snippet mark()}<ServerIcon size={18} />{/snippet}
      </OnboardingRow>
    {/each}

    <OnboardingRow
      name="Your computer"
      detail={cloud.linkCode ? "Waiting for Solus on that computer…" : "Link a Mac or a server you own"}
      tint="var(--chart-4)"
      state={cloud.linkCode ? "busy" : "available"}
      statusText="Waiting…"
      actionLabel="Get a link code"
      onaction={() => void cloud.requestLinkCode()}
      expanded={!!cloud.linkCode || !!cloud.linkError}
    >
      {#snippet mark()}<LaptopIcon size={18} />{/snippet}
      {#snippet expansion()}
        {#if cloud.linkError}
          <p class="text-sm text-(--solus-status-error)">{cloud.linkError}</p>
        {:else if cloud.linkCode}
          <div class="flex flex-col gap-2.5 text-sm">
            <p class="leading-relaxed text-muted-foreground">
              Install Solus on that computer, then paste this code into it. The code works once and
              lasts ten minutes. Only you can see the computer until you share it.
            </p>
            <div class="flex flex-wrap items-center gap-2">
              <code class="min-w-0 truncate font-medium tabular-nums">{cloud.linkCode.ticket}</code>
              <Button variant="ghost" size="icon-sm" class="text-muted-foreground" aria-label="Copy code" onclick={copyCode}>
                {#if copiedCode}<CheckIcon size={13} />{:else}<CopyIcon size={13} />{/if}
              </Button>
              <Button size="sm" variant="outline" onclick={() => void localApi.openExternal("https://solus.sh")}>
                <DownloadIcon size={12} />
                Download Solus
              </Button>
            </div>
          </div>
        {/if}
      {/snippet}
    </OnboardingRow>

    {#if cloud.hostError}
      <p class="px-1 text-sm text-(--solus-status-error)">{cloud.hostError}</p>
    {/if}
  </div>

  <OnboardingStageActions
    continueLabel={cloud.hostBusy === "starting"
      ? "Starting the cloud host…"
      : cloud.hostBusy === "connecting"
        ? "Connecting to the cloud host…"
        : "Continue"}
    continueEnabled={!!chosen && !cloud.hostBusy}
    oncontinue={() => void continueWithChoice()}
    onback={() => store.back()}
    onskip={goOnWithoutMachine}
    skipLabel="Not now"
  />
</div>
