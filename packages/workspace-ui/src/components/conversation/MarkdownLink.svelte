<script lang="ts">
  import { localApi } from "@solus/client-core/local-api";
  import { serverConnections } from "@solus/client-core/server-connections";
  import { MessageCircleMore as ChatCircleDotsIcon, FileText as FileTextIcon, GitPullRequest as GitPullRequestIcon, PanelRight as PanelRightIcon } from "@lucide/svelte";
  import { getWorkspaceContext } from "../../contexts";
  import { toasts } from "../../lib/toasts";
  import { parseFileHref, requestFilePreview } from "../../lib/filePreview";
  import { routeForHref } from "../../lib/agent-links";
  import { FILE_ICON_VIEWBOX, getFileIconPath } from "../editor/fileIcons";
  import { tokenClassName } from "../editor/tokenStyle";
  import { faviconUrlForHref, isWebUrl } from "./lib/external-link";
  import { codeFileLinkLabel } from "./lib/assistant-markdown";
  import { fileLinkTooltip } from "./lib/file-link-path";
  import { assetUrlCache } from "../artifact/lib/asset-url";
  import { getMarkdownImageContext, markdownAssetId } from "./lib/markdown-image";
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
  const assetContext = getMarkdownImageContext();

  const isPlanRef = $derived(href.startsWith("plan://"));
  const isWorkRef = $derived(href.startsWith("work://"));
  const isPrRef = $derived(href.startsWith("pr://"));
  const sessionParams = $derived(parseSessionHref(href));
  const fileRef = $derived(parseFileHref(href));
  const assetId = $derived(markdownAssetId(href));
  let assetHref = $state("");

  $effect(() => {
    const currentAssetId = assetId;
    const serverId = assetContext?.serverId();
    const api = assetContext?.api();
    if (!currentAssetId || !serverId || !api) {
      assetHref = "";
      return;
    }
    let cancelled = false;
    void assetUrlCache.resolve({
      serverId,
      assetId: currentAssetId,
      name: text,
      origin: serverConnections.httpOriginFor(serverId),
      api,
      ctx: assetContext?.ctx(),
    }).then((url) => {
      if (!cancelled) assetHref = url;
    }).catch(() => {
      if (!cancelled) assetHref = "";
    });
    return () => {
      cancelled = true;
    };
  });
  const codeFileLabel = $derived(codeFileLinkLabel(text, fileRef?.line));
  // The same tab a click would preview against, so the tooltip names the
  // directory the link would actually open in.
  const fileLinkWorkingDirectory = $derived(
    session.sessionFor(session.focusedChatTabId ?? session.activeTabId)?.run
      .workingDirectory,
  );
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

  /** An ordinary web address with nowhere better to go. A plan, a work, a pull
   *  request, a session, a file, or a stored asset already has a destination,
   *  and a browser pane would be the worse one. */
  const isPlainWebLink = $derived(
    !(assetId || linkRoute || sessionParams || fileRef) && isWebUrl(href),
  );

  /** The host that would render it: the session that wrote the link, not the
   *  device showing it. A remote session's `localhost:5173` lives there. */
  const linkServerId = $derived(
    sessionLinkContext?.serverId() ?? session.fallbackServerId,
  );

  function openInSolusBrowser(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    void session.openUrlInBrowser(href, linkServerId).catch((error: Error) => {
      toasts.error("Couldn't open that page in the browser", {
        description: error.message,
      });
    });
  }

  function basename(path: string): string {
    const stripped = path.replace(/\/+$/, "");
    const idx = stripped.lastIndexOf("/");
    return idx === -1 ? stripped : stripped.slice(idx + 1);
  }

  function isMarkdownPath(path: string): boolean {
    return /\.(md|mdx|markdown)$/i.test(path.split(/[?#]/, 1)[0] ?? path);
  }

  function handleClick(e: MouseEvent) {
    if (assetId) {
      e.preventDefault();
      if (assetHref) localApi.openExternal(assetHref);
    } else if (linkRoute) {
      e.preventDefault();
      session.openRoute(linkRoute, {
        target: linkRoute.name === "task" ? "new" : "aside",
        sourceUrl:
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
  ><span class="solus-token__icon">
      {#if planStatus === "accepted"}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
      {:else if planStatus === "rejected"}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
      {:else}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/></svg>
      {/if}
</span><span>{@render children?.()}</span>
  </button>
{:else if isWorkRef && linkRoute}
  <button
    type="button"
    onclick={handleClick}
    class="{tokenClassName('work')} solus-token--output-link cursor-pointer"
    style="border:none"
  ><span class="solus-token__icon">
      <FileTextIcon size={12} />
</span><span>{@render children?.()}</span>
  </button>
{:else if isPrRef && linkRoute}
  <button
    type="button"
    onclick={handleClick}
    class="{tokenClassName('pr')} solus-token--output-link cursor-pointer"
    style="border:none"
  ><span class="solus-token__icon">
      <GitPullRequestIcon size={12} weight="bold" />
</span><span>{@render children?.()}</span>
  </button>
{:else if sessionParams}
  <button
    type="button"
    onclick={handleClick}
    class="{tokenClassName('session')} solus-token--output-link cursor-pointer"
    style="border:none"
  ><span class="solus-token__icon">
      <ChatCircleDotsIcon size={12} />
</span><span>{@render children?.()}</span>
  </button>
{:else if fileRef}
  <button
    type="button"
    class={`${tokenClassName("file", true)} solus-token--output-link solus-token--output-file-link`}
    title={fileLinkTooltip(fileRef.path, fileRef.line, fileLinkWorkingDirectory)}
    onclick={handleClick}
  ><span class="solus-token__icon">
      {#if isMarkdownPath(fileRef.path)}
        <FileTextIcon size={12} />
      {:else}
        <svg viewBox={FILE_ICON_VIEWBOX} fill="currentColor"><path d={getFileIconPath(basename(fileRef.path))} /></svg>
      {/if}
</span><span>{#if codeFileLabel !== null}{codeFileLabel}{:else}{@render children?.()}{/if}{#if fileRef.line}<span class="solus-token__line-number">:{fileRef.line}</span>{/if}</span>
  </button>
{:else}
  <!-- A plain click still hands the address to the user's own browser, as a
       link does everywhere else. The second destination is a control beside
       it: revealed on hover and keyboard focus, always present on touch. -->
  <span class="group/weblink relative inline">
    <a
      href={assetId ? assetHref || undefined : href}
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
    >{#if isPlainWebLink}<button
        type="button"
        class="ml-0.5 inline-flex size-4 translate-y-[0.1875rem] items-center justify-center rounded-[0.25rem] align-baseline text-(--solus-text-tertiary) opacity-0 transition-opacity pointer-events-none group-hover/weblink:pointer-events-auto group-hover/weblink:opacity-100 hover:bg-[var(--wash-2)] hover:text-(--solus-text-primary) focus-visible:pointer-events-auto focus-visible:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100"
        aria-label="Open in the Solus browser"
        title="Open in the Solus browser"
        onclick={openInSolusBrowser}
      ><PanelRightIcon class="size-3" /></button
      >{/if}</span
  >
{/if}
