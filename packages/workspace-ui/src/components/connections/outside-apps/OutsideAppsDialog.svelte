<script lang="ts">
  /** "Use Solus in other apps · {host}" (plans/035 §10, after T3 Code's "Use in
   *  another app"): a gate until the host can serve the app's address, then the
   *  steps App → Access → Connect. "Approve a sign-in" is its other view, from
   *  the first step, the palette, or a sign-in link; it needs no address, so it
   *  skips the gate. The palette, the host's Access tab, and the host menu open
   *  it for one host; `OutsideAppsDialogHost` mounts it. */
  import { onMount, tick } from "svelte";
  import { AppWindow as AppWindowIcon, SquareTerminal as TerminalIcon, X as CloseIcon } from "@lucide/svelte";
  import type { AppAccess } from "@solus/contracts/host-api";
  import { LOCAL_POLICY_ORGANIZATION_ID } from "@solus/contracts/policy";
  import { connectionsStore, getWorkspaceContext, uplinkStore } from "../../../contexts";
  import { hosts } from "../../../contexts/hosts/hosts.svelte";
  import { policiesOn, workPolicy } from "../../../contexts/policy/work-policy.svelte";
  import { useScope } from "../../../lib/keybindings/use-keybinding.svelte";
  import { Button } from "../../ui/button";
  import { connectionsNav } from "../connections-nav.svelte";
  import { DEFAULT_OUTSIDE_APP_ACCESS, OUTSIDE_APP_ACCESS_LEVELS, outsideAppChoices } from "../lib/outside-apps";
  import { gateAddressKind, resolveOutsideAppGate } from "../lib/outside-apps-gate";
  import { hostLabel, isHostComputer, outsideAppsDialog } from "./outside-apps-dialog.svelte";
  import OutsideAppsApprove from "./OutsideAppsApprove.svelte";
  import OutsideAppsConnect from "./OutsideAppsConnect.svelte";
  import OutsideAppsGate from "./OutsideAppsGate.svelte";

  interface Props {
    serverId: string;
  }

  let { serverId }: Props = $props();

  const STEPS = ["App", "Access", "Connect"] as const;
  /** The choice "Something else…": an app with no guide. */
  const OTHER = "other";

  const workspace = getWorkspaceContext();
  let step = $state(0);
  let choiceId = $state<string | null>(null);
  let access = $state<AppAccess>(DEFAULT_OUTSIDE_APP_ACCESS);
  let dialogEl = $state<HTMLDivElement | null>(null);
  let panelEl = $state<HTMLDivElement | null>(null);

  const hostName = $derived(hostLabel(serverId));
  const onHostComputer = $derived(isHostComputer(serverId));
  // The host checks an app against the policy of the person who approves it:
  // a member's organization, or the owner's personal work (plans/035 §0.3).
  const appPolicy = $derived(
    hosts.get(serverId).me.principal === "org-member"
      ? workPolicy(serverId)
      : policiesOn(serverId).forWork(LOCAL_POLICY_ORGANIZATION_ID),
  );
  const choices = $derived(outsideAppChoices(appPolicy));
  const guide = $derived(choices.find((choice) => choice.guide.id === choiceId && !choice.denial)?.guide ?? null);
  // "Something else…" is an app Solus cannot name: the policy's `other`.
  const otherDenial = $derived(appPolicy.appDenial("other")?.message ?? null);
  const hasChoice = $derived(guide !== null || (choiceId === OTHER && !otherDenial));
  const gate = $derived(resolveOutsideAppGate({
    addressKind: gateAddressKind(step === 0 || !hasChoice ? undefined : guide, onHostComputer),
    endpoint: connectionsStore.appEndpoint,
    endpointError: connectionsStore.appEndpointError,
    uplink: uplinkStore.statusFor(serverId),
    uplinkError: uplinkStore.statusErrorFor(serverId),
    selfTest: uplinkStore.selfTestFor(serverId),
    turningOn: outsideAppsDialog.isTurningOn,
  }));
  const needsSelfTest = $derived(gate.kind === "checking" && gate.needsSelfTest);
  const appName = $derived(guide?.name ?? "the app");
  const isApproving = $derived(outsideAppsDialog.view === "approve");

  // The host forgets a finished test when its link changes; the gate asks for a new one then.
  $effect(() => {
    if (needsSelfTest) void uplinkStore.runSelfTest(serverId);
  });

  onMount(() => {
    // The approve view puts focus on its own code field.
    if (!isApproving) void focusPanel();
  });

  // A modal: shortcuts behind it stay quiet while it is open.
  useScope("modal-dialog", { exclusive: true, pre: true });

  /** Puts focus on the first control of the step, so the keyboard goes on from there. */
  async function focusPanel() {
    await tick();
    const first = panelEl?.querySelector<HTMLElement>("button:not(:disabled), input:checked, input, [href]");
    (first ?? dialogEl)?.focus();
  }

  function goTo(index: number) {
    step = index;
    void focusPanel();
  }

  function showConnect() {
    outsideAppsDialog.show("connect");
    goTo(0);
  }

  function pick(id: string) {
    choiceId = id;
  }

  function manageAccess() {
    outsideAppsDialog.close({ refocus: false });
    connectionsNav.open(serverId, "access");
    workspace.showSettings("api-access", "click");
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
  data-solus-ui
  class="pointer-events-auto fixed inset-0 z-[10008] flex items-start justify-center modal-backdrop px-4 pt-[12vh] motion-safe:animate-[backdrop-fade_140ms_ease-out]"
  role="presentation"
  onclick={(event) => { if (event.target === event.currentTarget) outsideAppsDialog.close(); }}
  onkeydown={(event) => { if (event.key === "Escape") { event.stopPropagation(); outsideAppsDialog.close(); } }}
>
  <div
    bind:this={dialogEl}
    tabindex="-1"
    class="flex max-h-[min(44rem,85svh)] w-[min(34rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-3xl border-[0.0625rem] border-(--solus-popover-border) bg-(--solus-popover-bg) text-workspace-chrome text-(--solus-text-primary) shadow-[shadow:var(--solus-popover-shadow)] outline-none"
    role="dialog"
    aria-modal="true"
    aria-labelledby="outside-apps-dialog-title"
    data-testid="outside-apps-dialog"
  >
    <header class="flex flex-col gap-3 px-6 pt-5">
      <div class="flex items-start justify-between gap-3">
        <h2 id="outside-apps-dialog-title" class="min-w-0 text-base font-medium text-pretty text-(--solus-text-primary)">
          Use Solus in other apps · {hostName}
        </h2>
        <Button variant="ghost" size="icon-sm" class="-mt-1 -mr-2 shrink-0 text-(--solus-text-tertiary)" aria-label="Close" onclick={() => outsideAppsDialog.close()}>
          <CloseIcon size={16} />
        </Button>
      </div>
      {#if gate.kind === "open" && !isApproving}
        <ol class="flex items-center gap-1" aria-label="Steps">
          {#each STEPS as label, index (label)}
            <li class="flex min-w-0 flex-1 flex-col gap-1.5">
              <span class={["h-0.5 rounded-full", index <= step ? "bg-primary" : "bg-border"]}></span>
              <button
                type="button"
                disabled={index > step}
                aria-current={index === step ? "step" : undefined}
                onclick={() => goTo(index)}
                class={[
                  "truncate text-left text-chrome-dense outline-none focus-visible:underline disabled:cursor-default",
                  index === step ? "font-medium text-(--solus-text-primary)" : index < step ? "text-(--solus-text-secondary) hover:text-(--solus-text-primary)" : "text-(--solus-text-tertiary)",
                ]}
              >
                {index + 1}. {label}
              </button>
            </li>
          {/each}
        </ol>
      {/if}
    </header>

    <div bind:this={panelEl} class="min-h-0 flex-1 overflow-y-auto px-6 py-5">
      {#if isApproving}
        {#key outsideAppsDialog.signInRequestId}
          <OutsideAppsApprove {serverId} {hostName} signInRequestId={outsideAppsDialog.signInRequestId} />
        {/key}
      {:else if gate.kind !== "open"}
        <OutsideAppsGate {serverId} {hostName} {gate} />
      {:else if step === 0}
        <section class="flex flex-col gap-3">
          <h3 id="outside-apps-choose" class="text-workspace-chrome font-medium">Which app?</h3>
          <div role="group" aria-labelledby="outside-apps-choose" class="grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-2">
            {#each choices as choice (choice.guide.id)}
              {@const AppIcon = choice.guide.handoff.kind === "commands" ? TerminalIcon : AppWindowIcon}
              <button
                type="button"
                aria-pressed={choice.guide.id === choiceId}
                disabled={!!choice.denial}
                title={choice.denial ?? undefined}
                onclick={() => pick(choice.guide.id)}
                class="flex min-w-0 items-center gap-2 overflow-hidden rounded-lg border border-border px-2.5 py-2 text-left outline-none transition-colors hover:bg-(--solus-surface-hover) focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:hover:bg-transparent aria-pressed:border-primary aria-pressed:bg-primary/8 pointer-coarse:min-h-11"
              >
                <AppIcon size={16} class={["shrink-0", choice.denial ? "text-(--solus-text-tertiary)" : "text-foreground"]} />
                <span class="flex min-w-0 flex-col">
                  <span class={["truncate text-workspace-chrome", choice.denial ? "text-(--solus-text-tertiary)" : "text-(--solus-text-primary)"]}>{choice.guide.name}</span>
                  {#if choice.denial}
                    <span class="truncate text-chrome-dense text-(--solus-text-tertiary)">Not allowed</span>
                  {/if}
                </span>
              </button>
            {/each}
          </div>
          <button
            type="button"
            aria-pressed={choiceId === OTHER}
            disabled={!!otherDenial}
            title={otherDenial ?? undefined}
            onclick={() => pick(OTHER)}
            class="w-full rounded-lg border border-border px-3 py-2.5 text-workspace-chrome font-medium outline-none transition-colors hover:bg-(--solus-surface-hover) focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:text-(--solus-text-tertiary) disabled:hover:bg-transparent aria-pressed:border-primary aria-pressed:bg-primary/8 pointer-coarse:min-h-11"
          >
            {otherDenial ? "Something else… · Not allowed" : "Something else…"}
          </button>
          {#if otherDenial || choices.some((choice) => choice.denial)}
            <p class="text-chrome-dense text-(--solus-text-tertiary)">Your organization does not allow the apps marked Not allowed.</p>
          {/if}
        </section>
      {:else if step === 1}
        <fieldset class="flex flex-col gap-2">
          <legend class="mb-3 text-workspace-chrome font-medium">What can {appName} do?</legend>
          {#each OUTSIDE_APP_ACCESS_LEVELS as level (level.access)}
            <label class="flex cursor-pointer items-start gap-3 rounded-lg border border-border px-3 py-2.5 transition-colors hover:bg-(--solus-surface-hover) has-checked:border-primary has-checked:bg-primary/8 has-focus-visible:ring-3 has-focus-visible:ring-ring/50">
              <input type="radio" name="outside-app-access" value={level.access} bind:group={access} class="mt-1 shrink-0 accent-(--primary) outline-none" />
              <span class="flex min-w-0 flex-col gap-0.5">
                <span class="text-workspace-chrome font-medium text-(--solus-text-primary)">{level.label}</span>
                <span class="text-chrome-dense text-(--solus-text-secondary)">{level.effect}</span>
              </span>
            </label>
          {/each}
        </fieldset>
      {:else}
        {#key `${choiceId}:${access}`}
          <OutsideAppsConnect {serverId} mcpUrl={gate.mcpUrl} {guide} {access} />
        {/key}
      {/if}
    </div>

    {#if isApproving}
      <footer class="flex items-center justify-between gap-2 border-t border-border px-6 py-3.5">
        <Button variant="ghost" size="sm" onclick={showConnect}>Connect an app</Button>
        <Button size="sm" variant="outline" onclick={() => outsideAppsDialog.close()}>Done</Button>
      </footer>
    {:else}
      <footer class="flex items-center justify-between gap-2 border-t border-border px-6 py-3.5">
        <div>
          {#if step === 0}
            <Button variant="ghost" size="sm" onclick={() => outsideAppsDialog.show("approve")}>Approve a sign-in</Button>
          {:else if gate.kind === "open" && step === 2}
            <Button variant="ghost" size="sm" onclick={manageAccess}>Manage access</Button>
          {/if}
        </div>
        <div class="flex items-center gap-2">
          {#if step > 0 && (step === 1 || gate.kind !== "open")}
            <Button variant="outline" size="sm" onclick={() => goTo(step - 1)}>Back</Button>
          {/if}
          {#if gate.kind === "open"}
            {#if step === 2}
              <Button size="sm" onclick={() => outsideAppsDialog.close()}>Done</Button>
            {:else}
              <Button size="sm" disabled={step === 0 && !hasChoice} onclick={() => goTo(step + 1)}>Next</Button>
            {/if}
          {/if}
        </div>
      </footer>
    {/if}
  </div>
</div>
