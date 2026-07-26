<script lang="ts">
  import { slide } from "svelte/transition";
  import {
    ArrowRightIcon,
    ArrowSquareOutIcon,
    CaretLeftIcon,
    CheckIcon,
    CircleNotchIcon,
    XIcon,
  } from "phosphor-svelte";
  import { serversStore } from "../../contexts";
  import { Button } from "../ui/button";
  import CopyButton from "../ui/CopyButton.svelte";
  import HostPairingPanel from "./HostPairingPanel.svelte";
  import ProviderChoiceCard from "./ProviderChoiceCard.svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { hostOnboardingStore as store } from "./host-onboarding.store.svelte";
  import {
    codingProviderRows,
    gitHostRows,
    hostCarriedOverFacts,
    shortFingerprint,
    type OnboardingStep,
  } from "./lib/host-onboarding";
  import type { SetupAgent } from "../../../shared/types";

  // Local to the stage: which provider the last "Add" was for, so the failure
  // that follows knows what to retry.
  let lastProvider = $state<SetupAgent | null>(null);
  let logOpen = $state(false);
  let carriedOpen = $state(false);

  const isPairing = $derived(store.phase === "pairing");
  const steps = $derived(store.steps);
  const hostName = $derived(store.hostName || store.host?.label || "this host");
  const facts = $derived(
    hostCarriedOverFacts({ readiness: store.readiness, hostName }),
  );

  // Two lists, and they are asked for in different ways: the decisions are put
  // one at a time, and everything else is reported once, folded away.
  const decisions = $derived(steps.filter((step) => !step.automatic));
  const automaticSteps = $derived(steps.filter((step) => step.automatic));
  const carriedTotal = $derived(facts.length + automaticSteps.length);
  const carriedDone = $derived(
    facts.filter((fact) => fact.done).length +
      automaticSteps.filter((step) => step.done).length,
  );

  // The step being asked about is the first one that is both undone and
  // unblocked — the credential helper waits behind GitHub rather than being
  // offered with no token to hand over.
  const current = $derived(
    decisions.find((step) => !step.done && !step.blockedBy) ?? null,
  );
  const currentNumber = $derived(current ? decisions.indexOf(current) + 1 : 0);
  const doneDecisions = $derived(decisions.filter((step) => step.done));
  const upcoming = $derived(
    decisions.filter((step) => step !== current && !step.done),
  );
  // A provider row is reachable from its own step and from the all-clear panel,
  // so its failure is reported wherever the user set it off. Everything else
  // belongs to the one step that offers it.
  const failure = $derived.by(() => {
    const error = store.stepError;
    if (!error) return null;
    if (error.step === "providers") return error;
    return current && error.step === current.id ? error : null;
  });
  // A decision weighs more than a carried fact, because it is the only kind the
  // user actually spends time on.
  const percentDone = $derived(
    Math.round(
      ((carriedDone + doneDecisions.length * 2) /
        (carriedTotal + decisions.length * 2)) *
        100,
    ),
  );

  const isActiveHost = $derived(
    !!store.host && serversStore.activeServer?.id === store.host.id,
  );
  const logTail = $derived(store.logLines.slice(-2));

  // One primary button carries the whole handshake, so each pairing view names
  // what pressing it does rather than the modal sprouting a button per state.
  const pairingAction = $derived.by(() => {
    if (store.pairingBusy) return { label: "Connecting", disabled: true, run: () => {} };
    switch (store.pairingView) {
      case "ssh-target":
        return {
          label: "Next",
          disabled: !store.sshTarget.trim(),
          run: () => store.submitSshTarget(),
        };
      case "ssh-password":
        return {
          label: "Connect",
          disabled: !store.sshPassword,
          run: () => store.submitSshPassword(),
        };
      case "fallback":
        return {
          label: "Connect",
          disabled: store.pairCode.trim().length !== 6,
          run: () => void store.submitPairCode(),
        };
      case "error":
        return { label: "Try again", disabled: false, run: () => void store.startSshBootstrap() };
      default:
        return { label: "Connecting", disabled: true, run: () => {} };
    }
  });

  // Identity is stated once, in the host's own terms: what it runs, where it
  // answers, and what it can already do.
  const hostMeta = $derived(
    [
      store.readiness?.platform,
      serversStore.servers.find((server) => server.id === store.host?.id)?.url,
      store.readiness?.git?.version,
      shortFingerprint(store.host?.fingerprint),
    ]
      .filter(Boolean)
      .join(" · "),
  );

  function close() {
    store.close();
    requestInputFocus();
  }

  function addProvider(provider: SetupAgent) {
    lastProvider = provider;
    void store.addProvider(provider);
  }

  function retryFailed() {
    const step = failure?.step;
    if (!step) return;
    if (step === "github") void store.connectGithub();
    else if (lastProvider) addProvider(lastProvider);
  }

  function retryAutomatic(step: OnboardingStep) {
    if (step.id === "credential-helper") void store.installCredentialHelper();
    else if (step.id === "gh-auth") void store.authorizeGhCli();
  }

  function startWorking() {
    serversStore.switchTo(store.host!.id);
    close();
  }

  function automaticDetail(step: OnboardingStep): string {
    return step.blockedBy ? "waiting on GitHub" : step.detail;
  }

  // Both cards are the same shape: every provider the host could use, each
  // saying where it stands and offering the one thing it can do next.
  const gitRows = $derived(
    gitHostRows({
      readiness: store.readiness,
      connecting: store.runningStep === "github",
      busy: !!store.runningStep,
      connect: () => void store.connectGithub(),
    }),
  );
  const providerRows = $derived(
    codingProviderRows({
      readiness: store.readiness,
      inFlight: store.providerInFlight,
      stage: store.providerStage,
      busy: !!store.runningStep,
      add: addProvider,
    }),
  );
</script>

{#if store.isOpen && (store.host || store.pairingTarget)}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/25 p-4 backdrop-blur-[2px] sm:p-6"
    role="presentation"
    onclick={(event) => {
      if (event.target === event.currentTarget) close();
    }}
    onkeydown={(event) => {
      if (event.key === "Escape") close();
    }}
  >
    <div
      class="flex max-h-[calc(100vh-2rem)] min-h-[26rem] w-full max-w-[58.75rem] overflow-hidden rounded-[1.125rem] border border-(--solus-popover-border) bg-(--solus-popover-bg) shadow-[0_40px_90px_-24px_rgba(0,0,0,0.34)] sm:max-h-[calc(100vh-3rem)]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="host-onboarding-title"
    >
      <aside
        class="flex w-[18rem] shrink-0 flex-col bg-[color-mix(in_srgb,var(--solus-accent)_4%,var(--solus-popover-bg))] px-[1.875rem] pb-6 pt-[1.875rem]"
      >
        <p
          class="text-[0.625rem] font-medium uppercase tracking-[0.1em] text-(--solus-text-tertiary)"
        >
          Set up a server
        </p>
        <h2
          id="host-onboarding-title"
          class="mt-[1.125rem] text-pretty text-[1.5625rem] font-semibold leading-[1.12] tracking-[-0.02em] text-(--solus-text-primary)"
        >
          {hostName}
          {isPairing || current ? "is joining" : "is ready"}
        </h2>
        <p
          class="mt-3 text-pretty text-[0.78125rem] leading-[1.6] text-(--solus-text-tertiary)"
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
          <span class="text-[0.65625rem] tabular-nums text-(--solus-text-tertiary)">
            {#if isPairing}
              Step 1 of 2
            {:else if store.readinessLoading && !store.readiness}
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
              class="-ml-1.5 flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[0.71875rem] text-(--solus-text-tertiary) transition-colors duration-150 hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary)"
              onclick={() => void store.startSshBootstrap()}
            >
              <CaretLeftIcon size={11} />
              Back to SSH
            </button>
          {/if}
          <span class="flex-1"></span>
          <button
            type="button"
            class="-mr-1.5 flex size-7 items-center justify-center rounded-lg text-(--solus-text-tertiary) transition-[background-color,color,transform] duration-150 hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--solus-input-focus-ring)"
            aria-label="Close"
            onclick={close}
          >
            <XIcon size={14} />
          </button>
        </header>

        <!-- flex-auto, not flex-1: the stage sizes to its content, and a
             zero-basis item would collapse in an auto-height container. It only
             scrolls once the viewport cap actually bites. -->
        <div class="hairline-scroll min-h-0 flex-auto overflow-y-auto px-[1.375rem] pb-5">
          {#if isPairing && store.pairingTarget}
            <HostPairingPanel target={store.pairingTarget} />
          {:else}
            <div class="flex items-baseline gap-2.5">
              <p
                class="shrink-0 text-[1.1875rem] font-semibold tracking-[-0.02em] text-(--solus-text-primary)"
              >
                {hostName}
              </p>
              {#if hostMeta}
                <p
                  class="min-w-0 flex-1 truncate text-[0.6875rem] text-(--solus-text-tertiary)"
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
                  class="text-[0.625rem] font-medium uppercase tracking-[0.11em] text-(--solus-accent)"
                >
                  Step {currentNumber} of {decisions.length}
                </p>
                <h3
                  class="mt-2.5 text-[1.3125rem] font-semibold tracking-[-0.02em] text-(--solus-text-primary)"
                >
                  {current.label}
                </h3>
                <p
                  class="mt-2 text-pretty text-[0.8125rem] leading-[1.55] text-(--solus-text-tertiary)"
                >
                  {current.why}
                </p>

                {#if current.id === "github"}
                  <ProviderChoiceCard rows={gitRows} label="Git hosts" />
                  {#if store.deviceCode}
                    {@render devicePrompt(
                      store.deviceCode.verificationUri,
                      store.deviceCode.userCode,
                      "Confirm this code on GitHub, then come back.",
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      class="mt-2 -ml-2 text-(--solus-text-tertiary)"
                      onclick={() => void store.cancelGithubConnect()}
                    >
                      Cancel
                    </Button>
                  {/if}
                {:else if current.id === "providers"}
                  <ProviderChoiceCard rows={providerRows} label="Coding providers" />
                  {#if store.verification}
                    {@render devicePrompt(
                      store.verification.url,
                      store.verification.code,
                      "Confirm this code in your browser, then come back.",
                    )}
                  {/if}
                {/if}

                {@render failureNote()}
              </div>
            {:else}
              <div class="mt-[1.625rem] max-w-[30rem]">
                <p
                  class="text-[0.625rem] font-medium uppercase tracking-[0.11em] text-(--solus-text-tertiary)"
                >
                  All clear
                </p>
                <h3
                  class="mt-2.5 text-[1.3125rem] font-semibold tracking-[-0.02em] text-(--solus-text-primary)"
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
                <ProviderChoiceCard rows={providerRows} label="Coding providers" />
                {#if store.verification}
                  {@render devicePrompt(
                    store.verification.url,
                    store.verification.code,
                    "Confirm this code in your browser, then come back.",
                  )}
                {/if}
                {@render failureNote()}
              </div>
            {/if}

            <div
              class="mt-8 max-w-[30rem] border-t border-(--solus-container-border) pt-[0.8125rem]"
            >
              {#if upcoming.length > 0}
                <p
                  class="text-[0.5625rem] font-medium uppercase tracking-[0.1em] text-(--solus-text-tertiary)"
                >
                  After this
                </p>
                <div class="mt-[0.3125rem] flex flex-col">
                  {#each upcoming as step (step.id)}
                    <div class="flex items-baseline gap-2.5 py-[0.1875rem]">
                      <span
                        class="shrink-0 text-[0.6875rem] tabular-nums text-(--solus-text-tertiary)"
                      >
                        {decisions.indexOf(step) + 1}
                      </span>
                      <span class="text-[0.78125rem] text-(--solus-text-tertiary)">
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
                      <span class="text-[0.78125rem] text-(--solus-text-tertiary)">
                        {step.label} · {step.detail}
                      </span>
                    </div>
                  {/each}
                </div>
              {/if}

              <div class="mt-2.5 flex items-baseline gap-1.5">
                <span class="text-[0.6875rem] text-(--solus-text-tertiary)">
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
                    {@const stepRunning = store.runningStep === step.id}
                    {@render carriedRow(
                      step.label,
                      automaticDetail(step),
                      step.done ? "done" : stepRunning ? "busy" : "wait",
                    )}
                    {#if store.stepError?.step === step.id}
                      <div class="flex items-center gap-2 pb-1 pl-[1.125rem]">
                        <p
                          class="min-w-0 flex-1 text-pretty text-[0.6875rem] leading-relaxed text-(--solus-status-error)"
                        >
                          {store.stepError.message}
                        </p>
                        <Button
                          variant="ghost"
                          size="sm"
                          class="shrink-0 px-1 text-(--solus-accent)"
                          disabled={!!store.runningStep}
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
            <p class="max-w-[13rem] text-pretty text-[0.6875rem] leading-[1.45] text-(--solus-text-tertiary)">
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
              onclick={pairingAction.run}
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

{#snippet failureNote()}
  {#if failure}
    <div
      class="mt-3.5 border-l-2 border-[color-mix(in_srgb,var(--solus-status-error)_45%,transparent)] pl-[0.6875rem]"
    >
      <p class="text-pretty text-[0.75rem] leading-relaxed text-(--solus-status-error)">
        {failure.message}
      </p>
      {#if store.logLines.length > 0}
        <div
          class="mt-1.5 flex flex-col gap-0.5 {logOpen
            ? 'max-h-[7.5rem] overflow-y-auto'
            : ''}"
        >
          {#each logOpen ? store.logLines : logTail as line, index (index)}
            <p
              class="text-[0.65625rem] leading-[1.6] text-(--solus-text-tertiary)/85"
              style="font-family: 'Geist Mono', ui-monospace, monospace"
            >
              › {line}
            </p>
          {/each}
        </div>
      {/if}
      <div class="mt-2 flex items-center gap-2">
        <Button
          size="sm"
          class="h-[1.875rem] px-3"
          disabled={!!store.runningStep}
          onclick={retryFailed}
        >
          Try again
        </Button>
        {#if store.logLines.length > logTail.length}
          <Button
            variant="ghost"
            size="sm"
            class="px-1 text-(--solus-text-tertiary)"
            onclick={() => (logOpen = !logOpen)}
          >
            {logOpen ? "Hide log" : `Full log · ${store.logLines.length} lines`}
          </Button>
        {/if}
      </div>
    </div>
  {/if}
{/snippet}

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
    <span class="min-w-0 flex-1 text-[0.75rem] text-(--solus-text-tertiary)">
      {title} · {detail}
    </span>
  </div>
{/snippet}

{#snippet devicePrompt(url: string, code: string, why: string)}
  <div class="mt-3.5 flex items-baseline gap-3">
    <span class="min-w-0 flex-1 text-pretty text-[0.75rem] leading-relaxed text-(--solus-text-tertiary)">
      {why}
    </span>
    <code
      class="shrink-0 font-mono text-[0.875rem] tracking-widest text-(--solus-text-primary)"
    >
      {code}
    </code>
    <CopyButton text={code} />
    <button
      type="button"
      class="inline-flex shrink-0 items-center gap-1 text-[0.71875rem] text-(--solus-accent) hover:underline"
      onclick={() => void window.solus.openExternal(url)}
    >
      Open
      <ArrowSquareOutIcon size={11} />
    </button>
  </div>
{/snippet}

<style>
  .hairline-scroll {
    scrollbar-width: thin;
  }
  .hairline-scroll::-webkit-scrollbar {
    width: 0.1875rem;
  }
  .hairline-scroll::-webkit-scrollbar-track {
    background: transparent;
  }
  .hairline-scroll::-webkit-scrollbar-thumb {
    background: color-mix(in srgb, var(--solus-text-tertiary) 35%, transparent);
    border-radius: 0.25rem;
  }
</style>
