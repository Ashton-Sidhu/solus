<script lang="ts">
  import { GitPullRequestIcon } from "../ui/octicons";
  import { prStatusBadge, REQUIRED_CHECKS_FAILING_BADGE } from "../prs/lib/pr-utils";
  import { prMenuTitle } from "./lib/pr-menu";
  import type { PrChoice } from "./lib/sidebar-rows";

  let { choice }: { choice: PrChoice } = $props();
  const badge = $derived(
    choice.requiredChecksFail ? REQUIRED_CHECKS_FAILING_BADGE : prStatusBadge(choice.pullRequest),
  );
  const StateIcon = $derived(badge?.Icon ?? GitPullRequestIcon);
</script>

<!-- One line per pull request keeps a list of several short. The icon's color
     carries the state; screen readers get it as text. -->
<span class="flex size-4 shrink-0 items-center justify-center" style:color={badge?.tone ?? "var(--muted-foreground)"} aria-hidden="true">
  <StateIcon size={14} />
</span>
<span class="min-w-0 flex-1 truncate text-foreground">{prMenuTitle(choice)}</span>
{#if badge}
  <span class="sr-only">{badge.label}</span>
{/if}
<span class="shrink-0 tabular-nums text-muted-foreground">#{choice.number}</span>
