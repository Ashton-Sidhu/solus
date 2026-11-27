<script lang="ts">
  /** The badge rows of a codebase's page (docs/plans/codebases.md §9,
   *  "Badge"): the icon (one or two letters, or one emoji) and the colour.
   *  The badge marks each session of the codebase in the sidebar and the
   *  breadcrumb. Each choice moves to every host with the record. */
  import { Check as CheckIcon } from "@lucide/svelte";
  import type { Codebase } from "@solus/contracts/codebases";
  import {
    CODEBASE_COLORS,
    codebaseIconText,
    codebaseMark,
    codebaseNameColor,
    parseCodebaseIcon,
    type CodebaseColor,
    type CodebaseIcon,
  } from "@solus/contracts/codebase-badge";
  import { projectInitials } from "@solus/contracts/project-badge";
  import { codebasesStore } from "../../contexts";
  import { CODEBASE_BADGE_STYLES } from "../../lib/codebase-badge-styles";
  import { toasts } from "../../lib/toasts";
  import { Input } from "../ui/input";
  import SettingsRow from "../settings/SettingsRow.svelte";
  import CodebaseBadge from "./CodebaseBadge.svelte";

  let { codebase }: { codebase: Codebase } = $props();

  /** The icon field while the person edits it. Null: the field shows the saved icon. */
  let iconDraft = $state<string | null>(null);
  const iconText = $derived(iconDraft ?? codebaseIconText(codebase.badge?.icon));
  const typedIcon = $derived(parseCodebaseIcon(iconText));
  const isIconInvalid = $derived(typedIcon === "invalid");
  // The preview follows the field as the person types.
  const previewMark = $derived(
    codebaseMark({ name: codebase.name, badge: { ...codebase.badge, icon: typedIcon === "invalid" || typedIcon === null ? undefined : typedIcon } }),
  );
  const chosenColor = $derived(codebase.badge?.color ?? null);
  const nameColor = $derived(codebaseNameColor(codebase.name));

  async function save(change: { color?: CodebaseColor | null; icon?: CodebaseIcon | null }, failure: string): Promise<boolean> {
    try {
      await codebasesStore.setBadge(codebase.id, change);
      return true;
    } catch (error) {
      toasts.error(error instanceof Error ? error.message : failure);
      return false;
    }
  }

  /** Saves the field. Text that is no icon stays in the field with its error. */
  async function saveIcon() {
    if (iconDraft === null || typedIcon === "invalid") return;
    if (await save({ icon: typedIcon }, "Could not change the icon.")) iconDraft = null;
  }

  function revertIconOnEscape(event: KeyboardEvent) {
    if (event.key !== "Escape" || iconDraft === null) return;
    // Escape undoes the edit first; a second Escape closes Settings.
    event.preventDefault();
    event.stopPropagation();
    iconDraft = null;
  }
</script>

<SettingsRow
  label="Icon"
  description="One or two letters, or one emoji. Leave it empty to use the initials of the name. Its sessions show this badge in the sidebar."
>
  {#snippet control()}
    <div class="flex flex-col items-end gap-1">
      <div class="flex items-center gap-2">
        <span class="inline-flex size-7 shrink-0"><CodebaseBadge mark={previewMark} /></span>
        <Input
          bind:value={() => iconText, (next) => (iconDraft = next)}
          class="h-8 w-24"
          aria-label="Codebase icon"
          aria-invalid={isIconInvalid}
          aria-describedby={isIconInvalid ? "codebase-icon-error" : undefined}
          placeholder={projectInitials(codebase.name)}
          maxlength={32}
          submitOn="enter"
          onSubmit={() => void saveIcon()}
          onblur={() => void saveIcon()}
          onkeydown={revertIconOnEscape}
        />
      </div>
      {#if isIconInvalid}
        <p id="codebase-icon-error" class="text-xs text-destructive" role="alert">Type one or two letters, or one emoji.</p>
      {/if}
    </div>
  {/snippet}
</SettingsRow>

<SettingsRow label="Colour" description="Automatic takes a colour from the name.">
  {#snippet body()}
    <div class="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label="Codebase colour">
      <button
        type="button"
        role="radio"
        aria-checked={chosenColor === null}
        class="flex h-7 cursor-pointer items-center gap-1.5 rounded-full border border-border px-2.5 text-xs text-foreground transition-colors hover:bg-[color-mix(in_oklch,var(--foreground)_6%,transparent)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring aria-checked:border-ring aria-checked:font-medium"
        onclick={() => void save({ color: null }, "Could not change the colour.")}
      >
        <span class="size-3 rounded-full {CODEBASE_BADGE_STYLES[nameColor].swatch}" aria-hidden="true"></span>
        Automatic
      </button>
      {#each CODEBASE_COLORS as color (color)}
        <button
          type="button"
          role="radio"
          aria-checked={chosenColor === color}
          aria-label={color}
          title={color}
          class="flex size-7 cursor-pointer items-center justify-center rounded-full text-white transition-transform hover:scale-110 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring motion-reduce:transition-none {CODEBASE_BADGE_STYLES[color].swatch}"
          onclick={() => void save({ color }, "Could not change the colour.")}
        >
          {#if chosenColor === color}<CheckIcon size={14} strokeWidth={3} />{/if}
        </button>
      {/each}
    </div>
  {/snippet}
</SettingsRow>
