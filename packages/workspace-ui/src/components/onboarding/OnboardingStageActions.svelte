<script lang="ts">
  /**
   * The quiet pair under an arrival stage. Continue dims rather than
   * disappearing when the stage has nothing to carry forward, so the shape of
   * the stage never changes as it fills in — and Skip is always live beside it,
   * because none of the arrival stages is allowed to trap anyone.
   */
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
    <button
      type="button"
      class="h-8 rounded-[0.5625rem] px-3.5 text-sm font-medium text-muted-foreground transition-colors duration-150 hover:text-foreground"
      onclick={onback}
    >
      Back
    </button>
  {/if}
  <button
    type="button"
    class="h-8 rounded-[0.5625rem] px-3.5 text-sm font-medium text-muted-foreground transition-[color,opacity] duration-200 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:text-muted-foreground"
    disabled={!continueEnabled}
    onclick={oncontinue}
  >
    {continueLabel}
  </button>
  <button
    type="button"
    class="h-8 rounded-[0.5625rem] px-3.5 text-sm font-medium text-muted-foreground opacity-70 transition-[color,opacity] duration-150 hover:text-foreground hover:opacity-100"
    onclick={onskip}
  >
    {skipLabel}
  </button>
</div>
