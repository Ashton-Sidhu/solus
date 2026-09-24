<script lang="ts">
  /**
   * The last thing onboarding asks, and the only stage that decides where the
   * user lands. A new project and existing code each ask one more question —
   * the project's name, or its folder — inside the flow. "Just chat" ends the
   * flow on the workspace's new-tab home.
   */
  import {
    MessageCircle as ChatCircleIcon,
    Code as CodeIcon,
    FolderPlus as FolderPlusIcon,
  } from "@lucide/svelte";
  import { onboardingStore as store } from "./onboarding.store.svelte";
  import OnboardingRow from "./OnboardingRow.svelte";
  import OnboardingStageActions from "./OnboardingStageActions.svelte";

  interface Props {
    /** Ends the flow with a chat. */
    onchat: () => void;
  }

  let { onchat }: Props = $props();
</script>

<div
  class="flex min-h-full flex-col items-center justify-center px-6 py-10 sm:px-10 sm:py-12"
>
  <h1
    class="onboarding-title m-0 shrink-0 text-center text-2xl font-medium leading-[1.12] sm:text-2xl"
  >
    How do you want to start?
  </h1>

  <div class="mt-8 flex w-full max-w-[28.25rem] shrink-0 flex-col gap-2.5 sm:mt-10">
    <OnboardingRow
      name="Start something new"
      detail="Name a new project and let an agent build it"
      delay={0.14}
      tint="var(--chart-2)"
      state="available"
      onpick={() => store.nameNewProject()}
    >
      {#snippet mark()}
        <FolderPlusIcon size={18} />
      {/snippet}
    </OnboardingRow>

    <OnboardingRow
      name="Open existing code"
      detail="Run agents against a codebase and review the diff"
      delay={0.22}
      tint="var(--chart-1)"
      state="available"
      onpick={() => store.openExistingCode()}
    >
      {#snippet mark()}
        <CodeIcon size={18} />
      {/snippet}
    </OnboardingRow>

    <OnboardingRow
      name="Just chat"
      detail="Ask questions and sketch approaches, no repository needed"
      delay={0.3}
      tint="var(--chart-3)"
      state="available"
      onpick={onchat}
    >
      {#snippet mark()}
        <ChatCircleIcon size={18} />
      {/snippet}
    </OnboardingRow>
  </div>

  <OnboardingStageActions
    continueLabel="Start something new"
    continueEnabled
    oncontinue={() => store.nameNewProject()}
    onback={() => store.back()}
    onskip={onchat}
    skipLabel="Just chat"
  />
</div>
