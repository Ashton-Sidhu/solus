<script lang="ts">
  /** Dry run (docs/plans/webhooks.md §3.3): paste a sample request and see each
   *  filter result and rendered prompt. It starts nothing and stores nothing. */
  import type { WebhookDryRunRequest, WebhookDryRunResult } from "@solus/contracts/webhooks";
  import { webhooksStore } from "../../contexts/webhooks/webhooks.store.svelte";
  import { Button } from "../ui/button";
  import { Textarea } from "../ui/textarea";
  import { Switch } from "../ui/switch";
  import WebhookActionResults from "./WebhookActionResults.svelte";
  import { actionsFromDraft, parseHeaderLines, type ActionDraft } from "./lib/webhook-draft";
  import { verificationFailureText } from "./lib/webhook-deliveries";

  let { serverId, webhookId, actions }: { serverId: string; webhookId: string | null; actions: ActionDraft[] } = $props();

  let body = $state("");
  let headers = $state("");
  let verify = $state(false);
  let result = $state<WebhookDryRunResult | null>(null);
  let error = $state("");
  let isRunning = $state(false);

  async function run() {
    const parsed = actionsFromDraft(actions);
    if (!parsed.ok) {
      error = parsed.error;
      return;
    }
    isRunning = true;
    error = "";
    try {
      const request: WebhookDryRunRequest = {
        actions: parsed.value,
        sample: { method: "POST", headers: parseHeaderLines(headers), query: [], body, verify: verify && webhookId !== null },
      };
      if (webhookId) request.webhookId = webhookId;
      result = await webhooksStore.dryRun(serverId, request);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : "The dry run failed.";
    } finally {
      isRunning = false;
    }
  }
</script>

<section class="flex flex-col gap-3">
  <h3 class="text-base font-medium">Dry run</h3>
  <p class="text-sm text-muted-foreground">Paste a sample request. Solus shows each filter result and each prompt. It starts nothing and stores nothing.</p>
  <label class="flex flex-col gap-1">
    <span class="text-xs text-muted-foreground">Headers, one for each line, as Name: value</span>
    <Textarea bind:value={headers} dictation={false} rows={3} class="font-mono text-xs" aria-label="Sample headers" />
  </label>
  <label class="flex flex-col gap-1">
    <span class="text-xs text-muted-foreground">Body</span>
    <Textarea bind:value={body} dictation={false} rows={6} class="font-mono text-xs" aria-label="Sample body" />
  </label>
  {#if webhookId}
    <label class="flex items-center gap-2 text-sm">
      <Switch bind:checked={verify} aria-label="Check verification" />
      Check verification too. This is useful only with a real signed request.
    </label>
  {/if}
  <Button size="sm" variant="outline" class="self-start" disabled={isRunning} onclick={() => void run()}>
    {isRunning ? "Running…" : "Run dry run"}
  </Button>
  {#if error}<p class="text-sm text-destructive">{error}</p>{/if}
  {#if result}
    {#if result.verification}
      <p class="text-sm {result.verification.ok ? 'text-muted-foreground' : 'text-destructive'}">
        {result.verification.ok ? "Verification passed." : verificationFailureText(result.verification.failure)}
      </p>
    {/if}
    <WebhookActionResults results={result.actions} />
  {/if}
</section>
