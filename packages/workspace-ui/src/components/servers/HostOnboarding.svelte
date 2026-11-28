<script lang="ts">
  /**
   * The setup of a new host, as a modal drawn like first-run onboarding
   * (docs/plans/one-page-onboarding.md) without its projects: pair the host,
   * connect its agents, then GitHub (`lib/host-stage.ts`). The footer has Skip
   * (`esc`) and the one primary (`↵`), as onboarding does.
   */
  import { tick } from "svelte";
  import { X as XIcon } from "@lucide/svelte";
  import { useScope } from "../../lib/keybindings/use-keybinding.svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { Button } from "../ui/button";
  import AgentsStep from "../onboarding/AgentsStep.svelte";
  import OnboardingFooter from "../onboarding/OnboardingFooter.svelte";
  import TimelineStep from "../onboarding/TimelineStep.svelte";
  import { isTypingTarget } from "../onboarding/lib/onboarding-keys";
  import GitHostPanel from "./GitHostPanel.svelte";
  import HostPairingPanel from "./HostPairingPanel.svelte";
  import { hostOnboardingStore as store } from "./host-onboarding.store.svelte";
  import { onboardingHeading, SETUP_PROVIDERS } from "./lib/host-onboarding";
  import { githubFollowThroughFailure, hostStage, hostStageCopy, hostStageFooter, hostStageProgress, type HostStageStep } from "./lib/host-stage";

  // The setup lives on the host, not on this modal: the steps read the host's own session.
  const setup = $derived(store.setup);
  const isPairing = $derived(store.phase === "pairing");
  const hostName = $derived(store.hostName || store.host?.label || "this host");
  const stage = $derived(
    hostStage({
      isPairing,
      pairingView: store.pairingView,
      pairingBusy: store.pairingBusy,
      readiness: setup?.readiness ?? null,
      runningStep: setup?.runningStep ?? null,
      failedStep: setup?.stepError?.step ?? null,
      skipped: store.skippedSteps,
      reopened: store.reopenedStep,
    }),
  );
  const pairing = $derived(onboardingHeading({ hostName, pairingView: store.pairingView }));
  const readyAgents = $derived(
    SETUP_PROVIDERS.filter(({ id }) => setup?.readiness?.agents?.[id]?.signedIn).map(({ label }) => label),
  );
  const githubFailure = $derived(githubFollowThroughFailure(setup?.readiness ?? null, setup?.stepError));

  // One primary carries the whole handshake: each pairing view names what pressing it does.
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
  const footer = $derived(
    hostStageFooter({ open: stage.open, hostName, done: stage.done, pairingAction: pairingAction && store.pairingBusy ? { ...pairingAction, disabled: true } : pairingAction }),
  );

  let primaryButton = $state<HTMLButtonElement | null>(null);

  function close() {
    store.close();
    requestInputFocus();
  }

  async function focusPrimary() {
    await tick();
    primaryButton?.focus();
  }

  function runPrimary() {
    if (!footer.primaryEnabled) return;
    if (stage.open === "pair") return store.submitCurrentPairingView();
    if (stage.open === null) return close();
    store.continueStep();
    void focusPrimary();
  }

  /** Skip leaves the open step for later; nothing comes before pairing, so there it closes. */
  function runSecondary() {
    if (stage.open === null || stage.open === "pair") return close();
    store.skipStep(stage.open);
    void focusPrimary();
  }

  function edit(step: HostStageStep) {
    store.reopenStep(step);
    void focusPrimary();
  }

  function onKeydown(event: KeyboardEvent) {
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (event.key === "Escape") {
      event.preventDefault();
      // Escape in a field leaves the field first.
      if (target && isTypingTarget(target)) target.blur();
      else runSecondary();
      return;
    }
    if (event.key !== "Enter" || event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
    // Fields of the pairing forms submit themselves; buttons and links answer Enter themselves.
    if (target && (target.closest("form") || target.closest("button, a"))) return;
    event.preventDefault();
    runPrimary();
  }

  // A modal: shortcuts behind it stay quiet while it is open.
  useScope("modal-dialog", { exclusive: true, pre: true, active: () => store.isOpen && !!(store.host || store.pairingTarget) });
</script>

{#if store.isOpen && (store.host || store.pairingTarget)}
  <!-- Above Settings (z-[10000]), whose open dialog turns pointer events off on the body: the stage turns them on again. -->
  <div
    class="modal-backdrop pointer-events-auto fixed inset-0 z-[10001] flex items-center justify-center p-4 text-workspace-chrome"
    role="presentation"
    onkeydown={onKeydown}
  >
    <div
      class="@container flex max-h-[calc(100vh-2rem)] w-full max-w-[40rem] flex-col overflow-hidden rounded-[1.125rem] bg-popover text-popover-foreground shadow-[0_1.5rem_4rem_-1.25rem_rgba(0,0,0,0.28)] ring-1 ring-foreground/10"
      role="dialog"
      aria-modal="true"
      aria-labelledby="host-onboarding-title"
    >
      <header class="flex shrink-0 items-start gap-3 pt-7 pr-4 pl-8">
        <div class="flex min-w-0 flex-1 flex-col gap-1.5">
          <h2 id="host-onboarding-title" class="m-0 text-[22px] leading-7 font-semibold tracking-[-0.02em] text-(--solus-text-primary)">
            {isPairing ? `Add ${hostName}` : `Set up ${hostName}`}
          </h2>
          <p class="m-0 text-[15px] leading-5.5 text-(--solus-text-tertiary)">
            {#if stage.open}{hostStageProgress(stage.open)}{:else}<span class="text-(--solus-text-primary)">{hostName}</span> {hostStageProgress(null)}{/if}
          </p>
        </div>
        <Button variant="ghost" size="icon-sm" class="text-muted-foreground" aria-label="Close" onclick={close}>
          <XIcon size={14} />
        </Button>
      </header>

      <!-- flex-auto, not flex-1: the stage sizes to its content and scrolls only once the viewport cap bites. -->
      <div class="min-h-0 flex-auto overflow-y-auto px-8 pt-6 pb-8">
        <ol class="m-0 list-none border-t border-(--hairline) p-0" aria-label="Setup steps">
          {#each stage.entries as entry, index (entry.step)}
            {@const copy = hostStageCopy(entry, { hostName, pairing, readyAgents, githubFailure: githubFailure?.message ?? null, isSkipped: store.skippedSteps.has(entry.step) && !stage.done.has(entry.step) })}
            <TimelineStep
              {entry}
              {copy}
              isFirst={index === 0}
              isLast={index === stage.entries.length - 1}
              onedit={entry.step === "pair" || isPairing ? undefined : () => edit(entry.step)}
            >
              {#snippet body()}
                {#if entry.step === "pair" && store.pairingTarget}
                  <HostPairingPanel target={store.pairingTarget} />
                {:else if entry.step === "agents" && setup}
                  <AgentsStep {setup} machineNoun="host" />
                {:else if entry.step === "github" && setup}
                  <GitHostPanel {setup} flush />
                  {#if githubFailure}
                    <div class="mt-3 flex items-center gap-2">
                      <p class="m-0 min-w-0 flex-1 text-pretty text-[13px] leading-4.5 text-(--solus-status-error)">{githubFailure.message}</p>
                      <Button variant="ghost" size="sm" class="shrink-0" disabled={!!setup.runningStep} onclick={() => void setup.runStep(githubFailure.id)}>Retry</Button>
                    </div>
                  {/if}
                {/if}
              {/snippet}
            </TimelineStep>
          {/each}
        </ol>

        <OnboardingFooter {footer} isBusy={store.pairingBusy} bind:primaryRef={primaryButton} onprimary={runPrimary} onsecondary={runSecondary} />
      </div>
    </div>
  </div>
{/if}
