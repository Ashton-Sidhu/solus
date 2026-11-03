<script lang="ts">
  /** The organization's hosts and the host policy it assigned to each
   *  (plans/030 §3, §7). A host whose settings another organization manages
   *  names that organization and takes only a policy without host settings. */
  import { ChevronDown as CaretDownIcon } from "@lucide/svelte";
  import type { HostPolicySummary, PolicyHost } from "@solus/contracts/policy-api";
  import { requestInputFocus } from "../../../lib/inputFocus";
  import { Button } from "../../ui/button";
  import * as DropdownMenu from "../../ui/dropdown-menu";
  import SettingsRow from "../SettingsRow.svelte";
  import { assignableHostPolicies, policyHostDetail } from "./lib/policy-editor";

  interface Props {
    organizationId: string;
    hosts: readonly PolicyHost[];
    policies: readonly HostPolicySummary[];
    canManage: boolean;
    /** The host whose assignment is in flight. */
    assigning: string | null;
    onAssign: (hostId: string, policyId: string | null) => void;
  }

  let { organizationId, hosts, policies, canManage, assigning, onAssign }: Props = $props();
</script>

{#if hosts.length === 0}
  <p class="px-4 py-3 text-workspace-chrome text-muted-foreground">No host is shared with this organization yet.</p>
{/if}
{#each hosts as host (host.hostId)}
  {@const choices = assignableHostPolicies(host, organizationId, policies)}
  <SettingsRow label={host.label} description={policyHostDetail(host, organizationId, policies)}>
    {#snippet control()}
      <DropdownMenu.Root onOpenChange={(next) => { if (!next) requestInputFocus(); }}>
        <DropdownMenu.Trigger>
          {#snippet child({ props })}
            <Button
              {...props}
              variant="outline"
              size="sm"
              aria-label={`Host policy for ${host.label}`}
              disabled={!canManage || assigning !== null}
              class="min-w-36 justify-between gap-1.5 font-normal"
            >
              <span class="truncate">
                {assigning === host.hostId ? "Saving…" : policies.find((policy) => policy.policyId === host.policyId)?.name ?? "None"}
              </span>
              <CaretDownIcon size={14} class="-me-1 shrink-0 text-muted-foreground opacity-80" />
            </Button>
          {/snippet}
        </DropdownMenu.Trigger>
        <DropdownMenu.Content side="bottom" align="end" sideOffset={6} class="w-[min(22rem,calc(100vw-2rem))]">
          <DropdownMenu.RadioGroup value={host.policyId ?? ""}>
            <DropdownMenu.RadioItem value="" onSelect={() => onAssign(host.hostId, null)}>None</DropdownMenu.RadioItem>
            {#each choices as choice (choice.policyId)}
              <DropdownMenu.RadioItem
                value={choice.policyId}
                disabled={choice.blockedReason !== null}
                onSelect={() => onAssign(host.hostId, choice.policyId)}
              >
                <div class="flex min-w-0 flex-col">
                  <span class="truncate">{choice.name}</span>
                  {#if choice.blockedReason}
                    <span class="text-xs text-muted-foreground">{choice.blockedReason}</span>
                  {/if}
                </div>
              </DropdownMenu.RadioItem>
            {/each}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    {/snippet}
  </SettingsRow>
{/each}
