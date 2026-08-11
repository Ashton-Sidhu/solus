<script lang="ts">
  /**
   * First-run onboarding, over the whole client.
   *
   * Four questions and a greeting, each on its own full-bleed stage. There is
   * no rail and no summary: the flow is short enough to hold in the head, and
   * every stage reports its own state as it goes.
   *
   * The surface holds an exclusive keybinding scope for as long as it is up, so
   * nothing behind it can fire while the shortcuts stage is inviting the user
   * to press real keys.
   */
  import { onMount } from "svelte";
  import { MoonIcon, SunIcon } from "phosphor-svelte";
  import { getSettingsContext } from "../../contexts";
  import { getKeybindingsContext } from "../../lib/keybindings/dispatcher.svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import OnboardingMark from "./OnboardingMark.svelte";
  import { onboardingStore as store } from "./onboarding.store.svelte";
  import OnboardingAgentsStage from "./OnboardingAgentsStage.svelte";
  import OnboardingProvidersStage from "./OnboardingProvidersStage.svelte";
  import OnboardingShortcutsStage from "./OnboardingShortcutsStage.svelte";
  import OnboardingStartStage from "./OnboardingStartStage.svelte";
  import type { OnboardingMode } from "./lib/onboarding-model";

  const settings = getSettingsContext();
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
   * Ends the flow. Both modes land on the workspace's new-tab home, which is
   * what an unstarted tab already renders — so chat has nothing to open. A
   * project opens the folder picker over it, through the same window event the
   * home itself uses, which is why this works identically on desktop and web.
   */
  function finish(mode: OnboardingMode) {
    store.chooseMode(mode);
    settings.update({ onboardingCompleted: true });
    if (mode === "project") {
      window.dispatchEvent(new CustomEvent("solus:open-directory-picker"));
      return;
    }
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
      finish("chat");
      return;
    }
    const target = event.target as HTMLElement | null;
    const inField =
      target?.tagName === "INPUT" ||
      target?.tagName === "TEXTAREA" ||
      target?.isContentEditable === true;
    if (event.key !== "Enter" || inField) return;
    // Only the two stages with nothing to satisfy answer to Enter. The agents
    // and providers stages dim Continue until something is connected, and a
    // keystroke that walks past a gate the button honours is worse than no
    // shortcut at all.
    if (stage === "start") {
      event.preventDefault();
      finish("project");
    } else if (stage === "shortcuts") {
      event.preventDefault();
      store.advance();
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div
  class="onboarding-shell fixed inset-0 z-[10005] flex flex-col bg-background text-foreground"
  role="dialog"
  aria-modal="true"
  aria-label="Set up Solus"
>
  <!-- Header: the two things that stay available on every stage. -->
  <div class="flex h-12 shrink-0 items-center gap-1.5 px-3 sm:px-4">
    <span class="flex-1"></span>
    <button
      type="button"
      class="flex h-6.5 items-center gap-1.5 rounded-full px-2.5 text-[0.6875rem] text-muted-foreground transition-colors duration-150 hover:bg-[var(--wash-2)]"
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
      class="h-6.5 rounded-full px-2.5 text-[0.6875rem] text-muted-foreground transition-colors duration-150 hover:bg-[var(--wash-2)] hover:text-foreground"
      onclick={() => finish("chat")}
    >
      Skip setup
    </button>
  </div>

  {#if stage === "intro" || store.introLeaving}
    <!-- The greeting sits over the first stage rather than replacing it, so the
         agent rows are already probing the host behind this fade. -->
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
            class="text-[1.75rem] font-medium sm:text-[2.125rem]"
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
    {:else if stage === "shortcuts"}
      <OnboardingShortcutsStage />
    {:else if stage === "start"}
      <OnboardingStartStage onchoose={finish} />
    {/if}
  </div>
</div>

<style>
  /* The only motion this file owns. Stage entry animations are shared by every
     stage and live in index.css; the mark owns its two-layer zoom. */
  .onboarding-shell {
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
