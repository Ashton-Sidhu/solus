<script lang="ts">
  import { localApi } from "@solus/client-core/local-api";
  import { MessageCircleMore as ChatCircleDotsIcon, FileText as FileTextIcon, GitPullRequest as GitPullRequestIcon } from "@lucide/svelte";
  import { getWorkspaceContext } from "../../contexts";
  import { parseFileHref, requestFilePreview } from "../../lib/filePreview";
  import { routeForHref } from "../../lib/agent-links";
  import { FILE_ICON_VIEWBOX, getFileIconPath } from "../editor/fileIcons";
  import { tokenClassName } from "../editor/tokenStyle";
  import { faviconUrlForHref } from "./lib/external-link";
  import { codeFileLinkLabel } from "./lib/assistant-markdown";
  import { parseSessionHref, resolveSessionLinkMeta } from "./lib/session-link";
  import { getSessionLinkContext } from "./lib/session-link-context";
  import type { Snippet } from "svelte";

  interface Props {
    href?: string;
    title?: string;
    text?: string;
    children?: Snippet;
  }
  let { href = "", title = undefined, text = undefined, children }: Props = $props();

  type Status = "pending" | "accepted" | "rejected";

  const VARIANT_FOR = {
    pending: "plan-pending",
    accepted: "plan-accepted",
    rejected: "plan-rejected",
  } satisfies Record<Status, "plan-pending" | "plan-accepted" | "plan-rejected">;

  const session = getWorkspaceContext();
  const sessionLinkContext = getSessionLinkContext();

  const isPlanRef = $derived(href.startsWith("plan://"));
  const isWorkRef = $derived(href.startsWith("work://"));
  const isPrRef = $derived(href.startsWith("pr://"));
  const sessionParams = $derived(parseSessionHref(href));
  const fileRef = $derived(parseFileHref(href));
  const codeFileLabel = $derived(codeFileLinkLabel(text, fileRef?.line));
  // The destination comes from the codec; only the chip's own decoration is
  // read off the href here, and a plan's approval status is the whole of it.
  const linkRoute = $derived(
    routeForHref(href, { title, serverId: sessionLinkContext?.serverId() }),
  );
  const planStatus = $derived.by<Status>(() => {
    try {
      const status = new URL(href).searchParams.get("status");
      return status === "accepted" || status === "rejected" ? status : "pending";
    } catch {
      return "pending";
    }
  });

  const faviconUrl = $derived(faviconUrlForHref(href));
  let failedFaviconUrl = $state<string | null>(null);

  function basename(path: string): string {
    const stripped = path.replace(/\/+$/, "");
    const idx = stripped.lastIndexOf("/");
    return idx === -1 ? stripped : stripped.slice(idx + 1);
  }

  function isMarkdownPath(path: string): boolean {
    return /\.(md|mdx|markdown)$/i.test(path.split(/[?#]/, 1)[0] ?? path);
  }

  function handleClick(e: MouseEvent) {
    if (linkRoute) {
      e.preventDefault();
      session.openRoute(linkRoute, {
        target: linkRoute.name === "prReview" ? "aside" : undefined,
        externalFallbackUrl:
          linkRoute.name === "prReview" && /^https:\/\//i.test(href)
            ? href
            : undefined,
      });
    } else if (sessionParams) {
      e.preventDefault();
      void resolveSessionLinkMeta(sessionParams, sessionLinkContext?.serverId()).then((meta) =>
        session.resumeSession(meta),
      );
    } else if (fileRef) {
      e.preventDefault();
      requestFilePreview({
        ...fileRef,
        tabId: session.focusedChatTabId ?? session.activeTabId,
      });
    } else if (href) {
      e.preventDefault();
      localApi.openExternal(href);
    }
  }
</script>

{#if isPlanRef && linkRoute}
  <button
    type="button"
    onclick={handleClick}
    class="{tokenClassName(VARIANT_FOR[planStatus])} solus-token--output-link cursor-pointer"
    style="border:none"
  >
    <span class="solus-token__icon">
      {#if planStatus === "accepted"}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
      {:else if planStatus === "rejected"}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
      {:else}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/></svg>
      {/if}
    </span>
    <span>{@render children?.()}</span>
  </button>
{:else if isWorkRef && linkRoute}
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
{:else if isPrRef && linkRoute}
  <button
    type="button"
    onclick={handleClick}
    class="{tokenClassName('pr')} solus-token--output-link cursor-pointer"
    style="border:none"
  >
    <span class="solus-token__icon">
      <GitPullRequestIcon size={12} weight="bold" />
    </span>
    <span>{@render children?.()}</span>
  </button>
{:else if sessionParams}
  <button
    type="button"
    onclick={handleClick}
    class="{tokenClassName('session')} solus-token--output-link cursor-pointer"
    style="border:none"
  >
    <span class="solus-token__icon">
      <ChatCircleDotsIcon size={12} />
    </span>
    <span>{@render children?.()}</span>
  </button>
{:else if fileRef}
  <button
    type="button"
    class={`${tokenClassName("file", true)} solus-token--output-link solus-token--output-file-link`}
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
    <span>{#if codeFileLabel !== null}{codeFileLabel}{:else}{@render children?.()}{/if}{#if fileRef.line}<span class="solus-token__line-number">:{fileRef.line}</span>{/if}</span>
  </button>
{:else}
  <a
    {href}
    {title}
    class="solus-link"
    onclick={handleClick}
    >{#if faviconUrl && failedFaviconUrl !== faviconUrl}<img
        class="solus-link__favicon"
        src={faviconUrl}
        alt=""
        width="12"
        height="12"
        loading="lazy"
        referrerpolicy="no-referrer"
        onerror={() => (failedFaviconUrl = faviconUrl)}
      />{/if}{@render children?.()}</a
  >
{/if}
