<script lang="ts">
  import { tick } from "svelte";
  import { MagnifyingGlassIcon, WarningCircleIcon } from "phosphor-svelte";
  import Icon from "@iconify/svelte";
  import type { FileMatch } from "../../../shared/types";
  import { getWorkspaceContext, getSessionEnvironmentStore } from "../../contexts";
  import { fileTypeIcon } from "../../lib/fileTypeIcon";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { cn } from "../../lib/utils";
  import { useScope, useKeybinding } from "../../lib/keybindings/use-keybinding.svelte";
  import { ensureIconCollections } from "../diagram/iconify";
  import Kbd from "../ui/Kbd.svelte";
  import { fuzzyIndices, highlightSegments, splitFilePath } from "./lib/file-picker";

  interface Props {
    open: boolean;
    /** The chat whose environment scopes the search — its worktree when the
     *  session runs in one, the project root otherwise. */
    tabId: string | null;
  }

  let { open = $bindable(), tabId }: Props = $props();

  const session = getWorkspaceContext();
  const environmentStore = getSessionEnvironmentStore();

  ensureIconCollections();

  const DEBOUNCE_MS = 90;

  let query = $state("");
  let selectedIndex = $state(0);
  let files = $state<FileMatch[]>([]);
  let loadError = $state<string | null>(null);
  let isPending = $state(false);

  let searchEl: HTMLInputElement | null = $state(null);
  let listEl: HTMLDivElement | null = $state(null);

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let searchGeneration = 0;

  const targetTabId = $derived(tabId ?? session.focusedChatTabId ?? session.activeTabId);
  const environment = $derived(environmentStore.environmentFor(session.sessionFor(targetTabId)?.run));
  const searchCwd = $derived(environment.cwd);
  const scopeName = $derived(
    environment.isolated ? environment.name : (searchCwd?.split("/").pop() ?? "project"),
  );

  useScope("go-to-file", { exclusive: true, active: () => open });
  useKeybinding("go-to-file.close", () => close());

  function close() {
    open = false;
    requestInputFocus();
  }

  async function runSearch(text: string, cwd: string) {
    const generation = ++searchGeneration;
    isPending = true;
    let result: { files: FileMatch[] };
    try {
      result = await session.apiFor(targetTabId).searchFiles(text, cwd, session.ctxFor(targetTabId));
    } catch (error) {
      if (generation !== searchGeneration) return;
      files = [];
      loadError = error instanceof Error ? error.message : "File search failed.";
      isPending = false;
      return;
    }
    if (generation !== searchGeneration) return;
    // Directories are ranked first by the shared file handler because the
    // composer's `@` menu navigates into them. This picker only opens files.
    files = result.files.filter((file) => !file.isDir);
    loadError = null;
    selectedIndex = 0;
    isPending = false;
  }

  $effect(() => {
    const text = query;
    const cwd = searchCwd;
    if (debounceTimer) clearTimeout(debounceTimer);
    if (!open || !cwd) {
      searchGeneration += 1;
      isPending = false;
      return;
    }
    debounceTimer = setTimeout(() => void runSearch(text, cwd), DEBOUNCE_MS);
    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
    };
  });

  $effect(() => {
    if (!open) return;
    void tick().then(() => searchEl?.select());
  });

  $effect(() => {
    const index = selectedIndex;
    void tick().then(() => {
      listEl
        ?.querySelector<HTMLElement>(`[data-file-index="${index}"]`)
        ?.scrollIntoView({ block: "nearest" });
    });
  });

  function openFile(file: FileMatch) {
    open = false;
    session.openFilePreview({ path: file.path }, targetTabId);
  }

  function onSearchKeydown(e: KeyboardEvent) {
    if (e.key === "ArrowDown" && files.length > 0) {
      e.preventDefault();
      selectedIndex = (selectedIndex + 1) % files.length;
    } else if (e.key === "ArrowUp" && files.length > 0) {
      e.preventDefault();
      selectedIndex = (selectedIndex - 1 + files.length) % files.length;
    } else if (e.key === "Enter") {
      e.preventDefault();
      const file = files[selectedIndex];
      if (file) openFile(file);
    }
  }
</script>

{#snippet highlighted(text: string, indices: number[] | null, matchClass: string)}
  {#each highlightSegments(text, indices) as segment, i (i)}
    {#if segment.isMatch}<span class={matchClass}>{segment.text}</span>{:else}{segment.text}{/if}
  {/each}
{/snippet}

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
  data-solus-ui
  class="fixed inset-0 z-[10020] flex items-start justify-center pt-[12vh] pointer-events-auto bg-[color-mix(in_srgb,var(--solus-modal-scrim)_55%,transparent)] motion-safe:animate-[backdrop-fade_140ms_ease-out]"
  class:hidden={!open}
  aria-hidden={!open}
  inert={!open}
  role="presentation"
  onclick={(e) => {
    if (e.target === e.currentTarget) close();
  }}
>
  <div
    class="flex max-h-[min(30rem,66vh)] w-[clamp(22rem,56vw,38.75rem)] max-w-[calc(100vw-3rem)] origin-top flex-col overflow-hidden rounded-2xl border-[0.0625rem] border-(--solus-popover-border) bg-(--solus-popover-bg) outline-none shadow-[shadow:var(--solus-popover-shadow),inset_0_0.0625rem_0_rgba(255,255,255,0.14),0_1.75rem_3.125rem_-1.125rem_rgba(0,0,0,0.24)] [.dark_&]:shadow-[shadow:var(--solus-popover-shadow),inset_0_0.0625rem_0_rgba(255,255,255,0.06),0_1.75rem_3.125rem_-1.125rem_rgba(0,0,0,0.45)]"
    class:file-picker-enter={open}
    role="dialog"
    aria-label="Go to file"
    aria-modal="true"
  >
    <div class="flex h-[3.3125rem] shrink-0 items-center gap-3 border-b border-(--solus-menu-hairline) px-5">
      <MagnifyingGlassIcon size={16} class="shrink-0 text-(--solus-text-tertiary) opacity-65" />
      <input
        bind:this={searchEl}
        bind:value={query}
        onkeydown={onSearchKeydown}
        type="search"
        name="go-to-file"
        aria-label={`Go to a file in ${scopeName}`}
        placeholder={`Go to file in ${scopeName}…`}
        class="h-auto min-w-0 flex-1 border-none bg-transparent text-[length:calc(0.96875rem*var(--solus-font-scale,1))] tracking-[-0.012em] text-(--solus-text-primary) caret-(--solus-accent) outline-none placeholder:text-(--solus-text-tertiary) [&::-webkit-search-cancel-button]:hidden"
        autocomplete="off"
        spellcheck="false"
      />
    </div>

    {#if files.length === 0}
      <div
        class="flex flex-1 flex-col items-center justify-center gap-2.5 px-6 py-11 text-center text-[length:calc(0.8125rem*var(--solus-font-scale,1))] text-(--solus-text-tertiary)"
        role="status"
      >
        {#if loadError}
          <WarningCircleIcon size={16} weight="fill" class="text-(--solus-status-error)" />
          <span class="text-(--solus-status-error)">{loadError}</span>
        {:else}
          <MagnifyingGlassIcon size={18} weight="light" />
          <span>{isPending ? "Searching…" : "No files match"}</span>
        {/if}
      </div>
    {:else}
      <div
        bind:this={listEl}
        class="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-y-contain p-2"
        role="listbox"
        aria-label="Files"
      >
        {#each files as file, index (file.path)}
          {@const parts = splitFilePath(file.display)}
          {@const icon = fileTypeIcon(file.path)}
          {@const selected = index === selectedIndex}
          <button
            type="button"
            role="option"
            aria-selected={selected}
            data-file-index={index}
            class={cn(
              "flex h-[2.25rem] w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-lg border-none bg-transparent px-3 text-left transition-colors duration-75",
              selected
                ? "text-(--solus-text-primary) shadow-[shadow:inset_0_0_0_62rem_var(--solus-accent-light)]"
                : "text-(--solus-text-secondary) hover:bg-(--solus-surface-hover)",
            )}
            onpointermove={() => (selectedIndex = index)}
            onclick={() => openFile(file)}
          >
            {#if icon}
              <Icon {icon} width="14" height="14" class="shrink-0" />
            {/if}
            <span class="shrink-0 text-[length:calc(0.8125rem*var(--solus-font-scale,1))]">
              {@render highlighted(
                parts.name,
                fuzzyIndices(parts.name, query),
                "font-semibold text-(--solus-text-primary)",
              )}
            </span>
            <span
              class="min-w-0 truncate text-[length:calc(0.71875rem*var(--solus-font-scale,1))] text-(--solus-text-tertiary)"
              title={file.display}
            >
              {@render highlighted(
                parts.directory,
                fuzzyIndices(parts.directory, query),
                "text-(--solus-text-secondary)",
              )}
            </span>
          </button>
        {/each}
      </div>
    {/if}

    <div
      class="flex h-10 shrink-0 items-center gap-5 border-t border-(--solus-menu-hairline) bg-(--solus-menu-footer-bg) px-4 text-[length:calc(0.71875rem*var(--solus-font-scale,1))] text-(--solus-text-tertiary)"
    >
      <span class="inline-flex items-center gap-1.5">
        <Kbd variant="keycap">↑</Kbd>
        <Kbd variant="keycap">↓</Kbd>
        navigate
      </span>
      <span class="inline-flex items-center gap-1.5">
        <Kbd variant="keycap">↵</Kbd>
        open file
      </span>
      <span class="inline-flex items-center gap-1.5">
        <Kbd variant="keycap">esc</Kbd>
        close
      </span>
      <span class="ml-auto truncate" title={searchCwd}>{scopeName}</span>
    </div>
  </div>
</div>

<style>
  /* Keyframes can't be expressed as Tailwind utilities; referenced via the
     class on the panel above. */
  .file-picker-enter {
    animation: file-picker-enter 180ms cubic-bezier(0.22, 1, 0.36, 1) both;
  }

  @keyframes file-picker-enter {
    from {
      opacity: 0;
      transform: translate3d(0, 0.25rem, 0) scale(0.985);
    }
    to {
      opacity: 1;
      transform: translate3d(0, 0, 0) scale(1);
    }
  }
</style>
