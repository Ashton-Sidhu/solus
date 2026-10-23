<script lang="ts">
  import { untrack } from "svelte";
  import { Share as ShareIcon } from "@lucide/svelte";
  import type { ShareResource } from "@solus/contracts/sharing";
  import { accountStore, sharesStore } from "../../contexts";
  import { shareSummary } from "./lib/share-rows";

  /**
   * The Share control (docs/plans/multiplayer-sharing.md §4.4): present wherever the
   * resource can be shared (`sharesStore.canShareFrom`), and shaped like the header it sits
   * in. Every header that carries it — the session band, the task chrome bar,
   * the work header — is a row of glyphs, so the control is a glyph: the one
   * share glyph every Share entry point uses. The count and the state ride the
   * tooltip; the control stays as quiet as its neighbours. A session is shared
   * from its host with no sign-in; a work is pushed to the cloud by this button,
   * which needs one (docs/plans/host-sharing.md §2).
   */
  interface Props {
    serverId: string | null | undefined;
    resource: ShareResource | null;
    title: string;
    /** The caller's own action geometry, so the control reads as one of its header's. */
    class?: string;
    /** Render the word beside the glyph. Off, the control is a glyph alone. */
    labelled?: boolean;
  }
  let { serverId, resource, title, class: className = "", labelled = false }: Props = $props();

  $effect(() => {
    if (!serverId || !resource) return;
    const targetServerId = serverId;
    const targetResource = { kind: resource.kind, id: resource.id };
    untrack(() => { void sharesStore.load(targetServerId, targetResource); });
  });

  const list = $derived(serverId && resource ? sharesStore.listFor(serverId, resource) : undefined);
  const summary = $derived(shareSummary(list));
  const shared = $derived(summary.scope !== null && summary.scope.kind !== "private");
  const canShare = $derived(!!serverId && !!resource && sharesStore.canShareFrom(serverId, resource.kind));
  const needsSignIn = $derived(resource?.kind === "work" && !canShare && !accountStore.isSignedIn);
  const label = $derived(needsSignIn ? "Sign in to share" : summary.label);
</script>

{#if serverId && resource && (canShare || needsSignIn)}
  <button
    type="button"
    class="{className} disabled:cursor-not-allowed disabled:opacity-45"
    data-testid="share-button"
    data-shared={shared ? "true" : undefined}
    disabled={needsSignIn}
    title={label}
    aria-label={label}
    onclick={() => sharesStore.open({ serverId, resource, title })}
  >
    <ShareIcon size={14} />
    {#if labelled}<span>Share</span>{/if}
  </button>
{/if}
