<script lang="ts">
  import * as Tabs from "../ui/tabs";
  import { comboHint } from "../../lib/keybindings/manifest";
  import { problemsLabel, type AppProblem, type AppSurfaceView } from "./lib/app-view";

  /**
   * The switch between the app and its Manage page (docs/plans/apps.md §9.1).
   * Manage has a dot while the app has a problem: red for an error, amber when
   * the only problems are secrets that are not set.
   */
  interface Props {
    view: AppSurfaceView;
    /** False for an app with no UI: it has only its Manage page. */
    hasUi: boolean;
    problemCount: number;
    problemTone: AppProblem["tone"] | null;
    onSelect: (view: AppSurfaceView) => void;
  }
  let { view, hasUi, problemCount, problemTone, onSelect }: Props = $props();

  const shortcut = comboHint("app-surface.toggle-manage");
</script>

<Tabs.Root value={view} onValueChange={(next) => onSelect(next === "manage" ? "manage" : "app")} class="shrink-0" data-testid="app-view-switch">
  <Tabs.List class="h-7 pointer-coarse:h-9" aria-label="App or Manage">
    <Tabs.Trigger
      value="app"
      disabled={!hasUi}
      class="px-2.5 text-workspace-chrome"
      title={hasUi ? `The app (${shortcut})` : "This app has no UI"}
      data-testid="app-view-switch-app"
    >
      App
    </Tabs.Trigger>
    <Tabs.Trigger
      value="manage"
      class="px-2.5 text-workspace-chrome"
      title={problemTone ? `Manage (${shortcut}) · ${problemsLabel(problemCount)}` : `Manage (${shortcut})`}
      aria-label={problemTone ? `Manage, ${problemsLabel(problemCount)}` : "Manage"}
      data-testid="app-view-switch-manage"
    >
      Manage
      {#if problemTone}
        <span
          class="size-1.5 shrink-0 rounded-full {problemTone === 'error' ? 'bg-destructive' : 'bg-(--warning)'}"
          aria-hidden="true"
          data-testid="app-problem-dot"
          data-tone={problemTone}
        ></span>
      {/if}
    </Tabs.Trigger>
  </Tabs.List>
</Tabs.Root>
