<script lang="ts">
  import { CircleAlert as ProblemIcon, Settings2 as ManageIcon } from "@lucide/svelte";
  import * as TooltipUI from "../ui/tooltip";
  import { comboHint } from "../../lib/keybindings/manifest";
  import { PAGE_SOFT_ICON_BTN } from "../../lib/page-chrome";
  import { manageToggleHint, problemsLabel, type AppProblem, type AppSurfaceView } from "./lib/app-view";

  /**
   * The Manage button of the app header (docs/plans/apps.md §9.1): a pill like
   * the other panes' header controls, pressed while the Manage page shows.
   * While the app has a problem, its icon is an alert: red for an error, amber
   * when the only problems are secrets that are not set.
   */
  interface Props {
    view: AppSurfaceView;
    problemCount: number;
    problemTone: AppProblem["tone"] | null;
    onSelect: (view: AppSurfaceView) => void;
  }
  let { view, problemCount, problemTone, onSelect }: Props = $props();

  const shortcut = comboHint("app-surface.toggle-manage");
  const isManage = $derived(view === "manage");
  const hint = $derived(manageToggleHint({ isManage, shortcut, problemCount: problemTone ? problemCount : 0 }));
</script>

<TooltipUI.Root>
  <TooltipUI.Trigger>
    {#snippet child({ props })}
      <button
        {...props}
        type="button"
        class="{PAGE_SOFT_ICON_BTN} text-workspace-chrome w-auto! gap-1.5 px-2.5 font-medium pointer-coarse:w-auto! {isManage ? 'bg-[var(--wash-3)]! text-foreground!' : ''}"
        aria-pressed={isManage}
        aria-label={problemTone ? `Manage, ${problemsLabel(problemCount)}` : "Manage"}
        onclick={() => onSelect(isManage ? "app" : "manage")}
        data-testid="app-manage-toggle"
        data-problem-tone={problemTone}
      >
        {#if problemTone}
          <ProblemIcon size={15} strokeWidth={1.75} class={problemTone === "error" ? "text-destructive" : "text-(--warning)"} aria-hidden="true" />
        {:else}
          <ManageIcon size={15} strokeWidth={1.5} aria-hidden="true" />
        {/if}
        Manage
      </button>
    {/snippet}
  </TooltipUI.Trigger>
  <TooltipUI.Content value={hint} />
</TooltipUI.Root>
