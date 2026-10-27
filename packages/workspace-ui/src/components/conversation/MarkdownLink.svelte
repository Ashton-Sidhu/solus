<script lang="ts">
  import { localApi } from "@solus/client-core/local-api";
  import { serverConnections } from "@solus/client-core/server-connections";
  import { MessageCircleMore as ChatCircleDotsIcon, FileText as FileTextIcon, GitPullRequest as GitPullRequestIcon } from "@lucide/svelte";
  import { getClientShellContext, getSurfaceContext } from "../../contexts";
  import { filePreviewMediaKind, parseFileHref, requestFilePreview } from "../../lib/filePreview";
  import { routeForHref } from "../../lib/agent-links";
  import { hoverIntent } from "../../lib/hover-intent";
  import { FILE_ICON_VIEWBOX, getFileIconPath } from "../editor/fileIcons";
  import { tokenClassName } from "../editor/tokenStyle";
  import { faviconUrlForHref } from "./lib/external-link";
  import { codeFileLinkLabel } from "./lib/assistant-markdown";
  import { fileLinkTooltip } from "./lib/file-link-path";
  import { assetUrlCache } from "../artifact/lib/asset-url";
  import { getMarkdownImageContext, markdownAssetId } from "./lib/markdown-image";
  import { parseSessionHref } from "@solus/contracts/session-link";
  import { resolveSessionLinkMeta } from "./lib/session-link";
  import { getSessionLinkContext } from "./lib/session-link-context";
  import type { Snippet } from "svelte";
  import { checkoutPlace } from "../../contexts/workspace/run-location";
  import { hostPathBaseName } from "@solus/contracts/host-path";

  interface Props {
    href?: string;
    title?: string;
    text?: string;
    /** An image embed keeps file-chip styling for web URLs and stored assets too. */
    fileChip?: boolean;
    children?: Snippet;
  }
  let { href = "", title = undefined, text = undefined, children, fileChip = false }: Props = $props();

  type Status = "pending" | "accepted" | "rejected";

  const VARIANT_FOR = {
    pending: "plan-pending",
    accepted: "plan-accepted",
    rejected: "plan-rejected",
  } satisfies Record<Status, "plan-pending" | "plan-accepted" | "plan-rejected">;

  // A link to a plan, a session, or a file opens in the workspace; a client
  // with none (the cloud console) opens a work or a task at its own page and
  // shows the rest as text.
  const session = getSurfaceContext().workspace;
  const shell = getClientShellContext();
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
    if (!currentAssetId || !serverId || !api || filePreviewMediaKind(href)) {
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
    checkoutPlace(session?.sessionFor(session.focusedChatTabId ?? session.activeTabId)?.run)?.path,
  );
  // The destination comes from the codec; only the chip's own decoration is
  // read off the href here, and a plan's approval status is the whole of it.
  const linkRoute = $derived(
    routeForHref(href, { title, serverId: sessionLinkContext?.serverId() }),
  );
  // A GitHub link carries the page to fall back to; a `pr://` link has none.
  const prSourceUrl = $derived(
    linkRoute?.name === "prReview" && /^https:\/\//i.test(href) ? href : undefined,
  );
  const warmPrLink = $derived(
    session && linkRoute?.name === "prReview"
      ? hoverIntent(() => session.warmRoute(linkRoute, { sourceUrl: prSourceUrl }))
      : undefined,
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

  function isMarkdownPath(path: string): boolean {
    return /\.(md|mdx|markdown)$/i.test(path.split(/[?#]/, 1)[0] ?? path);
  }

  function handleClick(e: MouseEvent) {
    const mediaKind = filePreviewMediaKind(fileRef?.path ?? href) ?? (fileChip ? "image" : null);
    if (mediaKind && session) {
      e.preventDefault();
      requestFilePreview({
        path: fileRef?.path ?? href,
        mediaKind,
        tabId: session.focusedChatTabId ?? session.activeTabId,
        source: { serverId: assetContext?.serverId(), cwd: assetContext?.cwd(), ctx: assetContext?.ctx() },
      });
    } else if (assetId) {
      e.preventDefault();
      if (assetHref) localApi.openExternal(assetHref);
    } else if (linkRoute) {
      e.preventDefault();
      if (session) {
        session.openRoute(linkRoute, { sourceUrl: prSourceUrl });
      } else if (linkRoute.name === "work") {
        shell.openResource({ kind: "work", workId: linkRoute.params.workId, serverId: linkRoute.params.serverId });
      } else if (linkRoute.name === "task") {
        shell.openResource({ kind: "task", taskId: linkRoute.params.taskId, serverId: linkRoute.params.serverId });
      }
    } else if (sessionParams) {
      e.preventDefault();
      if (!session) return;
      void resolveSessionLinkMeta(sessionParams, sessionLinkContext?.serverId()).then((meta) =>
        session.opening.resumeSession(meta),
      );
    } else if (fileRef) {
      e.preventDefault();
      if (!session) return;
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
    class={tokenClassName(VARIANT_FOR[planStatus])}
  ><span class="solus-token__icon">
      {#if planStatus === "accepted"}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
      {:else if planStatus === "rejected"}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
      {:else}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/></svg>
      {/if}
</span><span>{@render children?.()}</span>
  </button>
{:else if isWorkRef && linkRoute}
  <button
    type="button"
    onclick={handleClick}
    class={tokenClassName('work')}
  ><span class="solus-token__icon">
      <FileTextIcon size={12} />
</span><span>{@render children?.()}</span>
  </button>
{:else if isPrRef && linkRoute}
  <button
    type="button"
    onclick={handleClick}
    {@attach warmPrLink}
    class={tokenClassName('pr')}
  ><span class="solus-token__icon">
      <GitPullRequestIcon size={12} weight="bold" />
</span><span>{@render children?.()}</span>
  </button>
{:else if sessionParams}
  <button
    type="button"
    onclick={handleClick}
    class={tokenClassName('session')}
  ><span class="solus-token__icon">
      <ChatCircleDotsIcon size={12} />
</span><span>{@render children?.()}</span>
  </button>
{:else if fileRef || fileChip}
  <button
    type="button"
    class={tokenClassName("file", true)}
    title={fileRef ? fileLinkTooltip(fileRef.path, fileRef.line, fileLinkWorkingDirectory) : title ?? href}
    onclick={handleClick}
  ><span class="solus-token__icon">
      {#if isMarkdownPath(fileRef?.path ?? href)}
        <FileTextIcon size={12} />
      {:else}
        <svg viewBox={FILE_ICON_VIEWBOX} fill="currentColor"><path d={getFileIconPath(hostPathBaseName(fileRef?.path ?? text ?? href))} /></svg>
      {/if}
</span><span>{#if codeFileLabel !== null}{codeFileLabel}{:else}{@render children?.()}{/if}{#if fileRef?.line}<span class="solus-token__line-number">:{fileRef.line}</span>{/if}</span>
  </button>
{:else}
  {#snippet linkContents()}
    {#if faviconUrl && failedFaviconUrl !== faviconUrl}<img
      class="solus-link__favicon"
      src={faviconUrl}
      alt=""
      width="12"
      height="12"
      loading="lazy"
      referrerpolicy="no-referrer"
      onerror={() => (failedFaviconUrl = faviconUrl)}
    />{/if}{@render children?.()}
  {/snippet}
  <a href={assetId ? assetHref || undefined : href} {title} class="solus-link" onclick={handleClick} {@attach warmPrLink}>
    {@render linkContents()}
  </a>
{/if}
