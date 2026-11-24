<script lang="ts">
  import { comboHint } from "../../../lib/keybindings/manifest";
  import Kbd from "../../ui/Kbd.svelte";

  /**
   * The search's keys, at the foot of its list: what the keyboard does here,
   * so no control needs a tooltip to say it. What ⏎ does is here only for a
   * row whose preview has no action bar: where there is a bar, its button
   * says it. Esc is not here: the close button is in view, and the line has
   * no room to spare in a narrow window. The hints are siblings of the
   * list's total, so they have no element of their own around them. A hand on
   * glass has no keys to name, so each hint is absent for a coarse pointer.
   * The one exception is a pull request's browser hint: it is a button too, so
   * a touch keeps it, without its key.
   */
  interface Props {
    /** The row has a menu of its own actions. */
    hasRowActions: boolean;
    /** There is a project to choose. */
    hasProjects: boolean;
    /** What ⏎ does to the row the cursor is on. Empty when the preview's
     *  action bar says it, and with no row. */
    openLabel: string;
    /** The row is a pull request: open it in the browser. */
    onOpenInBrowser?: () => void;
  }
  let { hasRowActions, hasProjects, openLabel, onOpenInBrowser }: Props = $props();
</script>

{#snippet hint(label: string, keys: string[])}
  <span class="flex shrink-0 items-center gap-1.5 whitespace-nowrap pointer-coarse:hidden" data-testid="picker-key-hint">
    <span>{label}</span>
    {#each keys as key (key)}
      <Kbd variant="keycap">{key}</Kbd>
    {/each}
  </span>
{/snippet}

{@render hint("Change type", ["←", "→"])}
{@render hint("Options", [comboHint("task-picker.search-options")])}
{#if hasProjects}
  {@render hint("Project", [comboHint("task-picker.choose-project")])}
{/if}
{#if hasRowActions}
  {@render hint("Actions", [comboHint("task-picker.row-actions")])}
{/if}
{#if openLabel}
  {@render hint(openLabel, ["↵"])}
{/if}
{#if onOpenInBrowser}
  <button
    type="button"
    class="-mx-1.5 flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-0.5 whitespace-nowrap transition-colors duration-100 hover:bg-[var(--wash-1)] hover:text-foreground"
    onclick={onOpenInBrowser}
    data-testid="picker-key-hint"
  >
    <span>Open in browser</span>
    <span class="contents pointer-coarse:hidden"><Kbd variant="keycap">{comboHint("task-picker.open-in-browser")}</Kbd></span>
  </button>
{/if}
