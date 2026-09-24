<script lang="ts">
  /**
   * "Where do your agents run?" — the first question of cloud onboarding
   * (docs/plans/cloud-onboarding.md §3.1). Agents run on a machine, never in
   * this browser. One "Runs on" picker holds every choice: the organization's
   * cloud host (or a new one — a generic Linux machine, with a size when there
   * is more than one to choose), a computer this
   * account linked, one another member shared, or a computer to link. It starts
   * on the sensible default — the organization's cloud host when there is one,
   * so an invitee only presses Continue. "Not now" goes on without a machine,
   * and `agents` is then passed over.
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
  import { Button } from "../ui/button";
  import * as Select from "../ui/select";
  import { isManagedHost } from "../servers/lib/managed-host";
  import { cloudOnboardingStore as cloud } from "./cloud-onboarding.store.svelte";
  import {
    cloudHostDetail,
    defaultRunsOn,
    defaultSize,
    isSharedWith,
    machineDetail,
    runsOnHost,
    runsOnOptions,
    serverIdOf,
    sizeSummary,
    type RunsOnValue,
  } from "./lib/cloud-compute";
  import { hostLinkCommand } from "./lib/host-link-command";
  import { onboardingStore as store } from "./onboarding.store.svelte";
  import OnboardingStageActions from "./OnboardingStageActions.svelte";

  const choices = $derived(cloud.choices);
  const organization = $derived(cloud.organization);
  const organizationName = $derived(organization?.name ?? "your organization");
  const catalog = $derived(cloud.managedHostCatalog);
  const options = $derived(runsOnOptions(choices, organization, catalog));
  const groups = $derived([...new Set(options.map((option) => option.group))]);

  /**
   * A machine chosen in the store wins, so a machine that links while the code
   * waits is shown chosen; otherwise the picker holds "new cloud host" or "link".
   */
  let pick = $state<RunsOnValue | null>(null);
  const selected = $derived<RunsOnValue | null>(
    cloud.chosenServerId && options.some((option) => option.value === runsOnHost(cloud.chosenServerId!))
      ? runsOnHost(cloud.chosenServerId)
      : (pick ?? defaultRunsOn(choices, organization, catalog)),
  );
  const selectedLabel = $derived(options.find((option) => option.value === selected)?.label ?? "Choose");
  const chosen = $derived(cloud.chosenHost);

  let sizeId = $state<string | null>(null);
  const size = $derived(catalog?.sizes.find((entry) => entry.id === sizeId) ?? defaultSize(catalog));

  let copiedCode = $state(false);

  onMount(() => {
    void serversStore.refreshDirectory().then(() => cloud.chooseDefaultHost());
    cloud.chooseDefaultHost();
    return () => cloud.stopWatching();
  });

  function choose(value: string) {
    const next = value as RunsOnValue;
    const serverId = serverIdOf(next);
    cloud.choose(serverId);
    pick = serverId ? null : next;
  }

  /** The chosen cloud host is started when stopped, and reached, so `agents` finds it up. */
  async function continueWithChoice() {
    if (selected === "new-cloud") {
      await cloud.createCloudHost(size ? { size: size.id } : undefined);
      if (cloud.hostError || !cloud.chosenServerId) return;
    }
    const host = cloud.chosenHost;
    if (host && isManagedHost(host.uplink) && host.status !== "online") {
      await cloud.startCloudHost(host.id);
      if (cloud.hostError) return;
    }
    store.advance();
  }

  function goOnWithoutMachine() {
    cloud.choose(null);
    store.advance();
  }

  const linkCommand = $derived(cloud.linkCode ? hostLinkCommand(cloud.linkCode) : null);

  function copyCommand() {
    if (!linkCommand) return;
    void navigator.clipboard?.writeText(linkCommand);
    copiedCode = true;
    setTimeout(() => (copiedCode = false), 1500);
  }

  const continueLabel = $derived(
    cloud.hostBusy === "creating"
      ? "Creating the cloud host…"
      : cloud.hostBusy === "starting"
        ? "Starting the cloud host…"
        : cloud.hostBusy === "connecting"
          ? "Connecting to the cloud host…"
          : selected === "new-cloud"
            ? "Create and continue"
            : "Continue",
  );
  const continueEnabled = $derived(
    !cloud.hostBusy &&
      !!selected &&
      (selected === "new-cloud" ? !!size : !!chosen && serverIdOf(selected) === chosen.id),
  );
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

  <div
    class="onboarding-enter mt-8 flex w-full max-w-[28.25rem] shrink-0 flex-col overflow-hidden rounded-2xl bg-[var(--solus-tx-card-bg)] text-sm shadow-[shadow:var(--solus-tx-card-shadow)] sm:mt-10"
  >
    <div class="flex items-center gap-3 px-4 py-3.5">
      <span class="w-16 shrink-0 text-muted-foreground">Runs on</span>
      <Select.Root type="single" value={selected ?? ""} onValueChange={choose} disabled={options.length === 0}>
        <Select.Trigger aria-label="Runs on" class="min-w-0 flex-1">
          <span class="truncate">{selectedLabel}</span>
        </Select.Trigger>
        <Select.Content>
          {#each groups as group (group)}
            <Select.Group>
              <Select.GroupHeading>{group}</Select.GroupHeading>
              {#each options.filter((option) => option.group === group) as option (option.value)}
                <Select.Item value={option.value} label={option.label}>
                  {#snippet children()}
                    {#if option.value === "link"}
                      <LaptopIcon size={13} class="text-muted-foreground" />
                    {:else if option.group === "Solus Cloud"}
                      <CloudIcon size={13} class="text-muted-foreground" />
                    {:else}
                      <ServerIcon size={13} class="text-muted-foreground" />
                    {/if}
                    {option.label}
                  {/snippet}
                </Select.Item>
              {/each}
            </Select.Group>
          {/each}
        </Select.Content>
      </Select.Root>
    </div>

    <div class="flex flex-col gap-3 border-t border-(--hairline) px-4 py-3.5">
      {#if selected === "new-cloud" && size && catalog}
        {#if catalog.sizes.length > 1}
          <div class="flex items-center gap-3">
            <span class="w-16 shrink-0 text-muted-foreground">Size</span>
            <Select.Root type="single" value={size.id} onValueChange={(next) => (sizeId = next)}>
              <Select.Trigger aria-label="Size" class="min-w-0 flex-1">
                <span class="truncate">{size.label}</span>
              </Select.Trigger>
              <Select.Content>
                {#each catalog.sizes as entry (entry.id)}
                  <Select.Item value={entry.id} label={entry.label}>
                    {#snippet children()}
                      {entry.label}
                      <span class="text-muted-foreground">{sizeSummary(entry)}</span>
                    {/snippet}
                  </Select.Item>
                {/each}
              </Select.Content>
            </Select.Root>
          </div>
        {/if}
        <p class="leading-relaxed text-muted-foreground">
          An always-on Linux machine for {organizationName}: {sizeSummary(size)} Setting it up takes a few
          minutes. Add packages or a setup script later on its page in Solus Cloud.
        </p>
      {:else if selected === "link"}
        {#if cloud.linkError}
          <p class="text-(--solus-status-error)">{cloud.linkError}</p>
        {:else if linkCommand}
          <p class="leading-relaxed text-muted-foreground">
            Run this command in a terminal on that computer. It installs Solus, starts it, and links it to your
            account. The command works once and lasts ten minutes. Only you can see the computer until you share
            it. Waiting for it…
          </p>
          <div class="flex items-start gap-2 rounded-lg bg-(--solus-surface-hover) px-3 py-2">
            <code class="min-w-0 flex-1 break-all font-mono text-xs leading-relaxed select-all">{linkCommand}</code>
            <Button
              variant="ghost"
              size="icon-sm"
              class="shrink-0 text-muted-foreground"
              aria-label="Copy command"
              onclick={copyCommand}
            >
              {#if copiedCode}<CheckIcon size={13} />{:else}<CopyIcon size={13} />{/if}
            </Button>
          </div>
          <p class="leading-relaxed text-muted-foreground">
            On a Mac with the Solus app, sign in to Solus Cloud in Settings → Connections instead.
          </p>
          <Button
            size="sm"
            variant="outline"
            class="self-start"
            onclick={() => void localApi.openExternal("https://solus.sh")}
          >
            <DownloadIcon size={12} />
            Download the Mac app
          </Button>
        {:else}
          <p class="leading-relaxed text-muted-foreground">
            A Mac or a server you own. It stays yours; share it with {organizationName} when you want others to
            use it.
          </p>
          <Button size="sm" class="self-start" onclick={() => void cloud.requestLinkCode()}>Get a link code</Button>
        {/if}
      {:else if chosen}
        {#if choices.cloudHost?.id === chosen.id}
          <p class="text-muted-foreground">{cloudHostDetail(chosen, organizationName)}</p>
        {:else if choices.ownMachines.some((machine) => machine.id === chosen.id)}
          {@const shared = isSharedWith(chosen, organization?.organizationId ?? null)}
          <p class="text-muted-foreground">{machineDetail(chosen, organization, true)}</p>
          {#if organization && chosen.uplink?.hostId}
            <Button
              size="sm"
              variant="outline"
              class="self-start"
              disabled={cloud.sharingServerId === chosen.id}
              onclick={() => void cloud.setShared(chosen, !shared)}
            >
              {shared ? "Stop sharing" : `Share with ${organizationName}`}
            </Button>
          {/if}
        {:else}
          <p class="text-muted-foreground">{machineDetail(chosen, organization, false)}</p>
        {/if}
      {/if}
      {#if selected === "link" && !cloud.linkCode && !options.some((option) => option.group === "Solus Cloud")}
        <p class="text-muted-foreground">
          {organization?.allowsCloudHosts === false
            ? `${organizationName} runs agents on members’ own computers.`
            : `Cloud hosts are not available for ${organizationName} yet.`}
        </p>
      {/if}
      {#if options.length === 0}
        <p class="text-muted-foreground">
          {organizationName} runs agents on its cloud host, and it does not have one yet. Ask an owner to create
          it, or go on for now.
        </p>
      {/if}

      {#if cloud.hostError}
        <p class="text-(--solus-status-error)">{cloud.hostError}</p>
      {/if}
    </div>
  </div>

  <OnboardingStageActions
    {continueLabel}
    {continueEnabled}
    oncontinue={() => void continueWithChoice()}
    onback={() => store.back()}
    onskip={goOnWithoutMachine}
    skipLabel="Not now"
  />
</div>
