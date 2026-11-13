<script lang="ts">
  import { localApi } from "@solus/client-core/local-api";
  import {
    ExternalLink as ExternalLinkIcon,
    GitPullRequest as GitPullRequestIcon,
    Plus as PlusIcon,
    X as XIcon,
  } from "@lucide/svelte";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import { Button } from "../ui/button";
  import { Input } from "../ui/input";
  import { toasts } from "../../lib/toasts";
  import { checkPullRequestUrl } from "./lib/link-pull-request";
  import { pullRequestMenuRows } from "./lib/pull-requests-menu";
  import type { TaskPrChoice } from "./lib/task-list";

  /**
   * A session's pull requests, as one menu's content: the chip's dropdown and
   * the session menu's submenu both show it, so a person opens, unlinks, and
   * links pull requests in one place (docs/plans/session-pull-requests.md).
   * It is content only: the caller owns the menu it sits in.
   */
  interface Props {
    choices: readonly TaskPrChoice[];
    onOpen: (choice: TaskPrChoice) => void;
    /** Removes a link, or null for a pull request the session only reads from
     *  its checkout's branch, which has no link to remove. */
    onUnlink?: (choice: TaskPrChoice) => (() => void) | null;
    /** Links a pull request by its URL. Absent where the viewer may not
     *  change the session. */
    onLink?: (url: string) => Promise<void>;
  }
  let { choices, onOpen, onUnlink, onLink }: Props = $props();

  const rows = $derived(pullRequestMenuRows(choices));
  const firstSettled = $derived(rows.findIndex((row) => row.isSettled));

  // A session with no pull requests opens straight onto the field: linking
  // one is the only thing the menu can do.
  let isLinking = $state(choices.length === 0);
  let url = $state("");
  let isSaving = $state(false);
  const check = $derived(checkPullRequestUrl(url));

  async function link() {
    if (!onLink || check.kind !== "valid" || isSaving) return;
    isSaving = true;
    try {
      await onLink(check.url);
      url = "";
      isLinking = false;
    } catch (error) {
      toasts.error("Couldn't link the pull request", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      isSaving = false;
    }
  }

  function openOnWeb(choice: TaskPrChoice) {
    const pageUrl = choice.url ?? choice.pullRequest?.url;
    if (pageUrl) void localApi.openExternal(pageUrl);
  }
</script>

<div class="flex items-center justify-between gap-2 px-2.5 pt-1.5 pb-1 text-xs text-(--solus-text-tertiary)">
  <span class="font-medium">Pull requests</span>
  {#if rows.length}<span class="tabular-nums">{rows.length}</span>{/if}
</div>
{#each rows as row, index (row.key)}
  {@const StateIcon = row.badge?.Icon ?? GitPullRequestIcon}
  {@const unlink = onUnlink?.(row.choice) ?? null}
  {@const pageUrl = row.choice.url ?? row.choice.pullRequest?.url}
  {#if index === firstSettled && index > 0}
    <DropdownMenu.Separator />
  {/if}
  <!-- Two lines: the title, then where it is and what state it is in. Delete
       or Backspace unlinks the highlighted row, so the keyboard needs no
       second stop. -->
  <DropdownMenu.Item
    class="group/pr items-start text-workspace-chrome"
    textValue={`${row.reference} ${row.title}`}
    title={`Open ${row.reference} ${row.title}`}
    onclick={(event) => {
      if (!event.metaKey || !pageUrl) return;
      event.preventDefault();
      openOnWeb(row.choice);
    }}
    onkeydown={(event) => {
      if (!unlink || (event.key !== "Delete" && event.key !== "Backspace")) return;
      event.preventDefault();
      unlink();
    }}
    onSelect={() => onOpen(row.choice)}
  >
    <span
      class="mt-0.5 flex size-4 shrink-0 items-center justify-center"
      style:color={row.badge?.tone ?? "var(--muted-foreground)"}
      aria-hidden="true"
    >
      <StateIcon size={14} />
    </span>
    <span class="flex min-w-0 flex-1 flex-col">
      <span class="truncate {row.isSettled ? 'text-muted-foreground' : 'text-foreground'}">{row.title}</span>
      <span class="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        <span class="shrink-0 tabular-nums">{row.reference}</span>
        <span aria-hidden="true">·</span>
        <span
          class="truncate"
          style:color={row.stateTone}
          >{row.stateLabel}{unlink ? "" : " · on this branch"}</span
        >
      </span>
    </span>
    <span class="flex shrink-0 items-center gap-0.5 self-center">
      {#if pageUrl}
        <Button
          variant="ghost"
          size="icon-xs"
          tabindex={-1}
          class="size-6 text-muted-foreground opacity-60 transition-opacity duration-100 group-hover/pr:opacity-100 group-data-highlighted/pr:opacity-100 hover:text-foreground pointer-coarse:opacity-100"
          aria-label={`Open ${row.reference} on the web`}
          title="Open on the web"
          onpointerdown={(event) => event.stopPropagation()}
          onclick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            openOnWeb(row.choice);
          }}
        >
          <ExternalLinkIcon size={12} aria-hidden="true" />
        </Button>
      {/if}
      {#if unlink}
        <Button
          variant="ghost"
          size="icon-xs"
          tabindex={-1}
          class="size-6 text-muted-foreground opacity-60 transition-opacity duration-100 group-hover/pr:opacity-100 group-data-highlighted/pr:opacity-100 hover:text-(--solus-status-error) pointer-coarse:opacity-100"
          aria-label={`Unlink ${row.reference}`}
          title="Unlink (Delete)"
          onpointerdown={(event) => event.stopPropagation()}
          onclick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            unlink();
          }}
        >
          <XIcon size={12} aria-hidden="true" />
        </Button>
      {:else}
        <!-- Keeps the ↗ column aligned with the rows that can unlink. -->
        <span class="size-6" aria-hidden="true"></span>
      {/if}
    </span>
  </DropdownMenu.Item>
{/each}
{#if onLink}
  {#if rows.length}<DropdownMenu.Separator />{/if}
  {#if isLinking}
    <!-- The field is not a menu row, so its keys stay its own: the menu's
         type-ahead would otherwise take every letter. Escape still closes. -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="flex flex-col gap-1 px-1.5 py-1"
      onkeydown={(event) => {
        if (event.key !== "Escape") event.stopPropagation();
      }}
    >
      <div class="flex items-center gap-1.5">
        <Input
          bind:value={url}
          autofocus
          class="h-7 min-w-0 flex-1 text-xs"
          placeholder="Paste a pull request URL"
          aria-label="Pull request URL"
          aria-invalid={check.kind === "invalid"}
          onSubmit={() => void link()}
          submitOn="enter"
        />
        <Button size="sm" class="h-7 shrink-0" disabled={check.kind !== "valid" || isSaving} onclick={() => void link()}>
          {isSaving ? "Linking…" : "Link"}
        </Button>
      </div>
      {#if check.kind !== "empty"}
        <span class="text-xs {check.kind === 'invalid' ? 'text-(--failure)' : 'text-(--solus-text-tertiary)'}">
          {check.kind === "invalid" ? "Paste the full URL of a GitHub pull request." : check.label}
        </span>
      {/if}
    </div>
  {:else}
    <DropdownMenu.Item
      class="text-workspace-chrome"
      onSelect={(event) => {
        // The row turns into the field in place; the menu stays open.
        event.preventDefault();
        isLinking = true;
      }}
    >
      <PlusIcon />
      Link pull request…
    </DropdownMenu.Item>
  {/if}
{/if}
