<script lang="ts">
  /**
   * The optional step before the last one on desktop: connect this app to
   * Solus Cloud. It comes before "How do you want to start?", so the flow ends
   * on the choice of where to work. Continue and Not now both move on;
   * connecting is never required.
   */
  import { onboardingStore as store } from "./onboarding.store.svelte";
  import OnboardingCloudConnectRow from "./OnboardingCloudConnectRow.svelte";
  import OnboardingStageActions from "./OnboardingStageActions.svelte";
</script>

<div class="flex min-h-full flex-col items-center justify-center px-6 py-10 sm:px-10 sm:py-12">
  <h1 class="onboarding-title m-0 shrink-0 text-center text-2xl font-medium leading-[1.12]">
    Connect to Solus Cloud
  </h1>
  <p
    class="onboarding-title mt-3 w-full max-w-[28.25rem] shrink-0 text-center text-sm leading-[1.6] text-muted-foreground"
    style="animation-delay: 0.06s"
  >
    Optional. You can also do this later in Settings → Connections.
  </p>

  <div class="mt-8 flex w-full max-w-[28.25rem] shrink-0 flex-col gap-2.5 sm:mt-10">
    <OnboardingCloudConnectRow delay={0.14} />
  </div>

  <OnboardingStageActions
    continueLabel="Continue"
    continueEnabled
    oncontinue={() => store.advance()}
    onback={() => store.back()}
    onskip={() => store.advance()}
    skipLabel="Not now"
  />
</div>
