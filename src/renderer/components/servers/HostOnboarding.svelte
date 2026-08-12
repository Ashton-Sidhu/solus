<script lang="ts">
  import { slide } from "svelte/transition";
  import {
    ArrowRightIcon,
    CaretLeftIcon,
    CheckIcon,
    CircleNotchIcon,
    XIcon,
  } from "phosphor-svelte";
  import { serversStore } from "../../contexts";
  import { Button } from "../ui/button";
  import GitHostPanel from "./GitHostPanel.svelte";
  import HostPairingPanel from "./HostPairingPanel.svelte";
  import ProviderPanel from "./ProviderPanel.svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { hostOnboardingStore as store } from "./host-onboarding.store.svelte";
  import {
    onboardingRailModel,
    type OnboardingStep,
  } from "./lib/host-onboarding";

  let carriedOpen = $state(false);

  // The setup act lives on the host, not on this modal — everything the rail
  // runs or reports is read straight off the host's session.
  const setup = $derived(store.setup);
  const isPairing = $derived(store.phase === "pairing");
  const hostName = $derived(store.hostName || store.host?.label || "this host");
  const rail = $derived(
    onboardingRailModel({
      readiness: setup?.readiness ?? null,
      hostName,
      hostUrl: serversStore.servers.find((server) => server.id === store.host?.id)?.url,
      fingerprint: store.host?.fingerprint,
      stepError: setup?.stepError,
    }),
  );
  const decisions = $derived(rail.decisions);
  const automaticSteps = $derived(rail.automaticSteps);
  const facts = $derived(rail.facts);
  const carriedTotal = $derived(rail.carriedTotal);
  const carriedDone = $derived(rail.carriedDone);
  const current = $derived(rail.current);
  const currentNumber = $derived(rail.currentNumber);
  const doneDecisions = $derived(rail.doneDecisions);
  const upcoming = $derived(rail.upcoming);
  const percentDone = $derived(rail.percentDone);
  const hostMeta = $derived(rail.hostMeta);

  const isActiveHost = $derived(
    !!store.host && serversStore.activeServer?.id === store.host.id,
  );
  // One primary button carries the whole handshake, so each pairing view names
  // what pressing it does rather than the modal sprouting a button per state.
  const pairingAction = $derived.by(() => {
    if (store.pairingBusy) return { label: "Connecting", disabled: true };
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
        return { label: "Connecting", disabled: true };
    }
  });

  function close() {
    store.close();
    requestInputFocus();
  }

  function retryAutomatic(step: OnboardingStep) {
    void setup?.runStep(step.id);
  }

  function startWorking() {
    serversStore.switchTo(store.host!.id);
    close();
  }

  function automaticDetail(step: OnboardingStep): string {
    if (!step.blockedBy) return step.detail;
    return step.blockedBy === "gh-cli"
      ? "waiting on the GitHub CLI"
      : "waiting on GitHub";
  }
</script>

{#if store.isOpen && (store.host || store.pairingTarget)}
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/25 p-4 backdrop-blur-[2px] sm:p-6"
    role="presentation"
    onkeydown={(event) => {
      if (event.key === "Escape") close();
    }}
  >
    <div
      class="flex max-h-[calc(100vh-2rem)] min-h-[26rem] w-full max-w-[58.75rem] overflow-hidden rounded-2xl border border-(--solus-popover-border) bg-(--solus-popover-bg) shadow-[0_40px_90px_-24px_rgba(0,0,0,0.34)] sm:max-h-[calc(100vh-3rem)]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="host-onboarding-title"
    >
      <aside
        class="flex w-[18rem] shrink-0 flex-col bg-[color-mix(in_srgb,var(--solus-accent)_4%,var(--solus-popover-bg))] px-[1.875rem] pb-6 pt-[1.875rem]"
      >
        <p
          class="text-xs font-medium uppercase text-(--solus-text-tertiary)"
        >
          Set up a server
        </p>
        <h2
          id="host-onboarding-title"
          class="mt-[1.125rem] text-pretty text-[1.5rem] font-medium leading-[1.12] text-(--solus-text-primary)"
        >
          {hostName}
          {isPairing || current ? "is joining" : "is ready"}
        </h2>
        <p
          class="mt-3 text-pretty text-[0.8125rem] leading-[1.6] text-(--solus-text-tertiary)"
        >
          {#if isPairing}
            Solus copies this Mac's setup across so {hostName} behaves exactly the
            same. Confirm how to reach it and the rest follows on its own.
          {:else if current}
            Your settings are already copied across. What's left are the accounts
            and installs only you can approve — a couple of minutes, once.
          {:else}
            {hostName} has everything it needs to clone, run a session and push the
            work back.
          {/if}
        </p>

        <span class="flex-1"></span>

        <div class="flex items-center gap-2">
          <span
            class="h-0.5 w-[5.5rem] overflow-hidden rounded-full bg-[color-mix(in_srgb,var(--solus-text-primary)_14%,transparent)]"
            aria-hidden="true"
          >
            <span
              class="block h-full rounded-full bg-(--solus-accent) transition-[width] duration-300"
              style="width: {isPairing ? 50 : percentDone}%"
            ></span>
          </span>
          <span class="text-xs tabular-nums text-(--solus-text-tertiary)">
            {#if isPairing}
              Step 1 of 2
            {:else if setup?.readinessLoading && !setup.readiness}
              Checking…
            {:else}
              {doneDecisions.length} of {decisions.length} handled
            {/if}
          </span>
        </div>
      </aside>

      <div class="flex min-w-0 flex-1 flex-col">
        <header class="flex h-[3.125rem] shrink-0 items-center gap-2 px-[1.375rem]">
          {#if isPairing && store.pairingView === "fallback"}
            <button
              type="button"
              class="-ml-1.5 flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs text-(--solus-text-tertiary) transition-colors duration-150 hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary)"
              onclick={() => void store.startSshBootstrap()}
            >
              <CaretLeftIcon size={11} />
              Back to SSH
            </button>
          {/if}
          <span class="flex-1"></span>
          <button
            type="button"
            class="-mr-2 flex size-10 items-center justify-center rounded-lg text-(--solus-text-tertiary) transition-[background-color,color,transform] duration-150 hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--solus-input-focus-ring)"
            aria-label="Close"
            onclick={close}
          >
            <XIcon size={14} />
          </button>
        </header>

        <!-- flex-auto, not flex-1: the stage sizes to its content, and a
             zero-basis item would collapse in an auto-height container. It only
             scrolls once the viewport cap actually bites. -->
        <div class="min-h-0 flex-auto overflow-y-auto px-[1.375rem] pb-5">
          {#if isPairing && store.pairingTarget}
            <HostPairingPanel target={store.pairingTarget} />
          {:else}
            <div class="flex items-baseline gap-2.5">
              <p
                class="shrink-0 text-[1.5rem] font-medium text-(--solus-text-primary)"
              >
                {hostName}
              </p>
              {#if hostMeta}
                <p
                  class="min-w-0 flex-1 truncate text-xs text-(--solus-text-tertiary)"
                  style="font-family: 'Geist Mono', ui-monospace, monospace"
                >
                  {hostMeta}
                </p>
              {/if}
            </div>

            <!-- One step at a time: the rail asks for exactly one thing, and
                 what is left is a list rather than four open panels. -->
            {#if current}
              <div class="mt-[1.625rem] max-w-[30rem]">
                <p
                  class="text-xs font-medium uppercase text-(--solus-accent)"
                >
                  Step {currentNumber} of {decisions.length}
                </p>
                <h3
                  class="mt-2.5 text-[1.5rem] font-medium text-(--solus-text-primary)"
                >
                  {current.label}
                </h3>
                <p
                  class="mt-2 text-pretty text-[0.8125rem] leading-[1.55] text-(--solus-text-tertiary)"
                >
                  {current.why}
                </p>

                {#if current.id === "github"}
                  {#if setup}<GitHostPanel {setup} />{/if}
                {:else if current.id === "providers"}
                  {#if setup}<ProviderPanel {setup} />{/if}
                {/if}
              </div>
            {:else}
              <div class="mt-[1.625rem] max-w-[30rem]">
                <p
                  class="text-xs font-medium uppercase text-(--solus-text-tertiary)"
                >
                  All clear
                </p>
                <h3
                  class="mt-2.5 text-[1.5rem] font-medium text-(--solus-text-primary)"
                >
                  {hostName} is fully set up
                </h3>
                <p
                  class="mt-2 text-pretty text-[0.8125rem] leading-[1.55] text-(--solus-text-tertiary)"
                >
                  Nothing else needs you. Start a session whenever you like.
                </p>
                <!-- The rail is satisfied by one provider, so this is where the
                     other one is added later. -->
                {#if setup}<ProviderPanel {setup} />{/if}
              </div>
            {/if}

            <div
              class="mt-8 max-w-[30rem] border-t border-(--solus-container-border) pt-[0.8125rem]"
            >
              {#if upcoming.length > 0}
                <p
                  class="text-xs font-medium uppercase text-(--solus-text-tertiary)"
                >
                  After this
                </p>
                <div class="mt-[0.3125rem] flex flex-col">
                  {#each upcoming as step (step.id)}
                    <div class="flex items-baseline gap-2.5 py-[0.1875rem]">
                      <span
                        class="shrink-0 text-xs tabular-nums text-(--solus-text-tertiary)"
                      >
                        {decisions.indexOf(step) + 1}
                      </span>
                      <span class="text-[0.8125rem] text-(--solus-text-tertiary)">
                        {step.label}
                      </span>
                    </div>
                  {/each}
                </div>
              {/if}

              {#if doneDecisions.length > 0}
                <div class="mt-2.5 flex flex-col">
                  {#each doneDecisions as step (step.id)}
                    <div class="flex items-baseline gap-2 py-[0.1875rem]">
                      <CheckIcon
                        size={10}
                        weight="bold"
                        class="shrink-0 translate-y-px text-(--solus-text-tertiary)"
                      />
                      <span class="text-[0.8125rem] text-(--solus-text-tertiary)">
                        {step.label} · {step.detail}
                      </span>
                    </div>
                  {/each}
                </div>
              {/if}

              <div class="mt-2.5 flex items-baseline gap-1.5">
                <span class="text-xs text-(--solus-text-tertiary)">
                  {carriedDone} of {carriedTotal} carried over from this Mac · nothing
                  for you to do here
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  class="px-1 text-(--solus-accent)"
                  onclick={() => (carriedOpen = !carriedOpen)}
                >
                  {carriedOpen ? "Hide" : "Show"}
                </Button>
              </div>

              {#if carriedOpen}
                <div class="flex flex-col pt-[0.3125rem]" transition:slide={{ duration: 160 }}>
                  {#each facts as fact (fact.id)}
                    {@render carriedRow(fact.title, fact.detail, fact.done ? "done" : "wait")}
                  {/each}
                  {#each automaticSteps as step (step.id)}
                    {@const stepRunning = setup?.runningStep === step.id}
                    {@render carriedRow(
                      step.label,
                      automaticDetail(step),
                      step.done ? "done" : stepRunning ? "busy" : "wait",
                    )}
                    {#if setup?.stepError?.step === step.id}
                      <div class="flex items-center gap-2 pb-1 pl-[1.125rem]">
                        <p
                          class="min-w-0 flex-1 text-pretty text-xs leading-relaxed text-(--solus-status-error)"
                        >
                          {setup.stepError.message}
                        </p>
                        <Button
                          variant="ghost"
                          size="sm"
                          class="shrink-0 px-1 text-(--solus-accent)"
                          disabled={!!setup?.runningStep}
                          onclick={() => retryAutomatic(step)}
                        >
                          Retry
                        </Button>
                      </div>
                    {/if}
                  {/each}
                </div>
              {/if}
            </div>
          {/if}
        </div>

        <footer
          class="flex h-16 shrink-0 items-center gap-2 border-t border-(--solus-popover-border) px-[1.375rem]"
        >
          {#if isPairing}
            <p class="max-w-[13rem] text-pretty text-xs leading-[1.45] text-(--solus-text-tertiary)">
              Nothing is installed on {hostName} until it has joined.
            </p>
            <span class="flex-1"></span>
            {#if store.pairingView !== "fallback"}
              <Button
                variant="ghost"
                class="text-(--solus-text-tertiary)"
                onclick={() => store.useCodeFallback()}
              >
                Use a code instead
              </Button>
            {/if}
            <Button
              class="h-[2.125rem] px-4"
              disabled={pairingAction.disabled}
              onclick={() => store.submitCurrentPairingView()}
            >
              {#if store.pairingBusy || store.pairingView === "connecting"}
                <CircleNotchIcon size={12} class="animate-spin" />
              {/if}
              {pairingAction.label}
            </Button>
          {:else}
            <span class="flex-1"></span>
            {#if isActiveHost}
              <Button class="h-[2.125rem] px-4" onclick={close}>Done</Button>
            {:else}
              <Button variant="ghost" class="text-(--solus-text-tertiary)" onclick={close}>
                Finish later
              </Button>
              <Button class="h-[2.125rem] px-4" onclick={startWorking}>
                Start working on {hostName}
                <ArrowRightIcon size={12} />
              </Button>
            {/if}
          {/if}
        </footer>
      </div>
    </div>
  </div>
{/if}

{#snippet carriedRow(title: string, detail: string, state: "done" | "busy" | "wait")}
  <div class="flex items-baseline gap-2 py-[0.125rem]">
    {#if state === "busy"}
      <CircleNotchIcon
        size={10}
        class="shrink-0 translate-y-px animate-spin text-(--solus-accent)"
      />
    {:else if state === "done"}
      <CheckIcon
        size={10}
        weight="bold"
        class="shrink-0 translate-y-px text-(--solus-text-tertiary)"
      />
    {:else}
      <span
        class="size-[0.5625rem] shrink-0 translate-y-px rounded-full border border-[color-mix(in_srgb,var(--solus-text-primary)_16%,transparent)]"
      ></span>
    {/if}
    <span class="min-w-0 flex-1 text-xs text-(--solus-text-tertiary)">
      {title} · {detail}
    </span>
  </div>
{/snippet}
