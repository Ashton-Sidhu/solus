<script lang="ts">
  /**
   * First-run onboarding as one page (docs/plans/one-page-onboarding.md): the
   * header, the timeline of steps, and the footer with Skip (`esc`) and the
   * one primary (`↵`). Desktop and web mount it over the workspace; it holds
   * an exclusive keybinding scope while it is up, so no shortcut acts on the
   * workspace behind it.
   */
  import { onMount, tick } from "svelte";
  import { cloudAccount } from "@solus/client-core/cloud-account";
  import { localApi } from "@solus/client-core/local-api";
  import { serverConnections } from "@solus/client-core/server-connections";
  import { getSettingsContext, getWorkspaceContext, projectsStore, serversStore } from "../../contexts";
  import { openChatDraft } from "../../contexts/workspace/new-chat";
  import { openFolder } from "../../contexts/workspace/run-location";
  import { getKeybindingsContext } from "../../lib/keybindings/dispatcher.svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import AgentsStep from "./AgentsStep.svelte";
  import CloudAgentsStep from "./CloudAgentsStep.svelte";
  import CodeStep from "./CodeStep.svelte";
  import MachineStep from "./MachineStep.svelte";
  import OnboardingFooter from "./OnboardingFooter.svelte";
  import OnboardingHeader from "./OnboardingHeader.svelte";
  import OnboardingIntro from "./OnboardingIntro.svelte";
  import PhoneStep from "./PhoneStep.svelte";
  import ProjectsStep from "./ProjectsStep.svelte";
  import ReachStep from "./ReachStep.svelte";
  import SetupStep from "./SetupStep.svelte";
  import TimelineStep from "./TimelineStep.svelte";
  import { cloudOnboardingStore as cloud } from "./cloud-onboarding.store.svelte";
  import { onboardingStore as store, type OnboardingEnd } from "./onboarding.store.svelte";
  import { SIGNING_IN_COPY, stepCopy } from "./lib/step-copy";
  import { isTypingTarget } from "./lib/onboarding-keys";

  const settings = getSettingsContext();
  const workspace = getWorkspaceContext();
  const keybindings = getKeybindingsContext();

  let primaryButton = $state<HTMLButtonElement | null>(null);
  let shell = $state<HTMLDivElement | null>(null);

  const facts = $derived(store.copyFacts);
  const organization = $derived(cloud.organization);
  const subject = $derived(
    store.flow === "cloud"
      ? (organization?.name ?? "your organization")
      : (serversStore.hostFor(store.serverId)?.label ?? `this ${facts.machineNoun}`),
  );
  const canRename = $derived(store.flow === "cloud" && organization?.namePending === true && organization.role === "owner");

  onMount(() => {
    store.start();
    const releaseScope = keybindings.pushScope("onboarding", true);
    if (!store.showsIntro) void focusPrimary();
    return releaseScope;
  });

  async function focusPrimary() {
    await tick();
    primaryButton?.focus();
  }

  function endIntro() {
    store.endIntro();
    void focusPrimary();
  }

  function after(end: OnboardingEnd) {
    if (end === "finish") finish();
    else void focusPrimary();
  }

  async function runPrimary() {
    after(await store.primary(workspace));
  }

  function runSecondary() {
    if (store.footer.secondary === "invite") {
      const url = cloudAccount()?.consoleUrl;
      if (url) void localApi.openExternal(url);
      return;
    }
    after(store.skip());
  }

  function edit(step: Parameters<typeof store.edit>[0]) {
    store.edit(step);
    void focusPrimary();
  }

  /**
   * Ends onboarding where the next natural step is typing: a draft in the
   * repository or the first chosen project, else a new chat, with the
   * composer focused.
   */
  function finish() {
    void workspace.lifecycle.refreshAgentAvailability().catch(() => {});
    if (store.flow === "cloud") {
      // Reopened from a "Get started" row: the person is already in the workspace.
      const wasReopened = cloud.reopenedAt !== null;
      if (store.isReady && cloud.chosenRepositoryKey) cloud.openChosenRepository(workspace);
      else if (!wasReopened) {
        cloud.chooseDefaultHost();
        cloud.landInChat(workspace);
      }
      void cloud.complete();
      requestInputFocus();
      return;
    }
    settings.setLayout("onboardingCompleted", true);
    const path = store.landingProjectPath;
    const serverId = store.serverId;
    if (path && serverId) {
      projectsStore.addProject(serverId, serverConnections.apiFor(serverId), path);
      const draft = workspace.drafts.openSessionDraft({ freshTask: true, target: "leading" }, path);
      draft.moveTo(openFolder(draft.run.location, { serverId, path }));
    } else {
      openChatDraft(workspace, "click");
    }
    requestInputFocus();
  }

  function onKeydown(event: KeyboardEvent) {
    if (store.showsIntro) {
      event.preventDefault();
      endIntro();
      return;
    }
    const target = event.target instanceof HTMLElement ? event.target : null;
    // A dialog or menu opened from a step (the folder picker, the size menu) keeps its own keys.
    if (target && target !== document.body && !shell?.contains(target)) return;
    if (event.key === "Escape") {
      event.preventDefault();
      // Escape in a field leaves the field first.
      if (target && isTypingTarget(target)) target.blur();
      else runSecondary();
      return;
    }
    if (event.key !== "Enter" || event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
    // Fields, buttons, and links answer Enter themselves; a radio row's Enter is the primary.
    if (target && (isTypingTarget(target) || (target.closest("button, a") && target.getAttribute("role") !== "radio"))) return;
    event.preventDefault();
    void runPrimary();
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div
  bind:this={shell}
  class="onboarding-shell @container fixed inset-0 z-[10005] overflow-y-auto text-(--solus-text-primary)"
  role="dialog"
  aria-modal="true"
  aria-label="Set up Solus"
>
  <div class="drag-region absolute inset-x-0 top-0 h-10" aria-hidden="true"></div>
  <div class="mx-auto flex min-h-full w-full max-w-[47.5rem] flex-col px-4 pt-12 pb-16 @min-[40rem]:px-10 @min-[40rem]:pt-22 @min-[40rem]:pb-24">
    <OnboardingHeader
      {subject}
      progress={store.progress}
      isReady={store.isReady}
      email={store.flow === "desktop" ? facts.email : null}
      onrename={canRename ? (name) => cloud.renameOrganization(name) : undefined}
    />

    <ol class="m-0 list-none border-t border-(--hairline) p-0" aria-label="Setup steps">
      {#each store.timeline as entry, index (entry.step)}
        {@const copy = store.signingIn && entry.step === "setup" ? { ...SIGNING_IN_COPY, editLabel: "Change" as const } : stepCopy(entry.step, entry.status, facts)}
        <TimelineStep
          {entry}
          {copy}
          isFirst={index === 0}
          isLast={index === store.timeline.length - 1}
          onedit={store.signingIn || store.isBusy ? undefined : () => edit(entry.step)}
        >
          {#snippet body()}
            {#if entry.step === "setup"}
              <SetupStep machineNoun={facts.machineNoun} />
            {:else if entry.step === "agents"}
              {#if store.flow === "cloud"}<CloudAgentsStep />{:else}<AgentsStep machineNoun={facts.machineNoun} />{/if}
            {:else if entry.step === "projects"}
              <ProjectsStep machineNoun={facts.machineNoun} />
            {:else if entry.step === "phone"}
              <PhoneStep />
            {:else if entry.step === "reach"}
              <ReachStep machineNoun={facts.machineNoun} />
            {:else if entry.step === "machine"}
              <MachineStep />
            {:else if entry.step === "code"}
              <CodeStep />
            {/if}
          {/snippet}
        </TimelineStep>
      {/each}
    </ol>

    <OnboardingFooter
      footer={store.footer}
      isBusy={store.isBusy}
      bind:primaryRef={primaryButton}
      onprimary={() => void runPrimary()}
      onsecondary={runSecondary}
    />
  </div>

  {#if store.showsIntro}
    <OnboardingIntro onend={endIntro} />
  {/if}
</div>

<style>
  .onboarding-shell {
    /* --background is translucent in dark mode (the app composites it over the
       window edge), so it is layered over the opaque edge colour here; a plain
       bg-background lets the workspace show through. The shell does not fade
       in: it replaces the apps' opaque loading cover. */
    background: linear-gradient(var(--background), var(--background)) var(--solus-edge-bg);
  }
</style>
