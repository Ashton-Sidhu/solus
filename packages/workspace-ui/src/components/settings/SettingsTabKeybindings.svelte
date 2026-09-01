<script lang="ts">
  import { RotateCcw as ArrowCounterClockwiseIcon, Keyboard as KeyboardIcon } from "@lucide/svelte";
  import Kbd from "../ui/Kbd.svelte";
  import { Button } from "../ui/button";
  import { KEYBINDINGS, bindingsForScope, type BindingId } from "../../lib/keybindings/manifest";
  import { comboToAccelerator, defaultCombo, formatCombo } from "../../lib/keybindings/match";
  import {
    ALL_LISTED_SCOPES,
    KEYBINDING_CATEGORIES,
    conflictLabels,
    effectiveCombo,
    groupsForScope,
    isOverridden,
    matchesQuery,
    scopeLabel,
    withBinding,
    withoutBinding,
  } from "../../lib/keybindings/editing";
  import { bindingCapture } from "../../lib/keybindings/capture.svelte";
  import type { BindingDef } from "../../lib/keybindings/types";
  import type { AppGlobalShortcuts, AppShortcutCombo } from "@solus/contracts/types";
  import { getSettingsContext, getWindowContext } from "../../contexts";
  import { toasts } from "../../lib/toasts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { serverConnections } from "@solus/client-core/server-connections";
  import SettingsSection from "./SettingsSection.svelte";

  interface Props {
    searchQuery?: string;
  }

  let { searchQuery = "" }: Props = $props();

  const settings = getSettingsContext();
  const windowCtx = getWindowContext();

  // ─── In-app bindings ───

  const conflicts = $derived(conflictLabels(settings.keybindings));

  function startBindingCapture(id: BindingId): void {
    bindingCapture.start(id, (combo) => {
      settings.update({ keybindings: withBinding(id, combo, settings.keybindings) });
      requestInputFocus();
    });
  }

  function resetBinding(id: BindingId): void {
    if (!isOverridden(id, settings.keybindings)) return;
    settings.update({ keybindings: withoutBinding(id, settings.keybindings) });
    requestInputFocus();
  }

  function resetAll(): void {
    bindingCapture.cancel();
    settings.update({ keybindings: {} });
    requestInputFocus();
  }

  function cancelCapture(): void {
    bindingCapture.cancel();
    requestInputFocus();
  }

  // ─── OS summon shortcuts (desktop-only) ───

  // Seed with the built-in defaults (mirrors main's DEFAULT_APP_SHORTCUTS) so the
  // section always renders on desktop; the live values from main overwrite these
  // once the RPC resolves. Without the seed a slow/failed fetch would hide the
  // whole section and the summon shortcut would look uneditable.
  const DEFAULT_APP_SHORTCUTS: AppGlobalShortcuts = {
    primary: { alt: true, code: "Space" },
    secondary: { mod: true, shift: true, code: "KeyK" },
  };

  let appShortcuts = $state<AppGlobalShortcuts>(DEFAULT_APP_SHORTCUTS);
  let appFailed = $state<{ primary: boolean; secondary: boolean }>({ primary: false, secondary: false });

  const APP_ROWS: { key: "primary" | "secondary"; label: string }[] = [
    { key: "primary", label: "Summon assistant (pill)" },
    { key: "secondary", label: "Show / hide editor" },
  ];

  $effect(() => {
    if (windowCtx.isWeb) return;
    // OS summon shortcuts belong to this machine's own app instance.
    let alive = true;
    serverConnections.localHostApi()
      ?.getAppGlobalShortcuts()
      .then((s) => { if (alive) appShortcuts = s; })
      .catch(() => {});
    return () => { alive = false; };
  });

  async function commitAppShortcut(key: "primary" | "secondary", combo: AppShortcutCombo): Promise<void> {
    // The OS shortcuts are this machine's; a web client has no local app to set.
    const localHostApi = serverConnections.localHostApi();
    if (!localHostApi) return;
    const next: AppGlobalShortcuts = { ...appShortcuts, [key]: combo };
    appShortcuts = next;
    try {
      // Snapshot before IPC: the spread keeps the untouched slot as a Svelte
      // $state proxy, which structured-clone can't serialize (silent reject).
      const result = await localHostApi.setAppGlobalShortcuts($state.snapshot(next));
      // The slot failed if its accelerator is in the returned failure list.
      const accel = comboToAccelerator(combo);
      const failed = !!accel && result.failed.includes(accel);
      appFailed = { ...appFailed, [key]: failed };
      if (failed) {
        toasts.show({
          message: "Couldn't apply the shortcut without a restart",
          variant: "error",
          action: { label: "Restart", onAction: restart },
        });
      }
    } catch (error) {
      appFailed = { ...appFailed, [key]: true };
      toasts.error("Couldn't apply the shortcut", {
        description: error instanceof Error ? error.message : String(error),
        action: { label: "Restart", onAction: restart },
      });
    }
  }

  function startAppCapture(key: "primary" | "secondary"): void {
    bindingCapture.start(`app:${key}`, (combo) => {
      void commitAppShortcut(key, combo);
      requestInputFocus();
    });
  }

  function restart(): void {
    void serverConnections.localHostApi()?.restartApp();
  }

  // ─── Two-pane structure ───

  // The category currently selected in the left rail (a category key, or "system").
  let selectedCategory = $state<string>(KEYBINDING_CATEGORIES[0].key);

  // Left-rail entries: one per category, plus System on desktop. Counts switch
  // to live match counts while searching so the rail doubles as a result map.
  const railItems = $derived.by(() => {
    const overrides = settings.keybindings;
    const items = KEYBINDING_CATEGORIES.map(({ key, label, scopes }) => {
      const all = scopes.flatMap((scope) => bindingsForScope(scope));
      const matchCount = searchQuery
        ? all.filter(([id, def]) => matchesQuery(def, effectiveCombo(id, overrides), searchQuery)).length
        : all.length;
      return { key, label, total: all.length, matchCount };
    });
    if (!windowCtx.isWeb) {
      items.push({ key: "system", label: "System", total: APP_ROWS.length, matchCount: APP_ROWS.length });
    }
    return items;
  });

  // Selected category's bindings, split into sub-headers (in order). A
  // single-scope category splits by each binding's `group`; a merged category
  // uses one section per scope (its label) so areas stay visually distinct.
  const selectedSections = $derived.by(() => {
    if (selectedCategory === "system") return [];
    const category = KEYBINDING_CATEGORIES.find((c) => c.key === selectedCategory);
    if (!category) return [];

    if (category.scopes.length > 1) {
      return category.scopes
        .map((scope) => ({
          key: scope as string,
          label: scopeLabel(scope),
          rows: bindingsForScope(scope).map(([id, def]) => ({ id, def })),
        }))
        .filter((section) => section.rows.length > 0);
    }

    return groupsForScope(category.scopes[0]).map((g) => ({ key: g.group, label: g.group, rows: g.rows }));
  });

  // While searching, the right pane shows matches across every scope at once.
  const searchSections = $derived.by(() => {
    if (!searchQuery) return [];
    const overrides = settings.keybindings;
    return ALL_LISTED_SCOPES
      .map((scope) => ({
        key: scope as string,
        label: scopeLabel(scope),
        rows: bindingsForScope(scope)
          .map(([id, def]) => ({ id, def }))
          .filter(({ id, def }) => matchesQuery(def, effectiveCombo(id, overrides), searchQuery)),
      }))
      .filter((section) => section.rows.length > 0);
  });

  const hasSearchResults = $derived(searchSections.length > 0);
  const overrideCount = $derived(Object.keys(settings.keybindings).length);
  const changedNote = $derived(
    overrideCount === 0
      ? "All shortcuts match the defaults on this device."
      : `${overrideCount} shortcut${overrideCount === 1 ? "" : "s"} differ${overrideCount === 1 ? "s" : ""} from the defaults on this device.`,
  );

  // A capture holds a window-level keydown listener that swallows every press,
  // so it must not outlive the surface that opened it.
  $effect(() => () => bindingCapture.cancel());

  function selectCategory(key: string): void {
    // Scope is a filter, never a mode: switching it cancels an in-flight
    // capture and changes nothing else.
    bindingCapture.cancel();
    selectedCategory = key;
    requestInputFocus();
  }
</script>

<!-- ── Snippets: one row renderer reused by the category view and search view ── -->
{#snippet captureChip()}
  <button
    type="button"
    class="kb-record inline-flex items-center gap-2 rounded-[0.625rem] bg-[color-mix(in_oklch,var(--primary)_13%,transparent)] px-2.5 py-1 font-mono text-micro font-medium tracking-[0.04em] text-[color:color-mix(in_oklch,var(--primary)_82%,var(--foreground))] shadow-[shadow:0_0_0_0.03125rem_color-mix(in_oklch,var(--primary)_45%,transparent)]"
    onclick={cancelCapture}
  >
    {bindingCapture.pendingText}
    <span class="kb-caret h-[0.6875rem] w-px bg-(--solus-accent)"></span>
  </button>
{/snippet}

{#snippet bindingRow(id: BindingId, def: BindingDef)}
  {@const combo = effectiveCombo(id, settings.keybindings)}
  {@const recording = bindingCapture.id === id}
  {@const conflict = conflicts.get(id)}
  {@const custom = isOverridden(id, settings.keybindings)}
  <div
    class="kb-row flex min-h-10 items-center justify-between gap-4 border-t border-border px-4 py-[0.3125rem] text-xs first:border-t-0 [.is-laptop-display_&]:min-h-[2.125rem]
 {recording ? 'bg-(--solus-accent)/8' : ''}"
  >
    <span class="min-w-0 truncate text-workspace-chrome font-medium tracking-[-0.005em] text-(--solus-text-primary)">{def.label}</span>
    <div class="flex shrink-0 items-center gap-1.5">
      {#if recording}
        {@render captureChip()}
      {:else}
        <!-- Conflicts are reported, not blocked: the last binding wins and both
             rows say so. -->
        {#if conflict}
          <span class="min-w-0 truncate text-[color:color-mix(in_oklch,var(--destructive)_62%,var(--foreground))]">conflicts with {conflict}</span>
        {/if}
        {#if custom}<span class="shrink-0 text-micro font-medium text-[color:color-mix(in_oklch,var(--primary)_82%,var(--foreground))]">changed</span>{/if}
        <button
          type="button"
          class="inline-flex items-center gap-1 rounded-md border border-transparent px-1.5 py-1 [transition:border-color_var(--duration-base)_var(--ease-premium),background_var(--duration-base)_var(--ease-premium)] hover:border-(--solus-container-border) hover:bg-(--solus-surface-hover)"
          aria-label={combo ? `Rebind ${def.label}` : `Assign a shortcut to ${def.label}`}
          onclick={() => startBindingCapture(id)}
        >
          {#if combo}
            {#each formatCombo(combo) as k}
              <Kbd variant="keycap">{k}</Kbd>
            {/each}
          {:else}
            <span class="px-0.5 text-muted-foreground">Unassigned</span>
          {/if}
        </button>
      {/if}
      <span class="flex size-6 shrink-0 items-center justify-center">
        {#if custom && !recording}
          {@const clears = defaultCombo(KEYBINDINGS[id]) === null}
          <Button
            variant="ghost"
            size="icon-xs"
            class="text-(--solus-text-tertiary)"
            aria-label={clears ? `Clear the shortcut for ${def.label}` : `Reset ${def.label} to default`}
            title={clears ? "Clear shortcut" : "Reset to default"}
            onclick={() => resetBinding(id)}
          >
            <ArrowCounterClockwiseIcon size={13} />
          </Button>
        {/if}
      </span>
    </div>
  </div>
{/snippet}

{#snippet appBindingRow(key: "primary" | "secondary", label: string)}
  {@const combo = appShortcuts[key]}
  {@const recording = bindingCapture.id === `app:${key}`}
  {@const failed = appFailed[key]}
  <div class="kb-row flex min-h-10 items-center justify-between gap-4 border-t border-border px-4 py-[0.3125rem] text-xs first:border-t-0 [.is-laptop-display_&]:min-h-[2.125rem]
 {recording ? 'bg-(--solus-accent)/8' : ''}">
    <span class="min-w-0 truncate text-workspace-chrome font-medium tracking-[-0.005em] text-(--solus-text-primary)">{label}</span>
    <div class="flex shrink-0 items-center gap-1.5">
      {#if recording}
        {@render captureChip()}
      {:else}
        {#if failed}
          <Button
            variant="outline"
            size="xs"
            class="border-(--solus-accent) text-(--solus-accent) hover:bg-(--solus-accent)/12"
            onclick={restart}
          >
            Restart
          </Button>
        {/if}
        <button
          type="button"
          class="inline-flex items-center gap-1 rounded-md border border-transparent px-1.5 py-1 [transition:border-color_var(--duration-base)_var(--ease-premium),background_var(--duration-base)_var(--ease-premium)] hover:border-(--solus-container-border) hover:bg-(--solus-surface-hover)"
          aria-label={`Rebind ${label}`}
          onclick={() => startAppCapture(key)}
        >
          {#each formatCombo(combo) as k}
            <Kbd variant="keycap">{k}</Kbd>
          {/each}
        </button>
      {/if}
    </div>
  </div>
{/snippet}

<div class="flex flex-col gap-1 text-xs">
  <div class="flex items-center justify-between gap-4 pb-3">
    <div class="flex items-center gap-2">
      <KeyboardIcon size={15} class="text-(--solus-text-tertiary)" />
      <span class="text-(--solus-text-tertiary)">Click a shortcut to rebind it.</span>
    </div>
    {#if overrideCount > 0}
      <Button variant="ghost" size="xs" onclick={resetAll}>Reset all</Button>
    {/if}
  </div>

  {#if windowCtx.isWeb}
    <p class="flex flex-wrap items-center gap-1.5 pb-3 text-(--solus-text-tertiary)">
      Some <Kbd variant="keycap">⌘</Kbd> combinations are reserved by your browser and can't be rebound to those keys.
    </p>
  {/if}

  <div class="flex items-start gap-5">
    <nav class="sticky top-0 flex w-[10.5rem] shrink-0 flex-col gap-px" aria-label="Shortcut categories">
      {#each railItems as item (item.key)}
        {@const active = selectedCategory === item.key && !searchQuery}
        <button
          type="button"
          class="flex h-8 w-full cursor-pointer items-center justify-between gap-2 overflow-hidden rounded-md border px-2.5 text-left outline-none [transition:color_0.15s_ease,background_0.15s_ease,border-color_0.15s_ease,opacity_0.15s_ease] focus-visible:shadow-[inset_0_0_0_0.0938rem_var(--solus-accent)]
 {active
 ? 'border-border bg-card text-foreground shadow-xs'
 : searchQuery && item.matchCount === 0
 ? 'border-transparent bg-transparent text-(--solus-text-secondary) opacity-40'
 : 'border-transparent bg-transparent text-(--solus-text-secondary) [@media(hover:hover)]:hover:bg-(--solus-text-primary)/5 [@media(hover:hover)]:hover:text-(--solus-text-primary)'}"
          aria-current={active ? "true" : undefined}
          onclick={() => selectCategory(item.key)}
        >
          <!-- One weight for every scope row: selection is carried by the fill,
               the ring and the accent count, never by a heavier label. -->
          <span class="min-w-0 truncate text-workspace-chrome font-medium tracking-[-0.005em]">{item.label}</span>
          <span class="shrink-0 font-mono text-micro tabular-nums {active ? 'text-(--solus-accent)' : 'text-(--solus-text-tertiary)'}">{searchQuery ? item.matchCount : item.total}</span>
        </button>
      {/each}

      <!-- Keybindings are device config: the desktop app claims global shortcuts
           the web client cannot, and a browser reserves combinations the desktop
           app is free to take. Syncing them would ship a shortcut that cannot
           fire, so they stay with the client that set them. -->
      <p class="px-2.5 pt-4 leading-relaxed text-(--solus-text-tertiary) text-pretty">
        {changedNote} Your other Solus clients keep their own.
      </p>
    </nav>

    <div class="flex min-w-0 flex-1 flex-col gap-[1.125rem] [.is-laptop-display_&]:gap-3.5">
      {#if searchQuery}
        {#if !hasSearchResults}
          <div class="py-8 text-center text-workspace-chrome text-(--solus-text-tertiary) [.is-laptop-display_&]:py-6">No shortcuts match your search</div>
        {:else}
          {#each searchSections as section (section.key)}
            <SettingsSection label={section.label}>
              {#each section.rows as { id, def } (id)}
                {@render bindingRow(id, def)}
              {/each}
            </SettingsSection>
          {/each}
        {/if}
      {:else if selectedCategory === "system"}
        <div class="flex flex-col gap-[0.4375rem]">
          <p class="px-0.5 pb-0.5 text-(--solus-text-tertiary)">Global shortcuts that summon Solus from anywhere on your computer.</p>
          <SettingsSection>
            {#each APP_ROWS as appRow (appRow.key)}
              {@render appBindingRow(appRow.key, appRow.label)}
            {/each}
          </SettingsSection>
        </div>
      {:else}
        {#each selectedSections as section (section.key)}
          <SettingsSection label={section.label}>
            {#each section.rows as { id, def } (id)}
              {@render bindingRow(id, def)}
            {/each}
          </SettingsSection>
        {/each}
      {/if}
    </div>
  </div>
</div>

<style>
  /* The capture caret is the only signal that the row is listening; it stops as
     soon as the combo commits or Escape cancels. */
  .kb-caret {
    animation: kb-caret-blink 1.1s step-end infinite;
  }

  @keyframes kb-caret-blink {
    50% { opacity: 0; }
  }

  @media (prefers-reduced-motion: reduce) {
    .kb-caret {
      animation: none;
    }
  }
</style>
