<script lang="ts">
  /**
   * The host refused to start this person's turn under the organization model
   * (plan 004 step 11). Nothing ran and the draft is back in the composer, so
   * the card says which organization the turn needs and offers the one thing
   * that fixes it here — choose the organization, or sign in — and then steps
   * aside for the send. Only the refused person sees it, like the seat card.
   */
  import { Building2 as OrganizationIcon, X as XIcon } from "@lucide/svelte";
  import { accountStore } from "../../contexts/account/account.store.svelte";
  import { serversStore } from "../../contexts/connections/servers.store.svelte";
  import { turnRefusalStore } from "../../contexts/connections/turn-refusal.store.svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import AttentionCard from "../conversation/AttentionCard.svelte";
  import TranscriptCardAction from "../conversation/TranscriptCardAction.svelte";
  import { turnRefusalCopy } from "./lib/turn-refusal-copy";

  const refused = $derived(turnRefusalStore.refused);
  const copy = $derived(refused
    ? turnRefusalCopy(refused.code, { signedIn: accountStore.isSignedIn, activeOrganization: serversStore.activeOrganizationName })
    : null);
  // Sign-in runs in the client shell; a browser has none, so it keeps the hint alone.
  const canSignIn = $derived(copy?.action === "sign-in" && accountStore.isAvailable);
  const organizations = $derived(copy?.action === "choose-organization" ? serversStore.organizations.filter((organization) => !organization.isActive) : []);

  let cardEl = $state<HTMLDivElement | null>(null);

  function dismiss() {
    turnRefusalStore.dismiss();
    requestInputFocus();
  }

  function workIn(organizationId: string) {
    serversStore.selectOrganization(organizationId);
    dismiss();
  }

  async function signIn() {
    await accountStore.signIn();
    requestInputFocus();
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key !== "Escape") return;
    if (!(event.target instanceof Node) || !cardEl?.contains(event.target)) return;
    event.preventDefault();
    dismiss();
  }
</script>

<svelte:window onkeydown={handleKeydown} />

{#if refused && copy}
  <div bind:this={cardEl}>
    <AttentionCard title={copy.title} type="turn not started" testId="turn-refusal-card">
      {#snippet icon()}<OrganizationIcon />{/snippet}

      {#snippet actions()}
        {#if canSignIn}
          <TranscriptCardAction kind="filled" onclick={signIn}>Sign in</TranscriptCardAction>
        {/if}
        <TranscriptCardAction kind="icon" label="Dismiss" onclick={dismiss}>
          <XIcon size={13} />
        </TranscriptCardAction>
      {/snippet}

      <p class="m-0 text-(--muted-foreground)">{refused.message} {copy.hint}</p>
      {#if organizations.length > 0}
        <div class="flex flex-wrap gap-1.5">
          {#each organizations.slice(0, 3) as organization (organization.organizationId)}
            <TranscriptCardAction kind="primary" data-testid="turn-refusal-organization" onclick={() => workIn(organization.organizationId)}>
              Work in {organization.name}
            </TranscriptCardAction>
          {/each}
        </div>
      {/if}
    </AttentionCard>
  </div>
{/if}
