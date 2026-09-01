<script lang="ts">
  /**
   * The last thing onboarding asks, and the only stage that decides where the
   * user lands. Answering it ends the flow: both answers open the workspace's
   * new-tab home, and a project also opens the folder picker on top of it, so
   * the first thing on screen is the choice that was just made.
   */
  import { ChatCircleIcon, CodeIcon } from "phosphor-svelte";
  import { onboardingStore as store } from "./onboarding.store.svelte";
  import OnboardingRow from "./OnboardingRow.svelte";
  import OnboardingStageActions from "./OnboardingStageActions.svelte";
  import type { OnboardingMode } from "./lib/onboarding-model";

  interface Props {
    onchoose: (mode: OnboardingMode) => void;
  }

  let { onchoose }: Props = $props();
</script>

<div
  class="flex min-h-full flex-col items-center justify-center px-6 py-10 sm:px-10 sm:py-12"
>
  <h1
    class="onboarding-title m-0 shrink-0 text-center text-[1.5rem] font-medium leading-[1.12] sm:text-[1.5rem]"
  >
    How do you want to start?
  </h1>

  <div class="mt-8 flex w-full max-w-[28.25rem] shrink-0 flex-col gap-2.5 sm:mt-10">
    <OnboardingRow
      name="Start in a project"
      detail="Run agents against a codebase and review the diff"
      delay={0.14}
      tint="var(--chart-1)"
      state="available"
      onpick={() => onchoose("project")}
    >
      {#snippet mark()}
        <CodeIcon size={18} />
      {/snippet}
    </OnboardingRow>

    <OnboardingRow
      name="Just chat"
      detail="Ask questions and sketch approaches, no repository needed"
      delay={0.22}
      tint="var(--chart-3)"
      state="available"
      onpick={() => onchoose("chat")}
    >
      {#snippet mark()}
        <ChatCircleIcon size={18} />
      {/snippet}
    </OnboardingRow>
  </div>

  <OnboardingStageActions
    continueLabel="Start in a project"
    continueEnabled
    oncontinue={() => onchoose("project")}
    onback={() => store.back()}
    onskip={() => onchoose("chat")}
    skipLabel="Just chat"
  />
</div>
