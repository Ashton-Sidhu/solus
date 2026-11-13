<script lang="ts">
  import { Ellipsis as MenuIcon, Play as StartIcon, Square as StopIcon, Trash2 as DeleteIcon } from "@lucide/svelte";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import { PAGE_ICON_BTN } from "../../lib/page-chrome";
  import { appMenuSections, problemsLabel, type AppMenuSection, type AppProblem } from "./lib/app-view";

  /**
   * The app menu (docs/plans/apps.md §9): the sections that open over the app,
   * then Stop or Start, then Delete.
   */
  interface Props {
    stopped: boolean;
    /** How many problems the app has. The Problems row is there while it has one. */
    problemCount: number;
    /** The dot on the button: a warning, an error, or none. */
    problemTone: AppProblem["tone"] | null;
    disabled: boolean;
    onOpenSection: (section: AppMenuSection) => void;
    onToggleStopped: () => void;
    onDelete: () => void;
  }
  let { stopped, problemCount, problemTone, disabled, onOpenSection, onToggleStopped, onDelete }: Props = $props();

  // A section takes the keyboard when it opens, so the menu must not give it back to its button.
  let opensSection = false;
  function openSection(section: AppMenuSection) {
    opensSection = true;
    onOpenSection(section);
  }
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger>
    {#snippet child({ props })}
      <button
        {...props}
        type="button"
        class={PAGE_ICON_BTN}
        aria-label={problemTone ? `App menu, ${problemsLabel(problemCount)}` : "App menu"}
        title={problemTone ? `App menu · ${problemsLabel(problemCount)}` : "App menu"}
        data-testid="app-menu"
      >
        <MenuIcon size={16} />
        {#if problemTone}
          <span
            class="absolute top-1 right-1 size-1.5 rounded-full {problemTone === 'error' ? 'bg-destructive' : 'bg-(--warning)'}"
            aria-hidden="true"
            data-testid="app-menu-dot"
            data-tone={problemTone}
          ></span>
        {/if}
      </button>
    {/snippet}
  </DropdownMenu.Trigger>
  <DropdownMenu.Content
    align="end"
    sideOffset={6}
    collisionPadding={8}
    class="w-auto min-w-48 max-w-[min(20rem,calc(100vw-2rem))] whitespace-nowrap"
    onCloseAutoFocus={(event) => {
      if (opensSection) event.preventDefault();
      opensSection = false;
    }}
  >
    {#each appMenuSections(problemCount) as section (section.id)}
      <DropdownMenu.Item class="text-workspace-chrome" data-testid={`app-menu-${section.id}`} onSelect={() => openSection(section.id)}>
        <span class="flex-1 text-left">{section.label}</span>
        {#if section.id === "problems"}
          <span class="text-xs tabular-nums text-muted-foreground">{problemCount}</span>
        {/if}
      </DropdownMenu.Item>
    {/each}
    <DropdownMenu.Separator />
    <DropdownMenu.Item class="text-workspace-chrome" {disabled} data-testid="app-menu-toggle-stopped" onSelect={onToggleStopped}>
      {#if stopped}
        <StartIcon size={14} /><span class="flex-1 text-left">Start</span>
      {:else}
        <StopIcon size={14} /><span class="flex-1 text-left">Stop</span>
      {/if}
    </DropdownMenu.Item>
    <DropdownMenu.Item class="text-workspace-chrome text-destructive" {disabled} data-testid="app-menu-delete" onSelect={onDelete}>
      <DeleteIcon size={14} /><span class="flex-1 text-left">Delete…</span>
    </DropdownMenu.Item>
  </DropdownMenu.Content>
</DropdownMenu.Root>
