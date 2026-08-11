<script lang="ts">
  import { tick, untrack } from "svelte";
  import { MagnifyingGlassIcon, WarningCircleIcon } from "phosphor-svelte";
  import Icon from "@iconify/svelte";
  import type {
    ProjectContentMatch,
    ProjectContentSearchRequest,
  } from "../../../shared/types";
  import { getWorkspaceContext, getSessionEnvironmentStore } from "../../contexts";
  import { fileTypeIcon } from "../../lib/fileTypeIcon";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { cn } from "../../lib/utils";
  import { useScope, useKeybinding } from "../../lib/keybindings/use-keybinding.svelte";
  import { comboHint } from "../../lib/keybindings/manifest";
  import { ensureIconCollections } from "../diagram/iconify";
  import Kbd from "../ui/Kbd.svelte";
  import {
    distinctFileCount,
    groupMatches,
    lineSegments,
    segmentStyle,
    visibleLine,
  } from "./lib/project-search";
  import { languageForPath, lineHighlighter } from "./lib/line-highlighter.svelte";

  interface Props {
    open: boolean;
    isDark: boolean;
    /** The chat whose environment scopes the search — its worktree when the
     *  session runs in one, the project root otherwise. */
    tabId: string | null;
  }

  let { open = $bindable(), isDark, tabId }: Props = $props();

  const session = getWorkspaceContext();
  const environmentStore = getSessionEnvironmentStore();

  ensureIconCollections();

  // Rows are cheap individually but 500 of them janks the first paint, so the
  // list grows as the sentinel at the bottom scrolls into view.
  const RESULT_WINDOW = 100;
  const DEBOUNCE_MS = 160;

  let query = $state("");
  let caseSensitive = $state(false);
  let wholeWord = $state(false);
  let useRegex = $state(false);
  let selectedIndex = $state(0);
  let visibleCount = $state(RESULT_WINDOW);

  let matches = $state<ProjectContentMatch[]>([]);
  let truncated = $state(false);
  let regexError = $state<string | null>(null);
  let searchError = $state<string | null>(null);
  let isPending = $state(false);

  let searchEl: HTMLInputElement | null = $state(null);
  let listEl: HTMLDivElement | null = $state(null);
  let sentinelEl: HTMLDivElement | null = $state(null);

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let searchGeneration = 0;

  const targetTabId = $derived(tabId ?? session.focusedChatTabId ?? session.activeTabId);
  const environment = $derived(environmentStore.environmentFor(session.sessionFor(targetTabId)?.run));
  // Narrowed to the string the search actually keys on: the environment object
  // is rebuilt whenever git status refreshes, which would otherwise re-run the
  // search mid-agent-turn for no reason.
  const searchCwd = $derived(environment.cwd);
  const scopeName = $derived(
    environment.isolated ? environment.name : (environment.cwd?.split("/").pop() ?? "project"),
  );
  const theme = $derived(lineHighlighter.themeFor(isDark));
  const hasQuery = $derived(query.trim().length > 0);
  const visibleMatches = $derived(matches.slice(0, visibleCount));
  const groups = $derived(groupMatches(visibleMatches));
  const fileCount = $derived(distinctFileCount(matches));
  // While a newer query is still in flight the rows on screen belong to the
  // previous one, so opening a result would jump somewhere unasked for.
  const canOpen = $derived(!isPending);

  useScope("project-search", { exclusive: true, active: () => open });
  useKeybinding("project-search.close", () => close());
  useKeybinding("project-search.match-case", () => { caseSensitive = !caseSensitive; });
  useKeybinding("project-search.whole-word", () => { wholeWord = !wholeWord; });
  useKeybinding("project-search.regex", () => { useRegex = !useRegex; });

  function close() {
    open = false;
    requestInputFocus();
  }

  function reset() {
    matches = [];
    truncated = false;
    regexError = null;
    searchError = null;
    selectedIndex = 0;
    visibleCount = RESULT_WINDOW;
  }

  async function runSearch(request: ProjectContentSearchRequest) {
    const generation = ++searchGeneration;
    isPending = true;
    const result = await session
      .apiFor(targetTabId)
      .searchProjectContents(session.ctxFor(targetTabId), request);
    if (generation !== searchGeneration) return;

    if (result.ok) {
      matches = result.matches;
      truncated = result.truncated;
      regexError = result.regexError ?? null;
      searchError = null;
    } else {
      matches = [];
      truncated = false;
      regexError = null;
      searchError = result.error;
    }
    selectedIndex = 0;
    visibleCount = RESULT_WINDOW;
    isPending = false;
  }

  // Debounced search. Whitespace is significant in a content query, so only the
  // blank check trims — the query itself goes to the engine verbatim.
  $effect(() => {
    const request: ProjectContentSearchRequest = {
      query,
      cwd: searchCwd,
      caseSensitive,
      wholeWord,
      useRegex,
    };
    const shouldSearch = open && request.query.trim().length > 0;

    if (debounceTimer) clearTimeout(debounceTimer);
    if (!shouldSearch) {
      searchGeneration += 1;
      isPending = false;
      untrack(() => reset());
      return;
    }
    isPending = true;
    debounceTimer = setTimeout(() => void runSearch(request), DEBOUNCE_MS);
    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
    };
  });

  // Reopening keeps the previous query but selects it, so typing replaces it
  // and ⌘⇧F twice in a row is not a chore.
  $effect(() => {
    if (!open) return;
    void tick().then(() => searchEl?.select());
  });

  // Grow the window when the selection walks past its end, then bring the
  // selected row into view once it exists. `visibleCount` is read untracked:
  // this effect writes it, and tracking it would re-run on its own write.
  $effect(() => {
    const index = selectedIndex;
    if (index >= untrack(() => visibleCount)) {
      visibleCount = index + RESULT_WINDOW;
      return;
    }
    void tick().then(() => {
      listEl
        ?.querySelector<HTMLElement>(`[data-result-index="${index}"]`)
        ?.scrollIntoView({ block: "nearest" });
    });
  });

  $effect(() => {
    const sentinel = sentinelEl;
    if (!sentinel) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) visibleCount += RESULT_WINDOW;
    });
    observer.observe(sentinel);
    return () => observer.disconnect();
  });

  function openMatch(match: ProjectContentMatch) {
    if (!canOpen) return;
    open = false;
    session.openFilePreview({ path: match.path, line: match.lineNumber }, targetTabId);
  }

  function onSearchKeydown(e: KeyboardEvent) {
    if (e.key === "ArrowDown" && matches.length > 0) {
      e.preventDefault();
      selectedIndex = (selectedIndex + 1) % matches.length;
    } else if (e.key === "ArrowUp" && matches.length > 0) {
      e.preventDefault();
      selectedIndex = (selectedIndex - 1 + matches.length) % matches.length;
    } else if (e.key === "Enter") {
      e.preventDefault();
      const match = matches[selectedIndex];
      if (match) openMatch(match);
    }
  }

  const statusText = $derived.by(() => {
    if (isPending) return "Searching…";
    if (searchError) return searchError;
    if (regexError) return "Invalid regular expression";
    if (!hasQuery) return "";
    const results = `${matches.length.toLocaleString()}${truncated ? "+" : ""} ${matches.length === 1 ? "result" : "results"}`;
    return `${results} in ${fileCount.toLocaleString()} ${fileCount === 1 ? "file" : "files"}`;
  });
  const statusIsError = $derived(!isPending && (!!searchError || !!regexError));
</script>

{#snippet optionToggle(
  label: string,
  binding: "project-search.match-case" | "project-search.whole-word" | "project-search.regex",
  active: boolean,
  glyph: string,
  onToggle: () => void,
)}
  <button
    type="button"
    aria-label={label}
    aria-pressed={active}
    title={`${label} (${comboHint(binding)})`}
    class={cn(
      "flex size-6 shrink-0 items-center justify-center rounded-md font-mono text-[0.6875rem] font-medium transition-colors duration-100",
      active
        ? "bg-(--solus-accent-light) text-(--solus-text-primary)"
        : "text-(--solus-text-tertiary) hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary)",
    )}
    onclick={onToggle}
  >
    {glyph}
  </button>
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
    class="flex h-[min(34rem,70vh)] w-[clamp(22rem,64vw,46rem)] max-w-[calc(100vw-3rem)] origin-top flex-col overflow-hidden rounded-2xl border-[0.0625rem] border-(--solus-popover-border) bg-(--solus-popover-bg) outline-none shadow-[shadow:var(--solus-popover-shadow),inset_0_0.0625rem_0_rgba(255,255,255,0.14),0_1.75rem_3.125rem_-1.125rem_rgba(0,0,0,0.24)] [.dark_&]:shadow-[shadow:var(--solus-popover-shadow),inset_0_0.0625rem_0_rgba(255,255,255,0.06),0_1.75rem_3.125rem_-1.125rem_rgba(0,0,0,0.45)]"
    class:project-search-enter={open}
    role="dialog"
    aria-label="Search in project"
    aria-modal="true"
  >
    <!-- Search -->
    <div class="flex h-[3.3125rem] shrink-0 items-center gap-3 border-b border-(--solus-menu-hairline) px-5">
      <MagnifyingGlassIcon size={16} class="shrink-0 text-(--solus-text-tertiary) opacity-65" />
      <input
        bind:this={searchEl}
        bind:value={query}
        onkeydown={onSearchKeydown}
        type="search"
        name="project-search"
        aria-label={`Search file contents in ${scopeName}`}
        placeholder={`Search in ${scopeName}…`}
        class="h-auto min-w-0 flex-1 border-none bg-transparent text-[length:calc(0.96875rem*var(--solus-font-scale,1))] tracking-[-0.012em] text-(--solus-text-primary) caret-(--solus-accent) outline-none placeholder:text-(--solus-text-tertiary) [&::-webkit-search-cancel-button]:hidden"
        autocomplete="off"
        spellcheck="false"
      />
      <div class="flex shrink-0 items-center gap-0.5 rounded-lg bg-(--solus-surface-hover) p-0.5">
        {@render optionToggle("Match case", "project-search.match-case", caseSensitive, "Aa", () => (caseSensitive = !caseSensitive))}
        {@render optionToggle("Match whole word", "project-search.whole-word", wholeWord, "ab", () => (wholeWord = !wholeWord))}
        {@render optionToggle("Use regular expression", "project-search.regex", useRegex, ".*", () => (useRegex = !useRegex))}
      </div>
    </div>

    <!-- Status -->
    {#if statusText}
      <div
        class={cn(
          "flex h-8 shrink-0 items-center gap-1.5 border-b border-(--solus-menu-hairline) px-5 text-[length:calc(0.71875rem*var(--solus-font-scale,1))] tabular-nums",
          statusIsError ? "text-(--solus-status-error)" : "text-(--solus-text-tertiary)",
        )}
        role="status"
      >
        {#if statusIsError}
          <WarningCircleIcon size={12} weight="fill" class="shrink-0" />
        {/if}
        {statusText}
      </div>
    {/if}

    <!-- Results -->
    {#if matches.length === 0}
      <div
        class="flex flex-1 flex-col items-center justify-center gap-2.5 px-6 text-center text-[length:calc(0.8125rem*var(--solus-font-scale,1))] text-(--solus-text-tertiary)"
        role="status"
      >
        <MagnifyingGlassIcon size={18} weight="light" />
        <span>
          {#if hasQuery && !isPending && !searchError}
            No results found
          {:else}
            Search this project's file contents
          {/if}
        </span>
      </div>
    {:else}
      <div
        bind:this={listEl}
        class="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-y-contain py-1.5"
        role="listbox"
        aria-label="Search results"
      >
        {#each groups as group (group.path)}
          {@const icon = fileTypeIcon(group.path)}
          {@const language = languageForPath(group.path)}
          <section class="pb-1">
            <div
              class="sticky top-0 z-10 flex h-7 items-center gap-2 bg-(--solus-popover-bg) px-5 text-[length:calc(0.71875rem*var(--solus-font-scale,1))]"
            >
              {#if icon}
                <Icon {icon} width="12" height="12" class="shrink-0" />
              {/if}
              <span class="shrink-0 font-medium text-(--solus-text-primary)">{group.name}</span>
              {#if group.directory}
                <span class="min-w-0 truncate text-(--solus-text-tertiary)">{group.directory}</span>
              {/if}
              <span
                class="ml-auto shrink-0 rounded-full bg-(--solus-surface-hover) px-1.5 py-0.5 text-[0.625rem] tabular-nums text-(--solus-text-tertiary)"
              >
                {group.matches.length}
              </span>
            </div>
            {#each group.matches as match (`${match.lineNumber}:${match.index}`)}
              {@const line = visibleLine(match)}
              <button
                type="button"
                role="option"
                aria-selected={match.index === selectedIndex}
                data-result-index={match.index}
                class={cn(
                  "flex h-6 w-full min-w-0 cursor-pointer items-center gap-3 border-none bg-transparent px-5 text-left font-mono text-[0.75rem] transition-colors duration-75",
                  match.index === selectedIndex
                    ? "text-(--solus-text-primary) shadow-[shadow:inset_0_0_0_62rem_var(--solus-accent-light)]"
                    : "text-(--solus-text-secondary) hover:bg-(--solus-surface-hover)",
                )}
                onpointermove={() => (selectedIndex = match.index)}
                onclick={() => openMatch(match)}
              >
                <span class="w-8 shrink-0 text-right tabular-nums text-(--solus-text-tertiary)">
                  {match.lineNumber}
                </span>
                <span class="min-w-0 flex-1 truncate whitespace-pre">
                  {#each lineSegments(line, lineHighlighter.tokens(line.text, language, theme)) as segment, i (i)}
                    {#if segment.isMatch}
                      <mark
                        class="rounded-[0.125rem] bg-(--solus-accent-light) text-inherit"
                        style={segmentStyle(segment)}>{segment.text}</mark>
                    {:else}<span style={segmentStyle(segment)}>{segment.text}</span>{/if}
                  {/each}
                </span>
              </button>
            {/each}
          </section>
        {/each}
        {#if matches.length > visibleCount}
          <div bind:this={sentinelEl} class="h-8" aria-hidden="true"></div>
        {/if}
      </div>
    {/if}

    <!-- Footer -->
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
      <span class="ml-auto truncate" title={environment.cwd}>{scopeName}</span>
    </div>
  </div>
</div>

<style>
  /* Keyframes can't be expressed as Tailwind utilities; referenced via the
     class on the panel above. */
  .project-search-enter {
    animation: project-search-enter 180ms cubic-bezier(0.22, 1, 0.36, 1) both;
  }

  @keyframes project-search-enter {
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
