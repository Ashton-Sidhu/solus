<script lang="ts">
  /**
   * First-run onboarding, over the whole client.
   *
   * Four questions and a greeting, each on its own full-bleed stage. There is
   * no rail and no summary: the flow is short enough to hold in the head, and
   * every stage reports its own state as it goes.
   *
   * The surface holds an exclusive keybinding scope for as long as it is up, so
   * no shortcut can act on the workspace behind it.
   */
  import { onMount } from "svelte";
  import { serverConnections } from "@solus/client-core/server-connections";
  import { Moon as MoonIcon, Sun as SunIcon } from "@lucide/svelte";
  import {
    getSettingsContext,
    getWorkspaceContext,
    projectsStore,
    serversStore,
  } from "../../contexts";
  import { withProjectHost } from "../../contexts/workspace/run-config";
  import { getKeybindingsContext } from "../../lib/keybindings/dispatcher.svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import OnboardingMark from "./OnboardingMark.svelte";
  import { onboardingStore as store } from "./onboarding.store.svelte";
  import OnboardingAgentsStage from "./OnboardingAgentsStage.svelte";
  import OnboardingGesturesStage from "./OnboardingGesturesStage.svelte";
  import OnboardingHostStage from "./OnboardingHostStage.svelte";
  import OnboardingProvidersStage from "./OnboardingProvidersStage.svelte";
  import OnboardingStartStage from "./OnboardingStartStage.svelte";
  import OnboardingComputeStage from "./OnboardingComputeStage.svelte";
  import OnboardingAccountGithubStage from "./OnboardingAccountGithubStage.svelte";
  import OnboardingProjectStage from "./OnboardingProjectStage.svelte";
  import OnboardingNameProjectStage from "./OnboardingNameProjectStage.svelte";
  import OnboardingOpenProjectStage from "./OnboardingOpenProjectStage.svelte";
  import OnboardingCloudConnectStage from "./OnboardingCloudConnectStage.svelte";
  import { cloudOnboardingStore as cloud } from "./cloud-onboarding.store.svelte";
  import type { OnboardingMode } from "./lib/onboarding-model";

  const settings = getSettingsContext();
  const workspace = getWorkspaceContext();
  const keybindings = getKeybindingsContext();

  const stage = $derived(store.stage);

  onMount(() => {
    store.start();
    const releaseScope = keybindings.pushScope("onboarding", true);
    return () => {
      releaseScope();
      store.stop();
    };
  });

  /**
   * Ends the flow with a chat, which is also what Skip setup does. It lands on
   * the workspace's new-tab home — what an unstarted tab already renders — so
   * there is nothing to open.
   */
  function finishWithChat() {
    if (store.flow === "cloud") {
      void finishCloud(false);
      return;
    }
    store.chooseMode("chat");
    settings.update({ onboardingCompleted: true });
    // The boot-time start() probed agent binaries before onboarding had a
    // chance to install or repair anything, and a stale "Not installed" would
    // otherwise survive into the agent picker until the next launch.
    void workspace.lifecycle.refreshAgentAvailability().catch(() => {});
    requestInputFocus();
  }

  /**
   * Ends the cloud flow for the account, on every device, and opens the work
   * it chose: the repository, else the person's workspace on the chosen machine.
   */
  async function finishCloud(withProject: boolean) {
    // Reopened from a "Get started" row: skipping only closes it again; the
    // person is already in the workspace and a new session would be noise.
    const wasReopened = cloud.reopenedAt !== null;
    void cloud.complete();
    void workspace.lifecycle.refreshAgentAvailability().catch(() => {});
    if (!wasReopened || withProject) await cloud.land(workspace, withProject);
    requestInputFocus();
  }

  /**
   * Ends either flow once the project exists — named new, or chosen from
   * existing code: a draft opens in it on its host with the composer focused,
   * because the next thing to do is say what to build.
   */
  function finishWithProject(
    mode: Exclude<OnboardingMode, "chat">,
    project: { serverId: string; path: string },
  ) {
    if (store.flow === "cloud") {
      void cloud.complete();
    } else {
      store.chooseMode(mode);
      settings.update({ onboardingCompleted: true });
    }
    void workspace.lifecycle.refreshAgentAvailability().catch(() => {});
    projectsStore.addProject(project.serverId, serverConnections.apiFor(project.serverId), project.path);
    const draft = workspace.drafts.openSessionDraft(
      { freshTask: true, target: workspace.router.leadingPane.id },
      project.path,
    );
    draft.run = withProjectHost(draft.run, project.serverId, {
      path: project.path,
      isolate: serversStore.isolatesSessions(project.serverId),
    });
    requestInputFocus();
  }

  function onKeydown(event: KeyboardEvent) {
    if (stage === "intro") {
      event.preventDefault();
      store.endIntro();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      // Naming a project or choosing its folder is a step into the start
      // stage, so Escape steps back out.
      if (stage === "name-project" || stage === "open-project") store.back();
      else finishWithChat();
      return;
    }
    const target = event.target instanceof HTMLElement ? event.target : null;
    const inField =
      target?.tagName === "INPUT" ||
      target?.tagName === "TEXTAREA" ||
      target?.isContentEditable === true;
    if (event.key !== "Enter" || inField) return;
    // Only the stages with nothing to satisfy answer to Enter. The agents and
    // providers stages dim Continue until something is connected, and a
    // keystroke that walks past a gate the button honours is worse than no
    // shortcut at all.
    if (stage === "start") {
      event.preventDefault();
      store.nameNewProject();
    } else if (stage === "cloud-connect" && target?.tagName !== "BUTTON") {
      // A focused Connect button keeps Enter, so connecting stays keyboard-reachable.
      event.preventDefault();
      store.advance();
    } else if (stage === "getting-around") {
      event.preventDefault();
      store.advance();
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div
  class="onboarding-shell fixed inset-0 z-[10005] flex flex-col text-foreground"
  role="dialog"
  aria-modal="true"
  aria-label="Set up Solus"
>
  <!-- Header: the two things that stay available on every stage. -->
  <div class="flex h-12 shrink-0 items-center gap-1.5 px-3 sm:px-4">
    <span class="flex-1"></span>
    <button
      type="button"
      class="no-drag flex h-6.5 items-center gap-1.5 rounded-full px-2.5 text-xs text-muted-foreground transition-colors duration-150 hover:bg-[var(--wash-2)]"
      title="Toggle appearance"
      onclick={() =>
        settings.update({ themeMode: settings.isDark ? "light" : "dark" })}
    >
      {#if settings.isDark}
        <MoonIcon size={13} />
        Dark
      {:else}
        <SunIcon size={13} />
        Light
      {/if}
    </button>
    <button
      type="button"
      class="no-drag h-6.5 rounded-full px-2.5 text-xs text-muted-foreground transition-colors duration-150 hover:bg-[var(--wash-2)] hover:text-foreground"
      onclick={finishWithChat}
    >
      Skip setup
    </button>
  </div>

  {#if stage === "intro" || store.introLeaving}
    <!-- The greeting sits over the first stage rather than replacing it, so
         the stage is already laid out behind this fade. -->
    <button
      type="button"
      class="absolute inset-x-0 bottom-0 top-12 z-30 flex items-center justify-center overflow-hidden bg-background transition-opacity duration-[550ms]"
      class:opacity-0={store.introLeaving}
      class:pointer-events-none={store.introLeaving}
      aria-label="Skip the introduction"
      onclick={() => store.endIntro()}
    >
      {#if store.introPhase === "mark"}
        <OnboardingMark class="size-[7.75rem] shrink-0" />
      {:else}
        <span class="flex items-center justify-center">
          <span
            class="text-2xl font-medium sm:text-2xl"
            >{store.introTyped}</span
          >
          <span
            class="onboarding-caret ml-1 inline-block w-[0.15625rem] rounded-sm bg-primary"
            style="height: 2.125rem"
          ></span>
        </span>
      {/if}
    </button>
  {/if}

  <div class="min-h-0 flex-1 overflow-y-auto">
    {#if stage === "agents"}
      <OnboardingAgentsStage />
    {:else if stage === "providers"}
      <OnboardingProvidersStage />
    {:else if stage === "getting-around"}
      <OnboardingGesturesStage />
    {:else if stage === "host"}
      <OnboardingHostStage />
    {:else if stage === "start"}
      <OnboardingStartStage onchat={finishWithChat} />
    {:else if stage === "compute"}
      <OnboardingComputeStage />
    {:else if stage === "github"}
      <OnboardingAccountGithubStage onskip={() => void finishCloud(false)} />
    {:else if stage === "project"}
      <OnboardingProjectStage
        onstart={() => void finishCloud(true)}
        onskip={() => void finishCloud(false)}
        onnew={() => store.nameNewProject()}
      />
    {:else if stage === "name-project"}
      <OnboardingNameProjectStage
        serverId={store.serverId}
        oncreated={(project) => finishWithProject("new-project", project)}
        onskip={finishWithChat}
      />
    {:else if stage === "open-project"}
      <OnboardingOpenProjectStage
        serverId={store.serverId}
        onopened={(project) => finishWithProject("project", project)}
        onskip={finishWithChat}
      />
    {:else if stage === "cloud-connect"}
      <OnboardingCloudConnectStage />
    {/if}
  </div>
</div>

<style>
  /* The only motion this file owns. Stage entry animations are shared by every
     stage and live in index.css; the mark owns its two-layer zoom. */
  .onboarding-shell {
    /* --background is translucent in dark mode (the app composites it over the
       window edge), so it is layered over the opaque edge color here — a plain
       bg-background lets the workspace show through the overlay. */
    background: linear-gradient(var(--background), var(--background))
      var(--solus-edge-bg);
    animation: onboarding-shell 0.34s ease-out both;
  }
  @keyframes onboarding-shell {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .onboarding-shell {
      animation: none;
    }
  }
</style>
