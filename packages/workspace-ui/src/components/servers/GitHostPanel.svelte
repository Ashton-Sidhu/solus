<script lang="ts">
  import { Button } from "../ui/button";
  import DevicePrompt from "./DevicePrompt.svelte";
  import ProviderChoiceCard from "./ProviderChoiceCard.svelte";
  import type { HostSetupSession } from "./host-setup.store.svelte";
  import { gitHostRows } from "./lib/host-onboarding";

  interface Props {
    setup: HostSetupSession;
  }

  let { setup }: Props = $props();

  const rows = $derived(
    gitHostRows({
      readiness: setup.readiness,
      connecting: setup.runningStep === "github",
      busy: !!setup.runningStep,
      connect: () => void setup.runStep("github"),
    }),
  );
</script>

<div>
  <ProviderChoiceCard {rows} label="Git hosts" />
  {#if setup.deviceCode}
    <DevicePrompt
      url={setup.deviceCode.verificationUri}
      code={setup.deviceCode.userCode}
      why="Confirm this code on GitHub, then come back."
    />
    <Button
      variant="ghost"
      size="sm"
      class="mt-2 -ml-2 text-workspace-chrome text-(--solus-text-tertiary) [.is-laptop-display_&]:h-6"
      onclick={() => void setup.cancelGithubConnect()}
    >
      Cancel
    </Button>
  {/if}
  {#if setup.stepError?.step === "github"}
    <p class="mt-3 cursor-text select-text text-pretty text-[0.875em] text-(--solus-status-error)">
      {setup.stepError.message}
    </p>
  {/if}
</div>
