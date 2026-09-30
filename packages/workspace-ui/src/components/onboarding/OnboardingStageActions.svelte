<script lang="ts">
  /**
   * The actions under an arrival stage. Continue is the stage's one primary
   * call to action; Back and Skip stay quiet beside it. Continue dims rather
   * than disappearing when the stage has nothing to carry forward, so the shape
   * of the stage never changes as it fills in — and Skip is always live beside
   * it, because none of the arrival stages is allowed to trap anyone.
   */
  import { Button } from "../ui/button";

  interface Props {
    continueLabel: string;
    continueEnabled: boolean;
    oncontinue: () => void;
    onback?: () => void;
    onskip: () => void;
    skipLabel?: string;
  }

  let {
    continueLabel,
    continueEnabled,
    oncontinue,
    onback,
    onskip,
    skipLabel = "Skip",
  }: Props = $props();
</script>

<div class="onboarding-fade mt-6 flex shrink-0 items-center gap-1.5">
  {#if onback}
    <Button
      variant="ghost"
      class="px-3 text-sm text-muted-foreground"
      onclick={onback}
    >
      Back
    </Button>
  {/if}
  <Button
    class="px-3 text-sm"
    disabled={!continueEnabled}
    onclick={oncontinue}
  >
    {continueLabel}
  </Button>
  <Button
    variant="ghost"
    class="px-3 text-sm text-muted-foreground"
    onclick={onskip}
  >
    {skipLabel}
  </Button>
</div>
