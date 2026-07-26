<script lang="ts">
  /** One setting inside a `SettingsSection` card: label + description on the
   *  left, control on the right, with an optional full-width `body` below.
   *  The hairline is drawn with `first:border-t-0` rather than `last:border-b-0`
   *  so it stays correct when rows are conditionally hidden by search. */
  import type { Snippet } from "svelte";

  interface Props {
    label: string;
    description?: string;
    visible?: boolean;
    /** Inline badge rendered immediately after the label. */
    labelExtra?: Snippet;
    control?: Snippet;
    /** Full-width block below the label/control line. */
    body?: Snippet;
    /** Hook for e2e selectors that need to scope into a single row. */
    testId?: string;
  }

  let {
    label,
    description,
    visible = true,
    labelExtra,
    control,
    body,
    testId,
  }: Props = $props();
</script>

{#if visible}
  <div
    data-testid={testId}
    class="border-t border-border px-4 py-3.5 transition-colors first:border-t-0 [@media(hover:hover)]:hover:bg-muted"
  >
    <div class="flex items-center gap-6">
      <div class="min-w-0 flex-1">
        <div class="text-[0.8125rem] font-medium text-(--solus-text-primary)">
          {label}{@render labelExtra?.()}
        </div>
        {#if description}
          <div
            class="mt-0.5 text-pretty text-[0.75rem] text-muted-foreground"
          >
            {description}
          </div>
        {/if}
      </div>
      {#if control}
        <div class="shrink-0">{@render control()}</div>
      {/if}
    </div>
    {#if body}
      <div class="mt-3">{@render body()}</div>
    {/if}
  </div>
{/if}
