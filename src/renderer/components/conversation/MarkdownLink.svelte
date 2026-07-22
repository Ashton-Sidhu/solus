<script lang="ts">
  import { FileTextIcon } from "phosphor-svelte";
  import { getWorkspaceContext } from "../../contexts";
  import { parseFileHref, requestFilePreview } from "../../lib/filePreview";
  import { FILE_ICON_VIEWBOX, getFileIconPath } from "../editor/fileIcons";
  import { tokenClassName } from "../editor/tokenStyle";
  import type { Snippet } from "svelte";

  interface Props {
    href?: string;
    title?: string;
    children?: Snippet;
  }
  let { href = "", title = undefined, children }: Props = $props();

  type Status = "pending" | "accepted" | "rejected";

  const VARIANT_FOR: Record<Status, "plan-pending" | "plan-accepted" | "plan-rejected"> = {
    pending: "plan-pending",
    accepted: "plan-accepted",
    rejected: "plan-rejected",
  };

  const session = getWorkspaceContext();

  const isPlanRef = $derived(href.startsWith("plan://"));
  const isWorkRef = $derived(href.startsWith("work://"));
  const fileRef = $derived(parseFileHref(href));
  const planParams = $derived(
    isPlanRef
    ? (() => {
        try {
          const url = new URL(href);
          return {
            planId: url.searchParams.get("planId") || "",
            sessionId: url.searchParams.get("sessionId") || "",
            planToolUseId: url.searchParams.get("planToolUseId") || "",
            status: ((url.searchParams.get("status") || "pending") as Status),
          };
        } catch {
          return null;
        }
      })()
    : null,
  );
  const workParams = $derived(
    isWorkRef
    ? (() => {
        try {
          const url = new URL(href);
          return {
            workId: url.searchParams.get("workId") || "",
            title: title || "",
          };
        } catch {
          return null;
        }
      })()
    : null,
  );

  function basename(path: string): string {
    const stripped = path.replace(/\/+$/, "");
    const idx = stripped.lastIndexOf("/");
    return idx === -1 ? stripped : stripped.slice(idx + 1);
  }

  function isMarkdownPath(path: string): boolean {
    return /\.(md|mdx|markdown)$/i.test(path.split(/[?#]/, 1)[0] ?? path);
  }

  function handleClick(e: MouseEvent) {
    if (isPlanRef && planParams) {
      e.preventDefault();
      void session.openPlanModal(planParams.planId, {
        sessionId: planParams.sessionId,
        planToolUseId: planParams.planToolUseId,
        status: planParams.status,
      });
    } else if (isWorkRef && workParams) {
      e.preventDefault();
      session.openWorkModal(workParams.workId, workParams.title);
    } else if (fileRef) {
      e.preventDefault();
      requestFilePreview({
        ...fileRef,
        tabId: session.focusedChatTabId ?? session.activeTabId,
      });
    } else if (href) {
      e.preventDefault();
      window.solus.openExternal(href);
    }
  }
</script>

{#if isPlanRef && planParams}
  <button
    type="button"
    onclick={handleClick}
    class="{tokenClassName(VARIANT_FOR[planParams.status])} solus-token--output-link cursor-pointer"
    style="border:none"
  >
    <span class="solus-token__icon">
      {#if planParams.status === "accepted"}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
      {:else if planParams.status === "rejected"}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
      {:else}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/></svg>
      {/if}
    </span>
    <span>{@render children?.()}</span>
  </button>
{:else if isWorkRef && workParams}
  <button
    type="button"
    onclick={handleClick}
    class="{tokenClassName('work')} solus-token--output-link cursor-pointer"
    style="border:none"
  >
    <span class="solus-token__icon">
      <FileTextIcon size={12} />
    </span>
    <span>{@render children?.()}</span>
  </button>
{:else if fileRef}
  <button
    type="button"
    class={`${tokenClassName("file")} solus-token--output-link solus-token--output-file-link`}
    title={fileRef.line ? `${fileRef.path}:${fileRef.line}` : fileRef.path}
    onclick={handleClick}
  >
    <span class="solus-token__icon">
      {#if isMarkdownPath(fileRef.path)}
        <FileTextIcon size={12} />
      {:else}
        <svg viewBox={FILE_ICON_VIEWBOX} fill="currentColor"><path d={getFileIconPath(basename(fileRef.path))} /></svg>
      {/if}
    </span>
    <span>{@render children?.()}{#if fileRef.line}<span class="solus-token__line-number">:{fileRef.line}</span>{/if}</span>
  </button>
{:else}
  <a {href} {title} onclick={handleClick}>{@render children?.()}</a>
{/if}
