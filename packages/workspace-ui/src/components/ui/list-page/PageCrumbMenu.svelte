<script lang="ts">
  import {
    ChevronDown as CaretDownIcon,
    Check as CheckIcon,
  } from "@lucide/svelte";
  import { getWorkspaceContext } from "../../../contexts";
  import { comboHint } from "../../../lib/keybindings/manifest";
  import { NAV_PAGES, navPageSpec, openNavPage, type NavPage } from "../../../lib/page-nav";

  /**
   * The breadcrumb's second segment: the page you are on, and a menu of the
   * pages beside it.
   *
   * If the crumb reads `project / page`, a separate page switch would be a
   * second control answering the same question. Folding it into the crumb keeps
   * one answer to "where am I", and it grows by one row when a sixth page
   * arrives rather than by another control.
   */
  interface Props {
    page: NavPage;
    /** Overrides the page's own name, for a surface that renders one page under
     *  two titles. Does not change which row the menu marks as current. */
    label?: string;
    /** Lets a shared crumb line keep adjacent menus mutually exclusive. */
    menuOpen?: boolean;
    onOpenMenu?: () => void;
    /** Keeps the page label as a title when this narrow surface is already a
     *  navigation rail for an open record. */
    switchable?: boolean;
  }
  let {
    page,
    label,
    menuOpen = $bindable(false),
    onOpenMenu,
    switchable = true,
  }: Props = $props();

  const session = getWorkspaceContext();
  const spec = $derived(navPageSpec(page));

  function toggle() {
    const opening = !menuOpen;
    if (opening) onOpenMenu?.();
    menuOpen = opening;
  }

  function pick(next: NavPage) {
    menuOpen = false;
    if (next !== page) openNavPage(session, next);
  }

  // Esc backs out of the menu before the page's own Esc handler gets a turn, so
  // the first press never closes the page underneath an open crumb menu. The
  // page dispatcher listens on document while bubbling; this has to win.
  $effect(() => {
    if (!menuOpen) return;
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      menuOpen = false;
    };
    document.addEventListener("keydown", onKeydown, true);
    return () => document.removeEventListener("keydown", onKeydown, true);
  });
</script>

{#if !switchable}
  <h1 class="truncate px-2.5 font-semibold tracking-[-0.013em]">
    {label ?? spec.label}
  </h1>
{:else}
<div class="relative min-w-0 shrink-0 @max-[30rem]/pane:flex-1">
  <!-- The scrim closes the menu on the next click anywhere, so the trigger has
       no dismissal logic of its own. -->
  {#if menuOpen}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="fixed inset-0 z-30" onclick={() => (menuOpen = false)}></div>
  {/if}

  <button
    type="button"
    class="relative z-40 flex h-[31px] max-w-full cursor-pointer items-center gap-2 overflow-hidden rounded-[9px] border-0 px-2.5 transition-colors duration-150 hover:bg-[var(--wash-2)] pointer-coarse:h-9 pointer-fine:[.is-laptop-display_&]:h-[27px] [.is-laptop-display_&]:px-2 @max-[30rem]/pane:h-11! @max-[30rem]/pane:px-1.5 {menuOpen
      ? 'bg-[var(--wash-2)]'
      : 'bg-transparent'}"
    title="Switch page"
    aria-haspopup="menu"
    aria-expanded={menuOpen}
    data-testid="page-crumb"
    onclick={toggle}
  >
    <!-- On a record the page name is no longer the second half of a crumb — the
         project has moved to a chip at the far end, so this is the page's own
         title and takes the title rung. -->
    <span
      class="truncate font-semibold tracking-[-0.013em] @max-[30rem]/pane:text-[17px] @max-[30rem]/pane:tracking-[-0.014em]"
      >{label ?? spec.label}</span
    >
    <CaretDownIcon
      size={12}
      class="shrink-0 text-muted-foreground opacity-50 transition-transform duration-200 [.is-laptop-display_&]:size-[11px] {menuOpen
        ? 'rotate-180'
        : ''}"
    />
  </button>

  {#if menuOpen}
    <!-- Crumb menus align to their own left edge, not the surface's. -->
    <div
      class="menu-surface absolute top-full left-0 z-40 mt-[5px] w-[232px] p-[5px] text-workspace-chrome"
      role="menu"
      tabindex="-1"
    >
      {#each NAV_PAGES as option (option.id)}
        {@const Icon = option.icon}
        {@const isActive = option.id === page}
        <button
          type="button"
          class="flex h-[34px] w-full cursor-pointer items-center gap-[9px] rounded-lg border-0 px-[9px] text-left transition-colors duration-150 hover:bg-[var(--wash-2)] [.is-laptop-display_&]:h-[30px] {isActive
            ? 'bg-[var(--wash-2)]'
            : 'bg-transparent'}"
          onclick={() => pick(option.id)}
        >
          <Icon size={14} class="shrink-0 text-muted-foreground" />
          <span class="min-w-0 flex-1 truncate {isActive ? 'font-medium' : ''}"
            >{option.label}</span
          >
          {#if option.shortcut && !isActive}
            <span class="shrink-0 text-xs text-muted-foreground opacity-60"
              >{comboHint(option.shortcut)}</span
            >
          {/if}
          <span class="flex w-3 shrink-0 justify-end">
            {#if isActive}
              <CheckIcon size={14} class="text-primary" />
            {/if}
          </span>
        </button>
      {/each}
    </div>
  {/if}
</div>
{/if}
