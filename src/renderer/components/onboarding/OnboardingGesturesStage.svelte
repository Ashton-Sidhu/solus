<script lang="ts">
  /**
   * "Four ways around." What the touch flow teaches in place of the keys.
   *
   * Nothing here can be tried on the spot the way a shortcut can — the surface
   * is over the layout these gestures act on — so the rows report what a gesture
   * does rather than inviting a press and lighting up. Every one is a gesture
   * the mobile layout already answers to.
   */
  import {
    ArrowUUpLeftIcon,
    HandSwipeRightIcon,
    HandTapIcon,
    PlusIcon,
  } from "phosphor-svelte";
  import { onboardingStore as store } from "./onboarding.store.svelte";
  import { ONBOARDING_GESTURES } from "./lib/onboarding-model";
  import OnboardingStageActions from "./OnboardingStageActions.svelte";

  // Indexed by `GestureGlyph`, so a glyph added to the list without a mark here
  // fails to compile rather than rendering nothing.
  const GLYPHS = {
    swipe: HandSwipeRightIcon,
    tap: HandTapIcon,
    plus: PlusIcon,
    back: ArrowUUpLeftIcon,
  };
</script>

<div
  class="flex min-h-full flex-col items-center justify-center px-6 py-10 sm:px-10 sm:py-12"
>
  <h1
    class="onboarding-title m-0 shrink-0 text-center text-2xl font-medium leading-[1.12] sm:text-2xl"
  >
    Four ways around
  </h1>
  <p
    class="onboarding-title mt-3 max-w-[34ch] shrink-0 text-center text-sm leading-[1.6] text-muted-foreground"
    style="animation-delay: 0.06s"
  >
    Everything else is where you would expect it.
  </p>

  <div class="mt-8 flex w-full max-w-[28.25rem] shrink-0 flex-col gap-2.5 sm:mt-10">
    {#each ONBOARDING_GESTURES as gesture, index (gesture.glyph)}
      {@const Glyph = GLYPHS[gesture.glyph]}
      <div
        class="onboarding-enter flex min-h-[4.5rem] items-center gap-3.5 rounded-2xl bg-[var(--wash-1)] px-4 py-3"
        style="animation-delay: {index * 0.05}s"
      >
        <span
          class="flex size-10 shrink-0 items-center justify-center rounded-full"
          style="background: color-mix(in oklch, var(--primary) 14%, transparent); color: color-mix(in oklch, var(--primary) 68%, var(--foreground))"
        >
          <Glyph size={18} />
        </span>
        <span class="flex min-w-0 flex-col gap-1">
          <span class="text-sm font-medium">{gesture.label}</span>
          <span class="truncate text-sm text-muted-foreground">{gesture.hint}</span>
        </span>
      </div>
    {/each}
  </div>

  <OnboardingStageActions
    continueLabel="Continue"
    continueEnabled
    oncontinue={() => store.advance()}
    onskip={() => store.advance()}
  />
</div>
