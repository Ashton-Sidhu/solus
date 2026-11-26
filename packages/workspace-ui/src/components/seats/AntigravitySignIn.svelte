<script lang="ts">
  /**
   * How an Antigravity seat signs in: a Google account or Gemini Enterprise in
   * the browser, or a pasted Gemini API key or Vertex AI credential
   * (docs/plans/antigravity-provider.md §7). The relayed browser steps show in
   * `SignInSteps`, as for Claude and Codex.
   */
  import { seatsStore } from "../../contexts/seats/seats.store.svelte";
  import { Button } from "../ui/button";
  import { Input } from "../ui/input";
  import {
    ANTIGRAVITY_CREDENTIAL_PLACEHOLDERS,
    ANTIGRAVITY_METHODS,
    antigravityActionOf,
    antigravityChoice,
    type AntigravityMethod,
  } from "./lib/antigravity-sign-in";

  interface Props {
    serverId: string;
    /** The label of the button that starts a browser sign-in. */
    startLabel: string;
    autofocus?: boolean;
  }

  let { serverId, startLabel, autofocus = false }: Props = $props();

  let method = $state<AntigravityMethod>("oauth-personal");
  let gcpProject = $state("");
  let gcpLocation = $state("global");
  let credential = $state("");

  const choice = $derived(antigravityChoice(method));
  const action = $derived(antigravityActionOf({ method, gcpProject, gcpLocation, credential }));
  const busy = $derived(seatsStore.isBusy(serverId, "antigravity"));

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (action.kind === "browser") await seatsStore.connect(serverId, "antigravity", action.signIn);
    else if (action.kind === "credential") {
      await seatsStore.connectToken(serverId, "antigravity", action.token, action.credential);
      credential = "";
    }
  }
</script>

<form class="flex flex-col gap-3" onsubmit={submit}>
  <fieldset class="flex flex-col gap-1.5">
    <legend class="mb-1 text-xs text-(--solus-text-tertiary)">Sign in with</legend>
    {#each ANTIGRAVITY_METHODS as option (option.id)}
      <label class="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 hover:bg-(--solus-surface-hover) has-[:checked]:bg-(--solus-surface-hover) pointer-coarse:min-h-11">
        <input type="radio" name="antigravity-method" value={option.id} bind:group={method} class="mt-0.5 accent-(--solus-accent)" disabled={busy} />
        <span class="flex min-w-0 flex-col">
          <span class="text-sm text-(--solus-text-primary)">{option.label}</span>
          <span class="text-xs text-pretty text-(--solus-text-tertiary)">{option.detail}</span>
        </span>
      </label>
    {/each}
  </fieldset>

  {#if choice.needsCloudProject}
    <div class="flex flex-wrap gap-2">
      <Input bind:value={gcpProject} class="h-8 min-w-0 flex-1 font-mono" placeholder="Google Cloud project id" aria-label="Google Cloud project id" dictation={false} disabled={busy} />
      <Input bind:value={gcpLocation} class="h-8 w-36 font-mono" placeholder="Location" aria-label="Google Cloud location" dictation={false} disabled={busy} />
    </div>
  {/if}

  {#if !choice.usesBrowser && (method === "gemini-api-key" || method === "agent-platform")}
    <Input
      bind:value={credential}
      class="h-8 min-w-0 font-mono"
      placeholder={ANTIGRAVITY_CREDENTIAL_PLACEHOLDERS[method]}
      aria-label="Antigravity credential"
      dictation={false}
      disabled={busy}
      {autofocus}
    />
  {/if}

  {#if action.kind === "incomplete" && action.message}
    <p class="text-xs text-(--solus-status-error)" role="alert">{action.message}</p>
  {/if}

  <div>
    <Button type="submit" size="sm" class="pointer-coarse:min-h-11" disabled={action.kind === "incomplete" || busy}>
      {busy ? "Starting…" : choice.usesBrowser ? startLabel : "Save"}
    </Button>
  </div>
</form>
