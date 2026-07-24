<script lang="ts">
  import { ArrowCounterClockwiseIcon, KeyboardIcon, WarningCircleIcon } from "phosphor-svelte";
  import Kbd from "../ui/Kbd.svelte";
  import { Button } from "../ui/button";
  import { KEYBINDINGS, bindingsForScope, type BindingId } from "../../lib/keybindings/manifest";
  import {
    comboEquals,
    comboFromEvent,
    comboToAccelerator,
    defaultCombo,
    formatCombo,
  } from "../../lib/keybindings/match";
  import type { BindingDef, KeyCombo, Scope } from "../../lib/keybindings/types";
  import type { AppGlobalShortcuts, AppShortcutCombo } from "../../../shared/types";
  import { getSettingsContext, getWindowContext, toasts } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";

  interface Props {
    searchQuery?: string;
  }

  let { searchQuery = "" }: Props = $props();

  const settings = getSettingsContext();
  const windowCtx = getWindowContext();

  // Rail categories shown in the editor, in display order. A category maps to
  // one or more binding scopes — contextual scopes are grouped by area so the
  // rail isn't littered with one- or two-shortcut entries. The underlying
  // `scope` still governs when a binding fires; this is display grouping only.
  // (shortcuts-help is internal and intentionally omitted.)
  const RAIL_GROUPS: { key: string; label: string; scopes: Scope[] }[] = [
    { key: "global", label: "Global", scopes: ["global"] },
    { key: "diff-panel", label: "Diff Panel", scopes: ["diff-panel"] },
    { key: "galleries", label: "Galleries", scopes: ["plan-gallery", "folio-gallery", "attachment-preview"] },
    { key: "editors", label: "Editors", scopes: ["plan-modal", "document-modal"] },
    { key: "review", label: "Review & Annotate", scopes: ["plan-action-bar", "design-annotation"] },
    { key: "diagram", label: "Diagram", scopes: ["diagram"] },
  ];

  // Per-scope labels used as sub-headers inside merged categories and as the
  // section heading in search results.
  const SCOPE_LABELS: Record<string, string> = {
    global: "Global",
    "diff-panel": "Diff Panel",
    "plan-gallery": "Plan gallery",
    "folio-gallery": "Folio gallery",
    "attachment-preview": "Attachment preview",
    "plan-modal": "Plan modal",
    "document-modal": "Document modal",
    "plan-action-bar": "Plan review",
    "design-annotation": "Design annotation",
    diagram: "Diagram",
  };

  // Every scope in rail order — drives the cross-scope search view.
  const ALL_SCOPES: Scope[] = RAIL_GROUPS.flatMap((g) => g.scopes);

  // recordingId is a BindingId, or "app:primary" / "app:secondary" for the OS rows.
  let recordingId = $state<string | null>(null);
  let pendingConflict = $state<{ id: BindingId; combo: KeyCombo; otherLabel: string; otherId: BindingId } | null>(null);

  // ─── In-app bindings ───

  function effectiveCombo(id: BindingId): KeyCombo {
    return settings.keybindings[id] ?? defaultCombo(KEYBINDINGS[id]);
  }

  function isOverridden(id: BindingId): boolean {
    return id in settings.keybindings;
  }

  /** Find a binding in the same scope (or global) already using `combo`. */
  function findConflict(id: BindingId, combo: KeyCombo): { id: BindingId; label: string } | null {
    const def = KEYBINDINGS[id];
    for (const [cidRaw, cdef] of Object.entries(KEYBINDINGS)) {
      const cid = cidRaw as BindingId;
      if (cid === id) continue;
      if (cdef.scope !== def.scope && cdef.scope !== "global") continue;
      const resolved = settings.keybindings[cid] ?? defaultCombo(cdef);
      if (comboEquals(combo, resolved)) return { id: cid, label: cdef.label };
    }
    return null;
  }

  function commitBinding(id: BindingId, combo: KeyCombo, clearOtherId?: BindingId): void {
    const next: Record<string, KeyCombo> = { ...settings.keybindings };
    if (clearOtherId) delete next[clearOtherId];
    // Storing the default would be redundant — treat "set to default" as a reset.
    if (comboEquals(combo, defaultCombo(KEYBINDINGS[id]))) delete next[id];
    else next[id] = combo;
    settings.update({ keybindings: next });
  }

  function resetBinding(id: BindingId): void {
    if (!(id in settings.keybindings)) return;
    const next = { ...settings.keybindings };
    delete next[id];
    settings.update({ keybindings: next });
    requestInputFocus();
  }

  function resetAll(): void {
    settings.update({ keybindings: {} });
    requestInputFocus();
  }

  function startRecord(id: string): void {
    pendingConflict = null;
    recordingId = id;
  }

  function cancelRecord(): void {
    recordingId = null;
    requestInputFocus();
  }

  function applyConflictReassign(): void {
    if (!pendingConflict) return;
    const { id, combo, otherId } = pendingConflict;
    commitBinding(id, combo, otherId);
    pendingConflict = null;
    requestInputFocus();
  }

  function handleBindingCapture(id: BindingId, e: KeyboardEvent): void {
    if (e.code === "Escape") {
      cancelRecord();
      return;
    }
    const combo = comboFromEvent(e);
    if (!combo) return; // modifier-only — keep waiting
    recordingId = null;
    const conflict = findConflict(id, combo);
    if (conflict) {
      pendingConflict = { id, combo, otherLabel: conflict.label, otherId: conflict.id };
    } else {
      commitBinding(id, combo);
      requestInputFocus();
    }
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
    let alive = true;
    window.solus
      .getAppGlobalShortcuts()
      .then((s) => { if (alive) appShortcuts = s; })
      .catch(() => {});
    return () => { alive = false; };
  });

  async function commitAppShortcut(key: "primary" | "secondary", combo: AppShortcutCombo): Promise<void> {
    const next: AppGlobalShortcuts = { ...appShortcuts, [key]: combo };
    appShortcuts = next;
    try {
      // Snapshot before IPC: the spread keeps the untouched slot as a Svelte
      // $state proxy, which structured-clone can't serialize (silent reject).
      const result = await window.solus.setAppGlobalShortcuts($state.snapshot(next));
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
      toasts.error(
        `Couldn't apply the shortcut: ${error instanceof Error ? error.message : String(error)}`,
        { action: { label: "Restart", onAction: restart } },
      );
    }
  }

  function handleAppCapture(key: "primary" | "secondary", e: KeyboardEvent): void {
    if (e.code === "Escape") {
      cancelRecord();
      return;
    }
    const combo = comboFromEvent(e);
    if (!combo) return;
    recordingId = null;
    void commitAppShortcut(key, combo);
    requestInputFocus();
  }

  function restart(): void {
    window.solus.restartApp();
  }

  // Single capture-phase listener while recording so the press is consumed
  // before the global dispatcher (bubble phase) or the settings page see it.
  $effect(() => {
    if (!recordingId) return;
    const current = recordingId;
    const onKeydown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (current === "app:primary") handleAppCapture("primary", e);
      else if (current === "app:secondary") handleAppCapture("secondary", e);
      else handleBindingCapture(current as BindingId, e);
    };
    window.addEventListener("keydown", onKeydown, { capture: true });
    return () => window.removeEventListener("keydown", onKeydown, { capture: true });
  });

  // ─── Search filtering ───

  function matches(label: string, scopeLabel: string, group: string, combo: KeyCombo): boolean {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return (
      label.toLowerCase().includes(q) ||
      scopeLabel.toLowerCase().includes(q) ||
      group.toLowerCase().includes(q) ||
      formatCombo(combo).join("").toLowerCase().includes(q)
    );
  }

  // ─── Two-pane structure ───

  // The category currently selected in the left rail (a Scope, or "system").
  let selectedScope = $state<string>("global");

  // Left-rail entries: one per scope, plus System on desktop. Counts switch to
  // live match counts while searching so the rail doubles as a result map.
  const railItems = $derived.by(() => {
    const items = RAIL_GROUPS.map(({ key, label, scopes }) => {
      const all = scopes.flatMap((s) => bindingsForScope(s));
      const overrides = all.filter(([id]) => isOverridden(id)).length;
      const matchCount = searchQuery
        ? all.filter(([id, def]) => matches(def.label, SCOPE_LABELS[def.scope], def.group, effectiveCombo(id))).length
        : all.length;
      return { key, label, total: all.length, overrides, matchCount };
    });
    if (!windowCtx.isWeb) {
      items.push({ key: "system", label: "System", total: APP_ROWS.length, overrides: 0, matchCount: APP_ROWS.length });
    }
    return items;
  });

  // Selected category's bindings, split into sub-headers (in order). A
  // single-scope category splits by each binding's `group`; a merged category
  // uses one section per scope (its label) so areas stay visually distinct.
  const selectedGroups = $derived.by(() => {
    if (selectedScope === "system") return [];
    const railGroup = RAIL_GROUPS.find((g) => g.key === selectedScope);
    if (!railGroup) return [];

    if (railGroup.scopes.length > 1) {
      return railGroup.scopes
        .map((scope) => ({
          group: SCOPE_LABELS[scope],
          rows: bindingsForScope(scope).map(([id, def]) => ({ id, def })),
        }))
        .filter((s) => s.rows.length > 0);
    }

    const order: string[] = [];
    const map = new Map<string, Array<{ id: BindingId; def: BindingDef }>>();
    for (const [id, def] of bindingsForScope(railGroup.scopes[0])) {
      if (!map.has(def.group)) {
        map.set(def.group, []);
        order.push(def.group);
      }
      map.get(def.group)!.push({ id, def });
    }
    return order.map((group) => ({ group, rows: map.get(group)! }));
  });

  // While searching, the right pane shows matches across every scope at once.
  const searchSections = $derived.by(() => {
    if (!searchQuery) return [];
    return ALL_SCOPES.map((scope) => {
      const label = SCOPE_LABELS[scope];
      const rows = bindingsForScope(scope)
        .map(([id, def]) => ({ id, def }))
        .filter(({ id, def }) => matches(def.label, label, def.group, effectiveCombo(id)));
      return { scope, label, rows };
    }).filter((s) => s.rows.length > 0);
  });

  const hasSearchResults = $derived(searchSections.length > 0);
  const overrideCount = $derived(Object.keys(settings.keybindings).length);
  const anyOverride = $derived(overrideCount > 0);

  function selectScope(key: string): void {
    selectedScope = key;
    requestInputFocus();
  }
</script>

<!-- ── Snippets: one row renderer reused by the scope view and search view ── -->
{#snippet bindingRow(id: BindingId, def: BindingDef)}
  {@const combo = effectiveCombo(id)}
  {@const recording = recordingId === id}
  {@const conflict = pendingConflict?.id === id ? pendingConflict : null}
  {@const custom = isOverridden(id) && !recording && !conflict}
  <div
    class="flex items-center justify-between gap-4 min-h-[2.375rem] px-3 py-[0.3125rem] border-b border-b-(--solus-container-border)/45 last:border-b-0
      {recording ? 'bg-(--solus-accent)/5' : ''}"
  >
    <span class="text-[0.8125rem] text-(--solus-text-primary) min-w-0">{def.label}</span>
    <div class="flex items-center gap-1.5 shrink-0">
      {#if conflict}
        <span class="inline-flex items-center gap-1 text-[0.6875rem] text-(--solus-text-secondary)">
          <WarningCircleIcon size={13} class="text-(--solus-art-negative)" />
          Used by "{conflict.otherLabel}"
        </span>
        <Button
          variant="outline"
          size="xs"
          class="border-(--solus-accent) text-(--solus-accent) hover:bg-(--solus-accent)/12"
          onclick={applyConflictReassign}
        >
          Reassign
        </Button>
        <Button
          variant="outline"
          size="xs"
          onclick={() => {
            pendingConflict = null;
            requestInputFocus();
          }}
        >
          Cancel
        </Button>
      {:else if recording}
        <button type="button" class="inline-flex items-center gap-2 text-[0.75rem] text-(--solus-accent) py-1 px-2.5 rounded-md border border-dashed border-(--solus-accent) bg-(--solus-accent)/8" onclick={cancelRecord}>
          Press shortcut… <span class="text-[0.625rem] text-(--solus-text-tertiary)">Esc to cancel</span>
        </button>
      {:else}
        {#if custom}<span class="text-[0.625rem] font-semibold tracking-[0.01em] text-(--solus-accent) bg-(--solus-accent)/10 border border-(--solus-accent)/30 py-px px-1.5 rounded-full">Custom</span>{/if}
        <button
          type="button"
          class="inline-flex items-center gap-[0.1875rem] py-1 px-1.5 rounded-md border border-transparent [transition:border-color_var(--duration-base)_var(--ease-premium),background_var(--duration-base)_var(--ease-premium)] hover:bg-(--solus-surface-hover) hover:border-(--solus-container-border)
            {custom ? 'border-(--solus-accent)/35 bg-(--solus-accent)/8' : ''}"
          aria-label={`Rebind ${def.label}`}
          onclick={() => startRecord(id)}
        >
          {#each formatCombo(combo) as k}
            <Kbd variant="standalone" class={k === "⇧" ? "kbd-shift" : ""}>{k}</Kbd>
          {/each}
        </button>
        {#if isOverridden(id)}
          <Button
            variant="ghost"
            size="icon-xs"
            class="text-(--solus-text-tertiary)"
            aria-label={`Reset ${def.label} to default`}
            title="Reset to default"
            onclick={() => resetBinding(id)}
          >
            <ArrowCounterClockwiseIcon size={13} />
          </Button>
        {/if}
      {/if}
    </div>
  </div>
{/snippet}

{#snippet appBindingRow(key: "primary" | "secondary", label: string)}
  {@const combo = appShortcuts[key]}
  {@const recording = recordingId === `app:${key}`}
  {@const failed = appFailed[key]}
  <div class="flex items-center justify-between gap-4 min-h-[2.375rem] px-3 py-[0.3125rem] border-b border-b-(--solus-container-border)/45 last:border-b-0
    {recording ? 'bg-(--solus-accent)/5' : ''}">
    <span class="text-[0.8125rem] text-(--solus-text-primary) min-w-0">{label}</span>
    <div class="flex items-center gap-1.5 shrink-0">
      {#if recording}
        <button type="button" class="inline-flex items-center gap-2 text-[0.75rem] text-(--solus-accent) py-1 px-2.5 rounded-md border border-dashed border-(--solus-accent) bg-(--solus-accent)/8" onclick={cancelRecord}>
          Press shortcut… <span class="text-[0.625rem] text-(--solus-text-tertiary)">Esc to cancel</span>
        </button>
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
          class="inline-flex items-center gap-[0.1875rem] py-1 px-1.5 rounded-md border border-transparent [transition:border-color_var(--duration-base)_var(--ease-premium),background_var(--duration-base)_var(--ease-premium)] hover:bg-(--solus-surface-hover) hover:border-(--solus-container-border)"
          aria-label={`Rebind ${label}`}
          onclick={() => startRecord(`app:${key}`)}
        >
          {#each formatCombo(combo) as k}
            <Kbd variant="standalone" class={k === "⇧" ? "kbd-shift" : ""}>{k}</Kbd>
          {/each}
        </button>
      {/if}
    </div>
  </div>
{/snippet}

<div class="flex flex-col gap-1">
  <div class="flex items-center justify-between gap-4 py-1 pb-3">
    <div class="flex items-center gap-2">
      <KeyboardIcon size={15} class="text-(--solus-text-tertiary)" />
      <span class="text-[0.75rem] text-(--solus-text-tertiary)">Click a shortcut to rebind it. Saved on this device only.</span>
    </div>
    {#if anyOverride}
      <Button variant="ghost" size="xs" onclick={resetAll}>
        Reset all ({overrideCount})
      </Button>
    {/if}
  </div>

  {#if windowCtx.isWeb}
    <p class="flex items-center gap-1.5 flex-wrap text-[0.6875rem] text-(--solus-text-tertiary) pb-3">
      Some <Kbd variant="standalone">⌘</Kbd> combinations are reserved by your browser and can't be rebound to those keys.
    </p>
  {/if}

  <div class="flex gap-5 items-start mt-2">
    <nav class="w-[11.5rem] shrink-0 sticky top-0 flex flex-col gap-px" aria-label="Shortcut categories">
      {#each railItems as item (item.key)}
        <button
          type="button"
          class="relative flex items-center justify-between gap-2 w-full h-8 px-2.5 rounded-lg bg-transparent cursor-pointer text-left [transition:color_0.15s_ease,background_0.15s_ease,opacity_0.15s_ease] outline-none focus-visible:shadow-[inset_0_0_0_0.0938rem_var(--solus-accent)]
            {selectedScope === item.key && !searchQuery
              ? 'bg-(--solus-accent)/8 text-(--solus-text-primary) before:content-[\'\'] before:absolute before:-left-0.5 before:top-1/2 before:-translate-y-1/2 before:w-[0.1875rem] before:h-[1.0625rem] before:rounded-r-sm before:bg-(--solus-accent)'
              : searchQuery && item.matchCount === 0
                ? 'text-(--solus-text-secondary) opacity-40'
                : 'text-(--solus-text-secondary) [@media(hover:hover)]:hover:text-(--solus-text-primary) [@media(hover:hover)]:hover:bg-(--solus-surface-hover)'}"
          aria-current={selectedScope === item.key && !searchQuery ? "true" : undefined}
          onclick={() => selectScope(item.key)}
        >
          <span class="text-[0.8125rem] font-medium tracking-[-0.01em] min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{item.label}</span>
          <span class="inline-flex items-center gap-1.5 shrink-0">
            {#if item.overrides > 0}
              <span class="w-1.5 h-1.5 rounded-full bg-(--solus-accent)" title={`${item.overrides} customized`}></span>
            {/if}
            <span class="text-[0.6875rem] tabular-nums {selectedScope === item.key && !searchQuery ? 'text-(--solus-accent)' : 'text-(--solus-text-tertiary)'}">{searchQuery ? item.matchCount : item.total}</span>
          </span>
        </button>
      {/each}
    </nav>

    <div class="flex-1 min-w-0 flex flex-col gap-[1.125rem]">
      {#if searchQuery}
        {#if !hasSearchResults}
          <div class="py-8 text-center text-[0.8125rem] text-(--solus-text-tertiary)">No shortcuts match your search</div>
        {:else}
          {#each searchSections as section (section.scope)}
            <div class="flex flex-col gap-[0.4375rem]">
              <div class="text-[0.625rem] font-semibold uppercase tracking-[0.06em] text-(--solus-text-tertiary) opacity-80 px-0.5">{section.label}</div>
              <div class="border border-(--solus-art-border)/90 rounded-[0.625rem] bg-(--solus-art-surface) overflow-hidden">
                {#each section.rows as { id, def } (id)}
                  {@render bindingRow(id, def)}
                {/each}
              </div>
            </div>
          {/each}
        {/if}
      {:else if selectedScope === "system"}
        <div class="flex flex-col gap-[0.4375rem]">
          <p class="text-[0.6875rem] text-(--solus-text-tertiary) px-0.5 pb-0.5">Global shortcuts that summon Solus from anywhere on your computer.</p>
          <div class="border border-(--solus-art-border)/90 rounded-[0.625rem] bg-(--solus-art-surface) overflow-hidden">
            {#each APP_ROWS as appRow (appRow.key)}
              {@render appBindingRow(appRow.key, appRow.label)}
            {/each}
          </div>
        </div>
      {:else}
        {#each selectedGroups as g (g.group)}
          <div class="flex flex-col gap-[0.4375rem]">
            <div class="text-[0.625rem] font-semibold uppercase tracking-[0.06em] text-(--solus-text-tertiary) opacity-80 px-0.5">{g.group}</div>
            <div class="border border-(--solus-art-border)/90 rounded-[0.625rem] bg-(--solus-art-surface) overflow-hidden">
              {#each g.rows as { id, def } (id)}
                {@render bindingRow(id, def)}
              {/each}
            </div>
          </div>
        {/each}
      {/if}
    </div>
  </div>
</div>
