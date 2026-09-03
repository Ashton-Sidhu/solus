<script lang="ts">
  import { ArrowUpRight as ArrowUpRightIcon, ExternalLink as ExternalLinkIcon, RefreshCw as RefreshIcon } from "@lucide/svelte";
  import * as Popover from "../ui/popover";
  import { Button } from "../ui/button";
  import { Skeleton } from "../ui/skeleton";
  import CopyButton from "../ui/CopyButton.svelte";
  import { cn } from "@solus/workspace-ui/lib/tw";
  import { localApi } from "@solus/client-core/local-api";
  import type { CodeIntelDocsSummary, CodeIntelReference, CodeIntelSymbolResult } from "@solus/contracts/code-intel";
  import { codeIntelStore } from "./code-intel.store.svelte";
  import CodeIntelReferenceList from "./CodeIntelReferenceList.svelte";
  import { untrack } from "svelte";
  import { SvelteSet } from "svelte/reactivity";
  import {
    cardNotice,
    groupReferences,
    isAtDefinition,
    locationLabel,
    mdnReferenceFor,
    referenceListItems,
    referenceSummary,
    signatureParts,
    splitDocumentation,
    type CodeSymbolLookup,
  } from "./lib/symbol-card";

  interface Props {
    lookup: CodeSymbolLookup | null;
    /** `path` is root-relative; `line` is 1-based, as the file editor counts. */
    onNavigate: (path: string, line: number) => void;
    onClose: () => void;
  }

  let { lookup, onNavigate, onClose }: Props = $props();

  let result = $state<CodeIntelSymbolResult | null>(null);
  let isLoading = $state(false);
  let contentEl: HTMLElement | null = $state(null);
  let generation = 0;
  /** Files whose reference rows are all showing. Cleared with the answer. */
  const expandedFiles = new SvelteSet<string>();
  /** The prose runs past its clamp and the reader asked for the rest. */
  let isDescriptionExpanded = $state(false);
  let descriptionEl: HTMLElement | null = $state(null);
  let isDescriptionClamped = $state(false);
  /** MDN's sentence for a platform symbol the indexer left undescribed. */
  let mdn = $state<CodeIntelDocsSummary | null>(null);
  let isMdnLoading = $state(false);
  let loadedReferences = $state<CodeIntelReference[]>([]);
  let nextReferenceOffset = $state<number | null>(null);
  let isLoadingReferences = $state(false);
  let referenceError = $state<string | null>(null);

  const anchorTarget = $derived(
    lookup ? { getBoundingClientRect: () => lookup.anchor } : null,
  );
  const symbol = $derived(result?.ok ? result.symbol : null);
  const documentation = $derived(splitDocumentation(symbol?.documentation ?? []));
  const signature = $derived(
    signatureParts(documentation.signature, symbol?.name ?? lookup?.token ?? "", symbol?.kind ?? ""),
  );
  const notice = $derived(cardNotice(result, result?.ok ? result.freshness : null));
  const definition = $derived(symbol?.definition ?? null);
  const isDefinedHere = $derived(!!lookup && !!definition && isAtDefinition(lookup, definition));
  const referenceGroups = $derived(
    symbol && lookup ? groupReferences(loadedReferences, lookup.path) : [],
  );
  const remainingReferenceCount = $derived(symbol ? Math.max(0, symbol.referenceCount - loadedReferences.length) : 0);
  const referenceItems = $derived(
    referenceListItems(referenceGroups, expandedFiles, remainingReferenceCount, isLoadingReferences, referenceError),
  );
  const description = $derived(documentation.description.join("\n\n"));
  /** The first answer is still on its way; a later re-ask keeps the old one on screen. */
  const isAwaitingFirstAnswer = $derived(isLoading && !result);

  // One lookup, one answer. The host broadcasts every index transition and the
  // store bumps its version on each, so a card opened mid-build fills in when
  // the build lands instead of staying on "indexing".
  $effect(() => {
    const current = lookup;
    void codeIntelStore.version;
    if (!current) {
      result = null;
      return;
    }
    const mine = ++generation;
    isLoading = true;
    // These collections are outputs of this lookup, not inputs to it. Reading
    // them while resetting would subscribe the effect to its own result: the
    // response pushes references, the effect runs again, clears them, and asks
    // the host again without yielding. Keep the in-place reset, but do not
    // track it as a lookup dependency.
    untrack(() => {
      expandedFiles.clear();
      loadedReferences.splice(0);
    });
    nextReferenceOffset = null;
    isLoadingReferences = false;
    referenceError = null;
    isDescriptionExpanded = false;
    mdn = null;
    isMdnLoading = false;
    void codeIntelStore
      .symbolAt(current.serverId, current.api, current.ctx, {
        cwd: current.root,
        path: current.path,
        line: current.line,
        character: current.character,
      })
      .then((answer) => {
        if (mine !== generation) return;
        result = answer;
        if (answer.ok && answer.symbol) {
          loadedReferences.push(...answer.symbol.references);
          nextReferenceOffset = answer.symbol.references.length < answer.symbol.referenceCount
            ? answer.symbol.references.length
            : null;
        }
        loadMdnSummary(current, answer, mine);
      })
      .catch((error: Error) => {
        if (mine === generation) result = { ok: false, error: error.message || String(error) };
      })
      .finally(() => {
        if (mine === generation) isLoading = false;
      });
  });

  /** A platform symbol with no doc comment gets MDN's opening sentence in the
   *  same place a doc comment would have gone. The lookup's own generation
   *  guards it, so a card moved to another identifier mid-flight discards it. */
  function loadMdnSummary(source: CodeSymbolLookup, answer: CodeIntelSymbolResult, mine: number) {
    const reference = answer.ok ? mdnReferenceFor(answer.symbol) : null;
    if (!reference) return;
    isMdnLoading = true;
    void codeIntelStore
      .docs(source.serverId, source.api, reference)
      .then((docs) => {
        if (mine === generation && docs.ok) mdn = docs.docs;
      })
      .finally(() => {
        if (mine === generation) isMdnLoading = false;
      });
  }

  // "Show more" appears only when the clamp is actually cutting something off,
  // so a two-line summary does not grow an affordance it has no use for. The
  // measurement is the clamped height against the full height, which the box
  // only reports while it is still clamped.
  $effect(() => {
    void description;
    if (!descriptionEl || isDescriptionExpanded) return;
    isDescriptionClamped = descriptionEl.scrollHeight - descriptionEl.clientHeight > 1;
  });

  function toggleFile(path: string) {
    if (expandedFiles.has(path)) expandedFiles.delete(path);
    else expandedFiles.add(path);
  }

  async function loadMoreReferences() {
    if (!lookup || !symbol || nextReferenceOffset === null || isLoadingReferences) return;
    const mine = generation;
    const offset = nextReferenceOffset;
    isLoadingReferences = true;
    referenceError = null;
    try {
      const page = await codeIntelStore.references(lookup.serverId, lookup.api, lookup.ctx, {
        cwd: lookup.root,
        language: symbol.language,
        symbol: symbol.symbol,
        offset,
      });
      if (mine !== generation) return;
      if (!page.ok) {
        referenceError = page.error;
        return;
      }
      loadedReferences.push(...page.references);
      nextReferenceOffset = page.nextOffset;
    } catch (error) {
      if (mine === generation) referenceError = error instanceof Error ? error.message : String(error);
    } finally {
      if (mine === generation) isLoadingReferences = false;
    }
  }

  function navigate(path: string, line: number) {
    onNavigate(path, line);
  }

  function openMdn() {
    if (mdn) void localApi.openExternal(mdn.url);
  }

  function openDefinition() {
    if (definition && !isDefinedHere) navigate(definition.path, definition.range.startLine + 1);
  }

  function rebuildIndex() {
    if (!lookup || !result?.ok || !result.language) return;
    void codeIntelStore.reindex(lookup.serverId, lookup.api, lookup.ctx, {
      cwd: lookup.root,
      language: result.language.language,
    });
  }

  /** The anchor is a snapshot of where the identifier was painted; once the
   *  code scrolls under it the card would float over the wrong token. */
  function onWindowScroll(event: Event) {
    if (!lookup) return;
    if (event.target instanceof Node && contentEl?.contains(event.target)) return;
    onClose();
  }
</script>

<svelte:window onscrollcapture={onWindowScroll} />

<Popover.Root open={!!lookup} onOpenChange={(next) => { if (!next) onClose(); }}>
  <!-- No focus trap. The card opens over a surface that owns its own focus:
       Pierre's `CodeView` puts focus back on its root whenever it recycles a
       rendered item that held it, from inside its render loop. A trap answers
       that by pulling focus back into the card, and the two lock the renderer.
       The card also opens on its loading state, which has nothing tabbable, so
       the trap would take focus off the code on every single Cmd/Ctrl-click. -->
  <Popover.Content
    bind:ref={contentEl}
    data-solus-ui
    customAnchor={anchorTarget}
    trapFocus={false}
    side="bottom"
    align="start"
    sideOffset={6}
    collisionPadding={8}
    aria-label={lookup ? `Symbol ${lookup.token}` : "Symbol"}
    class="menu-surface z-[10002] w-[min(34rem,calc(100vw-2rem))] gap-0 overflow-hidden rounded-2xl bg-(--solus-menu-bg) p-0 text-workspace-chrome shadow-[shadow:var(--solus-menu-shadow)] ring-0 lg:text-workspace-chrome pointer-fine:[.is-laptop-display_&]:w-[min(29rem,calc(100vw-2rem))] pointer-fine:[.is-laptop-display_&]:rounded-xl"
  >
    {#if isAwaitingFirstAnswer}
      <!-- The answer's shape before the answer: the card keeps its geometry so
           nothing jumps when the lookup lands, and the wait reads as a 2px seam
           rather than as a spinner that says nothing about progress. -->
      <div aria-busy="true" aria-label="Looking up symbol">
        <div class="flex flex-col gap-2.5 px-5 pt-4 pb-3.5 pointer-fine:[.is-laptop-display_&]:gap-2 pointer-fine:[.is-laptop-display_&]:px-4 pointer-fine:[.is-laptop-display_&]:pt-3 pointer-fine:[.is-laptop-display_&]:pb-3">
          <Skeleton class="h-3.5 w-[58%] rounded-sm" />
          <Skeleton class="h-3 w-[80%] rounded-sm" />
        </div>
        <div class="border-t border-(--solus-menu-hairline) px-5 py-3 pointer-fine:[.is-laptop-display_&]:px-4 pointer-fine:[.is-laptop-display_&]:py-2.5">
          <Skeleton class="h-3 w-[44%] rounded-sm" />
        </div>
        <div class="flex flex-col gap-2.5 border-t border-(--solus-menu-hairline) px-5 pt-3.5 pb-4 pointer-fine:[.is-laptop-display_&]:gap-2 pointer-fine:[.is-laptop-display_&]:px-4 pointer-fine:[.is-laptop-display_&]:pt-3 pointer-fine:[.is-laptop-display_&]:pb-3">
          <Skeleton class="h-3 w-[30%] rounded-sm" />
          <Skeleton class="h-3 w-[66%] rounded-sm" />
        </div>
        <span class="block h-0.5 overflow-hidden bg-(--solus-surface-hover)" aria-hidden="true">
          <span class="block h-full w-2/5 rounded-full bg-primary" style="animation: indeterminate-sweep 1.15s cubic-bezier(0.65, 0, 0.35, 1) infinite"></span>
        </span>
      </div>
    {:else}
      <!-- The signature says what the symbol is; a sentence says what it does.
           The card is a dense reference surface, not a reading one, so it runs
           on a single body rung — `text-workspace-chrome`, the canonical
           responsive rung — from the signature down to the last filename, and
           lets family, weight, colour and the hairlines do the separating that
           size usually does. Under it hang three steps: `text-symbol-card-meta`
           for anything that annotates a line rather than saying it (the section
           label, the directory, the `:line` suffix, the counts, the MDN
           source), `text-symbol-card-code` for a quoted line of source, and
           `text-micro` for the number of that line. Code runs under the sans
           filename above it because monospace at an equal size reads larger and
           would take the section over. Every rung here follows the display, so
           the card shrinks with the workspace around it on a laptop instead of
           floating over 12px code at 14px; the values and their laptop steps
           are declared together in `index.css`, never restated per element.
           Every element states its rung: a portalled surface inherits whatever
           the primitive last set for anything that does not. -->
      <div class="flex flex-col gap-2 px-5 pt-4 pb-3.5 pointer-fine:[.is-laptop-display_&]:px-4 pointer-fine:[.is-laptop-display_&]:pt-3 pointer-fine:[.is-laptop-display_&]:pb-3">
        <div class="max-h-28 overflow-auto font-[family-name:var(--solus-code-font-family)] text-workspace-chrome leading-[1.55] break-words whitespace-pre-wrap">
          {#if signature.keyword}<span class="text-(--solus-syntax-keyword)">{signature.keyword}</span>{" "}{/if}<span
            class="font-semibold text-(--solus-text-primary)">{signature.name}</span><span class="text-(--solus-text-tertiary)">{signature.rest}</span>
        </div>
        {#if description}
          <!-- Four lines is the card's share of the pane; the rest is one click
               away and folds back the same way. Expanded prose scrolls inside
               the card rather than pushing the references off the screen. -->
          <p
            bind:this={descriptionEl}
            class={cn(
              "text-workspace-chrome leading-[1.55] text-pretty whitespace-pre-line text-(--solus-text-secondary)",
              isDescriptionExpanded ? "max-h-44 overflow-auto" : "line-clamp-4",
            )}
          >
            {description}
          </p>
          {#if isDescriptionClamped}
            <button
              type="button"
              class="-mt-0.5 self-start rounded-sm text-symbol-card-meta font-medium text-(--solus-text-tertiary) outline-hidden transition-[color] duration-(--duration-quick) ease-(--ease-premium) hover:text-(--solus-text-primary) focus-visible:text-(--solus-text-primary) focus-visible:underline"
              onclick={() => (isDescriptionExpanded = !isDescriptionExpanded)}
            >
              {isDescriptionExpanded ? "Show less" : "Read more"}
            </button>
          {/if}
        {:else if mdn}
          <!-- The indexer left this symbol undescribed, so MDN's opening
               sentence stands in for the doc comment, in the doc comment's
               place. It is named as MDN's, not passed off as the project's. -->
          <p class="text-workspace-chrome leading-[1.55] text-pretty text-(--solus-text-secondary)">{mdn.summary}</p>
          <!-- Says whose sentence it is, which page answered — a search can land
               on a name other than the token clicked — and where the rest of it
               is. -->
          <button
            type="button"
            class="flex min-w-0 items-center gap-1 self-start overflow-hidden rounded-sm text-symbol-card-meta text-(--solus-text-tertiary) outline-hidden transition-[color] duration-(--duration-quick) ease-(--ease-premium) hover:text-(--solus-text-primary) focus-visible:text-(--solus-text-primary) focus-visible:underline"
            onclick={openMdn}
          >
            <span class="min-w-0 truncate">MDN{mdn.title ? ` · ${mdn.title}` : ""}</span>
            <ExternalLinkIcon size={12} class="shrink-0" />
          </button>
        {:else if isMdnLoading}
          <Skeleton class="h-3 w-[80%] rounded-sm" />
          <Skeleton class="h-3 w-[52%] rounded-sm" />
        {/if}
      </div>

      {#if symbol}
        <!-- Where the symbol lives, said once, as a place rather than as a verb. -->
        {#if definition && isDefinedHere}
          {@const label = locationLabel(definition)}
          <div class="flex min-w-0 flex-col gap-0.5 border-t border-(--solus-menu-hairline) px-5 py-3 pointer-fine:[.is-laptop-display_&]:px-4 pointer-fine:[.is-laptop-display_&]:py-2.5">
            <span class="text-symbol-card-meta text-(--solus-text-tertiary)">Definition</span>
            <span class="flex min-w-0 items-baseline gap-1.5 text-workspace-chrome">
              <span class="shrink-0 font-medium text-(--solus-text-primary)">{label.name}</span>
              <span class="shrink-0 text-symbol-card-meta font-medium text-(--solus-text-tertiary) tabular-nums">:{label.line}</span>
              <span class="min-w-0 flex-1 truncate text-symbol-card-meta text-(--solus-text-tertiary)">this line</span>
            </span>
          </div>
        {:else if definition}
          {@const label = locationLabel(definition)}
          <button
            type="button"
            class="flex w-full items-start gap-2.5 overflow-hidden border-t border-(--solus-menu-hairline) px-5 py-3 text-left outline-hidden transition-[background-color] duration-(--duration-quick) ease-(--ease-premium) hover:bg-(--solus-surface-hover) focus-visible:shadow-[shadow:inset_0_0_0_62rem_var(--solus-menu-hover-ink)] pointer-fine:[.is-laptop-display_&]:px-4 pointer-fine:[.is-laptop-display_&]:py-2.5"
            onclick={openDefinition}
          >
            <span class="flex min-w-0 flex-1 flex-col gap-0.5">
              <span class="text-symbol-card-meta text-(--solus-text-tertiary)">Definition</span>
              <span class="flex min-w-0 items-baseline gap-1.5 text-workspace-chrome">
                <span class="shrink-0 font-medium text-(--solus-text-primary)">{label.name}</span>
                <span class="shrink-0 text-symbol-card-meta font-medium text-(--solus-text-tertiary) tabular-nums">:{label.line}</span>
                <span class="min-w-0 flex-1 truncate text-symbol-card-meta text-(--solus-text-tertiary)">{label.dir}</span>
              </span>
            </span>
            <ArrowUpRightIcon size={14} class="mt-4 shrink-0 text-(--solus-text-tertiary)" />
          </button>
        {:else if !symbol.externalDocumentation}
          <!-- Only for a symbol with nothing else to say about where it lives.
               A platform symbol already reads as one — the MDN line names the
               page it belongs to — so repeating it is a row of noise. The test
               is the reference, not the loaded summary, so the row does not
               appear for an instant and then vanish while MDN answers. -->
          <div class="border-t border-(--solus-menu-hairline) px-5 py-3 text-workspace-chrome text-(--solus-text-tertiary) pointer-fine:[.is-laptop-display_&]:px-4 pointer-fine:[.is-laptop-display_&]:py-2.5">
            Defined outside this project.
          </div>
        {/if}

        {#if referenceItems.length > 0}
          <!-- One column, one list: every reference reads as the line of code it
               is, grouped under the file it lives in. -->
          <div class="flex flex-col border-t border-(--solus-menu-hairline)">
            <div class="px-5 pt-3 pb-0.5 text-symbol-card-meta text-(--solus-text-tertiary) pointer-fine:[.is-laptop-display_&]:px-4">
              {referenceSummary(symbol.referenceCount, symbol.referenceFileCount)}
            </div>
            <CodeIntelReferenceList
              items={referenceItems}
              symbolName={symbol.name}
              error={referenceError}
              onNavigate={navigate}
              onToggleFile={toggleFile}
              onLoadMore={() => void loadMoreReferences()}
            />
          </div>
        {:else}
          <!-- An external symbol has a definition and no call sites here. Say
               which of the two is true rather than showing an empty list. -->
          <div class="border-t border-(--solus-menu-hairline) px-5 py-3 text-workspace-chrome text-(--solus-text-tertiary) pointer-fine:[.is-laptop-display_&]:px-4 pointer-fine:[.is-laptop-display_&]:py-2.5">
            No references in your source tree
          </div>
        {/if}
      {:else if result && !isLoading && !notice}
        <div class="border-t border-(--solus-menu-hairline) px-5 py-3 text-workspace-chrome text-(--solus-text-tertiary) pointer-fine:[.is-laptop-display_&]:px-4 pointer-fine:[.is-laptop-display_&]:py-2.5">
          No symbol at this position.
        </div>
      {/if}
    {/if}

    {#if notice}
      <div
        class={cn(
          "flex min-w-0 flex-col gap-1.5 border-t border-(--solus-menu-hairline) bg-(--solus-surface-hover) px-5 py-2.5 text-workspace-chrome pointer-fine:[.is-laptop-display_&]:px-4 pointer-fine:[.is-laptop-display_&]:py-2",
          notice.tone === "warning" ? "text-(--solus-status-error)" : "text-(--solus-text-tertiary)",
        )}
      >
        <div class="flex min-w-0 items-center gap-2">
          <span class="min-w-0 flex-1 leading-snug text-pretty">{notice.text}</span>
          {#if notice.action}
            <Button variant="outline" size="sm" class="h-7 shrink-0 gap-1 px-2.5 text-symbol-card-meta" onclick={rebuildIndex}>
              <RefreshIcon size={12} />
              {notice.action === "retry" ? "Retry" : "Rebuild"}
            </Button>
          {/if}
        </div>
        {#if notice.command}
          <div class="flex min-w-0 items-center gap-1 rounded-lg bg-(--solus-surface-hover) py-0.5 pr-0.5 pl-2">
            <code class="min-w-0 flex-1 truncate font-[family-name:var(--solus-code-font-family)] text-symbol-card-code leading-[1.5] text-(--solus-text-secondary)" title={notice.command}>
              {notice.command}
            </code>
            <CopyButton text={notice.command} title="Copy install command" iconOnly />
          </div>
        {/if}
      </div>
    {/if}
  </Popover.Content>
</Popover.Root>
