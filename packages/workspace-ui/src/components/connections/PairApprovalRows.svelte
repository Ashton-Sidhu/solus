<script lang="ts">
  /** The open approval requests of one host (docs/plans/add-machine-card.md),
   *  as rows of the host's pairing card: machines that ask to pair without a
   *  code. The owner compares the check code with the one the other machine
   *  shows, then approves or denies. A request expires on its own. Shown to a
   *  principal with `host.local.reach`. */
  import { Monitor as MonitorIcon } from "@lucide/svelte";
  import { pairApprovalsStore } from "../../contexts";
  import { countdown } from "../../lib/countdown";
  import { liveActivityClock } from "../../lib/shared-clock";
  import SettingsRow from "../settings/SettingsRow.svelte";
  import { Button } from "../ui/button";

  interface Props {
    serverId: string;
  }
  let { serverId }: Props = $props();

  const held = $derived(pairApprovalsStore.forHost(serverId));
  const approvals = $derived(held?.approvals ?? []);
  const summary = $derived.by(() => {
    if (!held || (held.state === "loading" && approvals.length === 0)) return "Reading approval requests…";
    if (approvals.length === 0) return "No machine asks to pair with this host. A machine that asks without a code shows here.";
    return "Approve a machine only if it shows the same check code.";
  });

  $effect(() => {
    void pairApprovalsStore.load(serverId);
  });

  let now = $state(Date.now());
  $effect(() => {
    if (approvals.length === 0) return;
    now = Date.now();
    return liveActivityClock.subscribe((value) => { now = value; });
  });
</script>

<SettingsRow label="Approval requests" description={summary} />
{#if held?.state === "error" && approvals.length === 0}
  <p role="alert" class="px-4 py-3 text-chrome-dense text-(--solus-status-error)">{held.error}</p>
{/if}
{#each approvals as approval (approval.requestId)}
  {@const isDeciding = pairApprovalsStore.deciding.has(approval.requestId)}
  {@const isExpired = approval.expiresAt <= now}
  <div class="flex items-center gap-3 px-4 py-2.5">
    <MonitorIcon size={16} class="shrink-0 text-foreground" />
    <div class="min-w-0 flex-1">
      <p class="truncate text-workspace-chrome font-medium text-(--solus-text-primary)">{approval.deviceLabel}</p>
      <p class="truncate text-chrome-dense text-(--solus-text-tertiary)">
        {approval.fromAddress} · {isExpired ? "Expired" : `${countdown(approval.expiresAt - now)} left`}
      </p>
    </div>
    <code class="shrink-0 font-mono text-workspace-chrome font-medium tracking-[0.06em] text-(--solus-text-primary)" aria-label="Check code {approval.checkCode}">{approval.checkCode}</code>
    <div class="flex shrink-0 items-center gap-1">
      <Button
        variant="ghost"
        size="sm"
        disabled={isDeciding || isExpired}
        aria-label="Deny {approval.deviceLabel}"
        onclick={() => void pairApprovalsStore.decide(serverId, approval.requestId, "deny")}
      >Deny</Button>
      <Button
        size="sm"
        disabled={isDeciding || isExpired}
        aria-label="Approve {approval.deviceLabel}"
        onclick={() => void pairApprovalsStore.decide(serverId, approval.requestId, "approve")}
      >Approve</Button>
    </div>
  </div>
{/each}
