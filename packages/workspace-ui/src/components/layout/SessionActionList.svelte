<script lang="ts">
  import { Zap as ZapIcon } from "@lucide/svelte";
  import Kbd from "../ui/Kbd.svelte";
  import { filterSessionActions, type SessionAction } from "./lib/session-actions";

  let {
    actions,
    onClose,
  }: {
    actions: readonly SessionAction[];
    /** Called when the list should go away; the caller returns focus to the
     *  prompt, where the draft is still intact. */
    onClose: () => void;
  } = $props();

  let query = $state("");
  let activeIndex = $state(0);
  let rootEl: HTMLDivElement | null = $state(null);
  const listId = $props.id();

  const matches = $derived(filterSessionActions(actions, query));
  const activeAction = $derived(matches[activeIndex] ?? null);

  function run(action: SessionAction | null) {
    if (!action || action.isDisabled) return;
    onClose();
    action.run();
  }

  function moveActive(step: 1 | -1) {
    if (matches.length === 0) return;
    activeIndex = (activeIndex + step + matches.length) % matches.length;
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveActive(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveActive(-1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      run(activeAction);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  }

  // Leaving the list by pointer or Tab dismisses it, like any menu.
  function handleFocusOut(event: FocusEvent) {
    const next = event.relatedTarget;
    if (next instanceof Node && rootEl?.contains(next)) return;
    onClose();
  }
</script>

<div
  bind:this={rootEl}
  class="mx-auto w-full overflow-hidden rounded-2xl border border-(--solus-popover-border) bg-(--solus-popover-bg) text-workspace-chrome shadow-lg"
  onfocusout={handleFocusOut}
>
  <div class="flex items-center gap-2 border-b border-(--solus-container-border) px-3 py-2">
    <ZapIcon size={16} class="shrink-0 text-(--solus-text-tertiary)" />
    <!-- svelte-ignore a11y_autofocus -->
    <input
      bind:value={query}
      oninput={() => (activeIndex = 0)}
      onkeydown={handleKeydown}
      autofocus
      placeholder="Run a session action…"
      aria-label="Filter session actions"
      role="combobox"
      aria-expanded="true"
      aria-controls={listId}
      aria-activedescendant={activeAction ? `${listId}-${activeAction.id}` : undefined}
      class="min-w-0 flex-1 bg-transparent text-(--solus-text-primary) outline-none placeholder:text-(--solus-text-tertiary)"
    />
    <Kbd variant="inline" class="opacity-50">esc</Kbd>
  </div>
  <ul id={listId} role="listbox" aria-label="Session actions" class="m-0 grid list-none gap-px p-1.5">
    {#each matches as action, i (action.id)}
      <!-- The combobox input owns the keyboard (arrows, Enter, Esc); a click
           on an option is the pointer's way to the same choice. -->
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <li
        id="{listId}-{action.id}"
        role="option"
        aria-selected={i === activeIndex}
        aria-disabled={action.isDisabled}
        class="flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 {i === activeIndex
          ? 'bg-(--solus-surface-active) text-(--solus-text-primary)'
          : 'text-(--solus-text-secondary)'} aria-disabled:cursor-default aria-disabled:opacity-50"
        onpointermove={() => (activeIndex = i)}
        onpointerdown={(event) => event.preventDefault()}
        onclick={() => run(action)}
      >
        <action.icon size={16} />
        <span class="min-w-0 flex-1 truncate">{action.label}</span>
        {#if action.shortcut}
          <Kbd variant="inline" class="opacity-50">{action.shortcut}</Kbd>
        {/if}
      </li>
    {:else}
      <li class="px-2.5 py-1.5 text-(--solus-text-tertiary)">No matching action</li>
    {/each}
  </ul>
</div>
