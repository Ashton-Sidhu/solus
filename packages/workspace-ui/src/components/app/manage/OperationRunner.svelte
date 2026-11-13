<script lang="ts">
  import type { AppOperation } from "@solus/contracts/apps";
  import { appsStore } from "../../../contexts/apps/apps.store.svelte";
  import { requestInputFocus } from "../../../lib/inputFocus";
  import { Button } from "../../ui/button";
  import { Textarea } from "../../ui/textarea";
  import { jsonText, operationInput, runOperation } from "./lib/operations";

  /** The form that runs one operation with a JSON input (docs/plans/apps.md §9.2), and shows its value or its error. */
  interface Props {
    serverId: string;
    appId: string;
    operation: AppOperation;
    /** Why the operation cannot run now; null when it can. */
    refusal: string | null;
  }
  let { serverId, appId, operation, refusal }: Props = $props();

  let inputText = $state("");
  let isRunning = $state(false);
  let outcome = $state<{ ok: true; value: string } | { ok: false; error: string } | null>(null);

  async function run() {
    if (isRunning) return;
    const input = operationInput(inputText);
    if (!input.ok) {
      outcome = input;
      return;
    }
    isRunning = true;
    outcome = null;
    const hostId = serverId;
    const id = appId;
    try {
      const value = await runOperation((name, argumentsJson) => appsStore.call(hostId, id, name, argumentsJson), operation.name, input.value);
      outcome = { ok: true, value: jsonText(value) };
    } catch (cause) {
      outcome = { ok: false, error: cause instanceof Error ? cause.message : "The call failed." };
    } finally {
      isRunning = false;
      requestInputFocus();
    }
  }
</script>

<div class="flex min-w-0 flex-col gap-2" data-testid="app-operation-runner">
  <label class="flex flex-col gap-1">
    <span class="text-xs text-muted-foreground">Input, as a JSON object (empty sends an empty object)</span>
    <Textarea bind:value={inputText} rows={3} dictation={false} disabled={isRunning} spellcheck={false} class="font-mono text-xs" aria-label="Input of {operation.name}" placeholder={"{}"} />
  </label>
  <div class="flex flex-wrap items-center gap-2">
    <Button size="xs" disabled={isRunning || refusal !== null} onclick={() => void run()}>{isRunning ? "Running…" : operation.kind === "query" ? "Run the query" : "Run the mutation"}</Button>
    {#if refusal}
      <span class="text-xs text-muted-foreground">{refusal}</span>
    {:else if operation.kind === "mutation"}
      <span class="text-xs text-muted-foreground">A mutation changes the data of the app.</span>
    {/if}
  </div>
  {#if outcome?.ok}
    <pre class="m-0 max-h-72 overflow-auto rounded-md bg-muted/50 p-2 font-mono text-xs whitespace-pre" aria-label="Value" data-testid="app-operation-value">{outcome.value}</pre>
  {:else if outcome}
    <p class="m-0 text-xs text-destructive text-pretty" role="alert">{outcome.error}</p>
  {/if}
</div>
