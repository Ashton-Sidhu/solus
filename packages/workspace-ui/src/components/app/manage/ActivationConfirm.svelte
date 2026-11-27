<script lang="ts">
  import { activationConfirmation, activationLabel } from "@solus/client-core/app-versions";
  import { Button } from "../../ui/button";
  import MarkdownAlert from "../../ui/MarkdownAlert.svelte";
  import type { VersionActions } from "./lib/version-actions.svelte";

  /**
   * The owner's yes before a version is made active, under the row that asked
   * for it: what runs from now, and that the app's data is not rewound.
   */
  interface Props {
    actions: VersionActions;
    /** The row that asked: only that row shows the question. */
    rowKey: string;
    target: number;
    live: number | null;
  }
  let { actions, rowKey, target, live }: Props = $props();

  const question = $derived(activationConfirmation(target, live));
</script>

{#if actions.confirming === rowKey}
  <!-- A warning callout band, not a tinted card: the question, then its two answers. -->
  <div role="group" aria-label={question.title} data-testid="app-activation-confirm">
    <MarkdownAlert alertType="warning">
      {#snippet content()}
        <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
          <div class="flex min-w-48 flex-1 flex-col gap-0.5">
            <span class="text-sm font-medium text-foreground">{question.title}</span>
            <span class="text-xs text-pretty text-(--solus-text-secondary)">{question.message}</span>
          </div>
          <div class="flex shrink-0 items-center gap-2">
            <Button size="xs" variant="ghost" onclick={() => actions.cancelActivation()}>Cancel</Button>
            <!-- svelte-ignore a11y_autofocus -->
            <Button size="xs" autofocus disabled={actions.isActivating} onclick={() => void actions.activate(target)} data-testid="app-activation-confirm-yes">
              {actions.isActivating ? "Switching…" : activationLabel(target, live)}
            </Button>
          </div>
        </div>
      {/snippet}
    </MarkdownAlert>
  </div>
{/if}
