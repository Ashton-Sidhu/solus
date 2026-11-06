<script lang="ts">
  /** The Run on list's Auto balance row. It is its own chunk, with the balance
   *  code it reads: only a person with Auto balance on loads it. */
  import { Check as CheckIcon, Scale as AutoBalanceIcon } from "@lucide/svelte";
  import { getWorkspaceContext } from "../../contexts";
  import { draftBalanceCandidates } from "../../contexts/workspace/draft-balancer";
  import type { SessionDraft } from "../../contexts/workspace/session-draft.svelte";
  import * as DropdownMenu from "../ui/dropdown-menu";

  interface Props {
    draft: SessionDraft;
  }

  let { draft }: Props = $props();

  const workspace = getWorkspaceContext();
  const canBalance = $derived(draftBalanceCandidates(workspace.settings, draft.run).length >= 2);

  function choose() {
    workspace.drafts.balance(draft, (balancer) => balancer.check(draft));
  }
</script>

{#if canBalance}
  <DropdownMenu.Item onSelect={choose}>
    <AutoBalanceIcon size={14} class="shrink-0 text-(--solus-text-tertiary)" />
    <span class="min-w-0 flex-1 truncate">{draft.balance === "unavailable" ? "Auto balance unavailable" : "Auto balance"}</span>
    {#if draft.balance === "chosen"}
      <CheckIcon size={14} class="shrink-0 text-(--solus-accent)" />
    {/if}
  </DropdownMenu.Item>
{/if}
