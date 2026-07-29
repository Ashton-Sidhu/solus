<script lang="ts">
  import { CaretUpDownIcon } from "phosphor-svelte";
  import { Button } from "../ui/button";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import ProjectFavicon from "../ui/ProjectFavicon.svelte";
  import { displayProjectPath } from "./lib/pr-utils";

  // The inbox title: the project name is the page's primary scoping control,
  // so it renders title-sized as a real button with the switcher menu anchored
  // beneath it. PRs load per project, defaulting to the one being worked in;
  // switching pins the inbox to another repo. `compact` shrinks it for the
  // docked list pane.
  let {
    options,
    activePath,
    currentPath,
    compact = false,
    onSelect,
  }: {
    options: { path: string; name: string }[];
    activePath: string;
    currentPath: string;
    compact?: boolean;
    onSelect: (path: string) => void;
  } = $props();

  let menuOpen = $state(false);
  let triggerEl = $state<HTMLButtonElement | null>(null);

  const activeName = $derived(
    options.find((option) => option.path === activePath)?.name ??
      "Choose a project",
  );
</script>

<Button
  type="button"
  bind:ref={triggerEl}
  class="flex min-w-0 shrink-0 cursor-pointer items-center rounded-lg border-0 bg-muted font-medium text-foreground transition-colors duration-100 hover:bg-(--solus-surface-active) focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] {compact
    ? 'h-8 gap-1.5 px-2 text-[11.5px]'
    : 'h-8 gap-2 px-2.5 text-[12.5px]'}"
  aria-label="Project"
  aria-haspopup="menu"
  aria-expanded={menuOpen}
  onclick={() => (menuOpen = !menuOpen)}
>
  {#key activePath}
    <ProjectFavicon projectRoot={activePath} />
  {/key}
  <span class="min-w-0 truncate">{activeName}</span>
  <CaretUpDownIcon
    size={compact ? 10 : 12}
    class="shrink-0 text-muted-foreground"
  />
</Button>
<DropdownMenu.Root bind:open={menuOpen}>
  <DropdownMenu.Content
    customAnchor={triggerEl}
    side="bottom"
    align="start"
    sideOffset={6}
    class="w-[288px]"
  >
    <!-- A one-of-N pick, so it is a radio group rather than a list of plain
         items: the shared menu row then supplies the 32px metric, the 13px
         label, the weight bump on the chosen row, and the accent check in its
         reserved trailing slot — none of it restated here. The full path rides
         on the row's tooltip; project labels are already unique (they key the
         session sidebar's groups), so spending a second line on it would only
         break the row rhythm. -->
    <DropdownMenu.RadioGroup
      value={activePath}
      onValueChange={(path) => {
        menuOpen = false;
        onSelect(path);
      }}
    >
      {#each options as option (option.path)}
        <DropdownMenu.RadioItem
          value={option.path}
          title={displayProjectPath(option.path)}
        >
          <ProjectFavicon projectRoot={option.path} />
          <span class="min-w-0 flex-1 truncate">{option.name}</span>
          <!-- The check says "the inbox is showing this"; this says "and it is
               the project you are working in" — two different facts, so it
               stays quiet meta text rather than a second tinted marker. -->
          {#if option.path === currentPath}
            <span class="text-menu-meta shrink-0 text-(--solus-text-tertiary)">
              Current
            </span>
          {/if}
        </DropdownMenu.RadioItem>
      {/each}
    </DropdownMenu.RadioGroup>
  </DropdownMenu.Content>
</DropdownMenu.Root>
