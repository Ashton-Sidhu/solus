<script lang="ts">
  import {
    ArrowRight as ArrowRightIcon,
    Check as CheckIcon,
    LoaderCircle as CircleNotchIcon,
    X as XIcon,
  } from "@lucide/svelte";
  import { serversStore } from "../../contexts";
  import { Button } from "../ui/button";
  import GitHostPanel from "./GitHostPanel.svelte";
  import HostPairingPanel from "./HostPairingPanel.svelte";
  import ProviderPanel from "./ProviderPanel.svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { hostOnboardingStore as store } from "./host-onboarding.store.svelte";
  import { onboardingHeading, onboardingRailModel } from "./lib/host-onboarding";

  // The setup act lives on the host, not on this modal — everything the stage
  // runs or reports is read straight off the host's session.
  const setup = $derived(store.setup);
  const isPairing = $derived(store.phase === "pairing");
  const hostName = $derived(store.hostName || store.host?.label || "this host");
  const rail = $derived(
    onboardingRailModel({
      readiness: setup?.readiness ?? null,
      hostName,
      fingerprint: store.host?.fingerprint,
      stepError: setup?.stepError,
    }),
  );
  const current = $derived(rail.current);
  const heading = $derived(
    onboardingHeading({
      hostName,
      pairingView: isPairing ? store.pairingView : null,
      current,
    }),
  );
  const isChecking = $derived(!isPairing && !!setup?.readinessLoading && !setup.readiness);
  // A host in setup has been paired by definition, so that leads the done line.
  const doneNames = $derived(
    isPairing ? [] : ["Paired", ...rail.doneDecisions.map((step) => step.name)],
  );
  // Automatic steps are never asked about, but a failed one still needs a way
  // to be seen and run again.
  const automaticFailure = $derived(
    rail.automaticSteps.find((step) => setup?.stepError?.step === step.id) ?? null,
  );

  const isActiveHost = $derived(
    !!store.host && serversStore.activeServer?.id === store.host.id,
  );
  // One primary button carries the whole handshake, so each pairing view names
  // what pressing it does rather than the modal sprouting a button per state.
  // While the first attempt is connecting there is nothing to press.
  const pairingAction = $derived.by(() => {
    switch (store.pairingView) {
      case "ssh-target":
        return { label: "Next", disabled: !store.sshTarget.trim() };
      case "ssh-password":
        return { label: "Connect", disabled: !store.sshPassword };
      case "fallback":
        return { label: "Connect", disabled: store.pairCode.trim().length !== 6 };
      case "error":
        return { label: "Try again", disabled: false };
      default:
        return null;
    }
  });

  function close() {
    store.close();
    requestInputFocus();
  }

  function startWorking() {
    serversStore.switchTo(store.host!.id);
    close();
  }
</script>

{#if store.isOpen && (store.host || store.pairingTarget)}
  <div
    class="picker-backdrop fixed inset-0 z-50 flex items-center justify-center p-4 text-workspace-chrome"
    role="presentation"
    onkeydown={(event) => {
      if (event.key === "Escape") close();
    }}
  >
    <div
      class="flex max-h-[calc(100vh-2rem)] w-full max-w-[30rem] flex-col overflow-hidden rounded-[1.125rem] bg-popover text-popover-foreground shadow-[0_1.5rem_4rem_-1.25rem_rgba(0,0,0,0.28)] ring-1 ring-foreground/10"
      role="dialog"
      aria-modal="true"
      aria-labelledby="host-onboarding-title"
    >
      <header class="flex shrink-0 items-center gap-3 pt-4 pr-3.5 pl-7">
        <span
          class="h-[3px] flex-1 overflow-hidden rounded-full bg-foreground/12"
          role="progressbar"
          aria-label="Setup progress"
          aria-valuenow={isPairing ? 10 : rail.percentDone}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <span
            class="block h-full rounded-full bg-primary transition-[width] duration-300 motion-reduce:transition-none"
            style="width: {isPairing ? 10 : rail.percentDone}%"
          ></span>
        </span>
        <Button variant="ghost" size="icon-sm" class="text-muted-foreground" aria-label="Close" onclick={close}>
          <XIcon size={14} />
        </Button>
      </header>

      <!-- flex-auto, not flex-1: the stage sizes to its content, and a
           zero-basis item would collapse in an auto-height container. It only
           scrolls once the viewport cap actually bites. -->
      <div class="min-h-0 flex-auto overflow-y-auto px-7 pt-7 pb-2">
        <p class="text-[0.8125rem] text-muted-foreground">
          {isPairing ? "New server" : `Setting up ${hostName}`}
        </p>
        <h2
          id="host-onboarding-title"
          class="mt-2.5 text-[1.375rem] leading-7 font-medium tracking-[-0.01em] text-pretty"
        >
          {heading.title}
        </h2>
        <p class="mt-1.5 leading-[1.5] text-pretty text-muted-foreground">{heading.subtitle}</p>

        <div class="mt-6">
          {#if isPairing && store.pairingTarget}
            <HostPairingPanel target={store.pairingTarget} />
          {:else if setup}
            <!-- One question at a time; with nothing left, the providers stay
                 here so the other one can still be added. -->
            {#if current?.id === "github"}
              <GitHostPanel {setup} flush />
            {:else}
              <ProviderPanel {setup} flush />
            {/if}
            {#if automaticFailure}
              <div class="mt-4 flex items-center gap-2">
                <p class="min-w-0 flex-1 cursor-text select-text text-pretty text-[0.8125rem] text-destructive">
                  {automaticFailure.label}: {setup.stepError?.message}
                </p>
                <Button
                  variant="ghost"
                  size="sm"
                  class="shrink-0"
                  disabled={!!setup.runningStep}
                  onclick={() => void setup.runStep(automaticFailure.id)}
                >
                  Retry
                </Button>
              </div>
            {/if}
          {/if}
        </div>
      </div>

      <footer class="flex min-h-[4.625rem] shrink-0 items-center gap-2 py-5 pr-5 pl-7">
        <!-- One line, always: names only, never sentences. -->
        <span
          class="flex min-w-0 flex-1 items-center gap-3 overflow-hidden text-[0.8125rem] whitespace-nowrap text-muted-foreground"
        >
          {#if isChecking}
            <span class="flex items-center gap-1.5" role="status">
              <CircleNotchIcon size={12} class="shrink-0 animate-spin" />
              Checking {hostName}…
            </span>
          {:else}
            {#each doneNames as name (name)}
              <span class="flex shrink-0 items-center gap-1.5">
                <CheckIcon size={12} strokeWidth={2.6} class="text-(--success)" />
                {name}
              </span>
            {/each}
          {/if}
        </span>

        {#if isPairing}
          {#if pairingAction}
            <Button variant="ghost" class="h-[2.125rem] px-3 text-muted-foreground" onclick={close}>
              Later
            </Button>
            <Button
              class="h-[2.125rem] rounded-[0.625rem] px-3.5"
              disabled={pairingAction.disabled || store.pairingBusy}
              onclick={() => store.submitCurrentPairingView()}
            >
              {#if store.pairingBusy}
                <CircleNotchIcon size={12} class="animate-spin" />
              {/if}
              {pairingAction.label}
            </Button>
          {:else}
            <Button variant="ghost" class="h-[2.125rem] px-3 text-muted-foreground" onclick={close}>
              Cancel
            </Button>
          {/if}
        {:else if current}
          <Button variant="ghost" class="h-[2.125rem] px-3 text-muted-foreground" onclick={close}>
            Later
          </Button>
          {#if !isActiveHost}
            <Button variant="outline" class="h-[2.125rem] rounded-[0.625rem] px-3.5" onclick={startWorking}>
              Open {hostName}
            </Button>
          {/if}
        {:else if isActiveHost}
          <Button class="h-[2.125rem] rounded-[0.625rem] px-3.5" onclick={close}>Done</Button>
        {:else}
          <Button class="h-[2.125rem] rounded-[0.625rem] px-3.5" onclick={startWorking}>
            Open {hostName}
            <ArrowRightIcon size={13} />
          </Button>
        {/if}
      </footer>
    </div>
  </div>
{/if}
