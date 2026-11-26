<script lang="ts">
  /**
   * Where your agents run, step 1 of the cloud flow (docs/plans/
   * one-page-onboarding.md decision 5): the organization's cloud host,
   * preselected and sized, or the person's own computer, linked with one
   * command. The host starts in the background while the person goes on.
   */
  import { onMount, tick } from "svelte";
  import { serversStore } from "../../contexts";
  import * as Select from "../ui/select";
  import { TerminalOutput } from "../ui/terminal-output";
  import ChoiceRow from "./ChoiceRow.svelte";
  import { cloudOnboardingStore as cloud } from "./cloud-onboarding.store.svelte";
  import { defaultSize, reachability, sizeSummary } from "./lib/cloud-compute";
  import { hostLinkCommand } from "./lib/host-link-command";
  import { radioArrowKey } from "./lib/radio-keys";
  import { onboardingStore as store } from "./onboarding.store.svelte";

  const targets = $derived((["cloud", "own"] as const).filter((target) => store.machineTargets[target]));
  let group = $state<HTMLDivElement | null>(null);

  const cloudHost = $derived(cloud.choices.cloudHost);
  const own = $derived(store.ownMachine);
  const catalog = $derived(cloud.managedHostCatalog);
  const sizes = $derived(catalog?.sizes ?? []);
  const size = $derived(sizes.find((entry) => entry.id === store.sizeId) ?? defaultSize(catalog));
  const linkCommand = $derived(cloud.linkCode ? hostLinkCommand(cloud.linkCode) : null);

  onMount(() => {
    void serversStore.refreshDirectory().then(() => cloud.dialMachines());
  });

  async function onGroupKeydown(event: KeyboardEvent) {
    const next = radioArrowKey(event.key, targets, store.machineTarget);
    if (!next) return;
    event.preventDefault();
    store.chooseMachineTarget(next);
    await tick();
    group?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
  }
</script>

{#if !store.machineTargets.cloud && !store.machineTargets.own}
  <p class="m-0 py-2 text-[13px] leading-4.5 text-(--solus-text-tertiary)">Your organization has no machine you can use yet. Ask an owner to add a cloud host or allow your own computers.</p>
{/if}
<div bind:this={group} role="radiogroup" aria-label="Where your agents run" tabindex="-1" onkeydown={onGroupKeydown}>
  {#if store.machineTargets.cloud}
  <ChoiceRow
    title="Cloud host"
    detail={cloudHost ? `${cloudHost.label} · ${reachability(cloudHost)}` : "Solus runs it. Works while you’re away."}
    isChosen={store.machineTarget === "cloud"}
    onchoose={() => store.chooseMachineTarget("cloud")}
  >
    {#snippet trailing()}
      {#if !cloudHost && sizes.length > 1 && size}
        <Select.Root type="single" value={size.id} onValueChange={(value) => (store.sizeId = value)}>
          <Select.Trigger aria-label="Cloud host size" class="h-7.5 rounded-md px-3 text-[13px]">{sizeSummary(size)}</Select.Trigger>
          <!-- The onboarding page is a z-[10005] layer; the menu opens above it. -->
          <Select.Content class="z-[10010]">
            {#each sizes as entry (entry.id)}
              <Select.Item value={entry.id} label={sizeSummary(entry)} />
            {/each}
          </Select.Content>
        </Select.Root>
      {/if}
    {/snippet}
  </ChoiceRow>
  {/if}
  {#if store.machineTargets.own}
  <ChoiceRow
    title="Your own computer"
    detail={own ? `${own.label} · ${reachability(own)}` : "Install Solus there and link it with one command"}
    isChosen={store.machineTarget === "own"}
    onchoose={() => store.chooseMachineTarget("own")}
  />
  {/if}
</div>

{#if store.machineTarget === "own" && linkCommand}
  <div class="flex flex-col gap-2 pb-2 pl-7.5">
    <p class="m-0 text-[13px] leading-4.5 text-(--solus-text-tertiary)">Run this on the computer. It links when Solus starts there.</p>
    <TerminalOutput label="Command that installs and links Solus" output={linkCommand} class="max-h-32" />
  </div>
{/if}
{#if cloud.linkError || cloud.hostError}
  <p class="m-0 pl-7.5 text-[13px] leading-4.5 text-(--solus-status-error)" role="alert">{cloud.linkError ?? cloud.hostError}</p>
{/if}
