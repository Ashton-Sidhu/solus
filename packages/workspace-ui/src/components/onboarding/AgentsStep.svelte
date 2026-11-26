<script lang="ts">
  /**
   * The Agents step on desktop and in a browser paired to a host: the host's
   * own Claude Code and Codex logins, through the same setup session Settings
   * uses. These logins stay on the host, also in the desktop account flow:
   * cloud hosts sign in on their own (docs/plans/one-page-onboarding.md
   * decision 7). A sign-in relays the CLI's output into the terminal panel.
   */
  import { onMount } from "svelte";
  import { localApi } from "@solus/client-core/local-api";
  import { ArrowUpRight as ExternalIcon } from "@lucide/svelte";
  import { Button } from "../ui/button";
  import { Input } from "../ui/input";
  import { TerminalOutput } from "../ui/terminal-output";
  import { codingProviderRows } from "../servers/lib/host-onboarding";
  import AgentRow from "./AgentRow.svelte";
  import { agentRow, signInTerminalText } from "./lib/agent-rows";
  import { onboardingStore as store } from "./onboarding.store.svelte";
  import type { SetupAgent } from "@solus/contracts/types";

  let { machineNoun }: { machineNoun: string } = $props();

  const setup = $derived(store.setup);
  const rows = $derived(
    codingProviderRows({
      readiness: setup.readiness,
      stages: setup.providerStages,
      add: (agent, options) => void setup.addProvider(agent, options),
    }),
  );
  const codes = $state<Partial<Record<SetupAgent, string>>>({});

  onMount(() => {
    setup.retain();
    // A remote client's host can settle after the probe `start()` made.
    if (!setup.readiness && !setup.readinessLoading) void setup.refreshReadiness();
    return () => setup.release();
  });

  function submitCode(event: SubmitEvent, agent: SetupAgent) {
    event.preventDefault();
    const code = codes[agent]?.trim();
    if (code) void setup.submitAgentSignInCode(agent, code);
  }
</script>

{#if setup.readinessError && !setup.readiness}
  <div class="flex min-h-12 items-center gap-3.5">
    <span class="w-5 shrink-0"></span>
    <p class="m-0 min-w-0 flex-1 text-[13px] leading-4.5 text-(--solus-status-error)" role="alert">Could not check this {machineNoun}: {setup.readinessError}</p>
    <Button variant="outline" size="sm" class="h-7.5 rounded-md px-3 text-[13px]" onclick={() => void setup.refreshReadiness()}>Try again</Button>
  </div>
{:else}
  {#each rows as row (row.id)}
    {@const agent = row.id as SetupAgent}
    {@const verification = setup.verificationFor(agent)}
    {@const view = agentRow({ row, verification, machineNoun })}
    {@const failure = setup.stepError?.provider === agent ? setup.stepError.message : null}
    <AgentRow {agent} name={row.label} detail={failure ?? view.detail} trailing={view.trailing} onaction={row.run}>
      {#if verification}
        <div class="flex flex-col gap-2 pb-2 pl-8.5">
          <TerminalOutput label="{row.label} sign-in on this {machineNoun}" output={signInTerminalText(agent, verification)} active class="max-h-40" />
          {#if verification.requiresCodeInput}
            <form class="flex gap-2" onsubmit={(event) => submitCode(event, agent)}>
              <Input bind:value={codes[agent]} placeholder="Paste code" aria-label="{row.label} sign-in code" class="h-8 flex-1 font-mono text-[13px]" autocomplete="off" spellcheck={false} />
              <Button type="submit" variant="outline" class="h-8 rounded-md px-3 text-[13px]">Connect</Button>
            </form>
          {/if}
          <div class="flex items-center gap-1.5 text-[13px] leading-4.5 text-(--solus-text-tertiary)">
            Browser didn’t open?
            <button
              type="button"
              class="inline-flex items-center gap-0.5 rounded-sm font-medium text-(--solus-text-primary) underline decoration-1 underline-offset-2 focus-visible:outline-2 focus-visible:outline-ring"
              onclick={() => void localApi.openExternal(verification.verificationUrl)}
            >Open the sign-in page <ExternalIcon size={12} /></button>
            <span class="flex-1"></span>
            <button
              type="button"
              class="rounded-sm hover:text-(--solus-text-primary) focus-visible:outline-2 focus-visible:outline-ring"
              onclick={() => void setup.cancelAgentSignIn(agent)}
            >Cancel</button>
          </div>
        </div>
      {/if}
    </AgentRow>
  {/each}
{/if}
