<script lang="ts">
  import { onMount, untrack } from "svelte";
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
   * tooltip; the control stays as quiet as its neighbours. A session on a host
   * that is not linked shows the control disabled: live sharing needs the host
   * to send its later turns (docs/plans/cloud-sharing.md §6).
   */
  interface Props {
    serverId: string | null | undefined;
    resource: ShareResource | null;
    title: string;
    /** The caller's own action geometry, so the control reads as one of its header's. */
    class?: string;
  }
  let { serverId, resource, title, class: className = "" }: Props = $props();

  onMount(() => accountStore.start());
  $effect(() => {
    if (!accountStore.isSignedIn || !serverId || !resource) return;
    const targetServerId = serverId;
    const targetResource = { kind: resource.kind, id: resource.id };
    untrack(() => { void sharesStore.load(targetServerId, targetResource); });
  });

  const list = $derived(serverId && resource ? sharesStore.listFor(serverId, resource) : undefined);
  const summary = $derived(shareSummary(list));
  const shared = $derived(summary.scope !== null && summary.scope.kind !== "private");
  const canShare = $derived(!!serverId && !!resource && sharesStore.canShareFrom(serverId, resource.kind));
  const needsLink = $derived(resource?.kind === "session" && !canShare);
  const disabled = $derived(!accountStore.isSignedIn || needsLink);
  const label = $derived(!accountStore.isSignedIn ? "Sign in to share" : needsLink ? "Live sharing needs this computer linked" : summary.label);
</script>

{#if serverId && resource && (canShare || needsLink || (!accountStore.isSignedIn && resource.kind !== "task"))}
  <button
    type="button"
    class="{className} disabled:cursor-not-allowed disabled:opacity-45"
    data-testid="share-button"
    data-shared={shared ? "true" : undefined}
    {disabled}
    title={label}
    aria-label={label}
    onclick={() => sharesStore.open({ serverId, resource, title })}
  >
    <ShareIcon size={14} />
  </button>
{/if}
