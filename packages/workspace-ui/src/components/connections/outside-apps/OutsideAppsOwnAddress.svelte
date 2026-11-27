<script lang="ts">
  /** "Your own address" (plans/035 §0.8): the https address of the person's
   *  own ingress, a reverse proxy or a tunnel of their own, saved to the host
   *  setting `publicAddress`, then tested from outside as an app would reach
   *  it. Only a person who may change the host's settings (`host.admin`) sees
   *  this form; the address card says whom to ask otherwise. Cancel drops the
   *  draft and closes the form; a save that lands closes it too, and the card
   *  shows the address and its test. */
  import { onMount } from "svelte";
  import { connectionsStore } from "../../../contexts";
  import { hostSettingsStore } from "../../../contexts/app/host-settings.store.svelte";
  import { Button } from "../../ui/button";
  import { Input } from "../../ui/input";
  import { publicAddressProblem } from "../lib/app-addresses";
  import { outsideApps } from "./outside-apps.svelte";

  interface Props {
    serverId: string;
    /** Closes the form: after Cancel, and after a save that landed. */
    onDone: () => void;
  }

  let { serverId, onDone }: Props = $props();

  let fieldEl = $state<HTMLInputElement | null>(null);
  const settings = $derived(hostSettingsStore.states.get(serverId));
  const saved = $derived(settings?.publicAddress ?? "");
  const localOrigin = $derived.by(() => {
    const localUrl = connectionsStore.appEndpointFor(serverId)?.localUrl;
    return localUrl && URL.canParse(localUrl) ? new URL(localUrl).origin : null;
  });
  const test = $derived(connectionsStore.appAddressTestsFor(serverId).custom);

  // A draft of the field; null shows the saved value.
  let draft = $state<string | null>(null);
  const value = $derived(draft ?? saved);
  const problem = $derived(draft === null ? null : publicAddressProblem(draft));
  // An empty field is not a save: the card's Remove takes the address away.
  const canSave = $derived(draft !== null && draft.trim() !== "" && draft.trim() !== saved && !problem);
  const isBusy = $derived(!!settings?.saving || test?.kind === "running");

  onMount(() => fieldEl?.focus());

  async function save() {
    if (!canSave || draft === null || !settings || isBusy) return;
    if (await outsideApps.saveAndTestPublicAddress(serverId, draft)) onDone();
  }

  function cancel() {
    draft = null;
    onDone();
  }
</script>

<form
  class="flex flex-col gap-2"
  onsubmit={(event) => { event.preventDefault(); void save(); }}
  onkeydown={(event) => { if (event.key === "Escape") { event.preventDefault(); cancel(); } }}
>
  <label for="outside-apps-own-address-{serverId}" class="text-[0.8125rem] leading-4 font-medium text-(--solus-text-primary)">Your https address</label>
  <div class="flex min-w-0 flex-wrap items-center gap-2">
    <Input
      id="outside-apps-own-address-{serverId}"
      bind:ref={fieldEl}
      type="url"
      inputmode="url"
      autocomplete="off"
      spellcheck={false}
      placeholder="https://solus.example.com"
      dictation={false}
      {value}
      oninput={(event) => (draft = event.currentTarget.value)}
      aria-invalid={problem ? true : undefined}
      class="h-7 min-w-0 flex-1 basis-56 bg-(--solus-tx-card-bg) text-workspace-chrome"
    />
    <Button variant="ghost" size="sm" class="bg-muted" disabled={isBusy} onclick={cancel}>Cancel</Button>
    <Button type="submit" size="sm" disabled={!canSave || !settings || isBusy}>
      {#if settings?.saving}Saving…{:else if test?.kind === "running"}Testing…{:else}Save and test{/if}
    </Button>
  </div>
  {#if problem}
    <p role="alert" class="text-chrome-dense text-(--solus-status-error)">{problem}</p>
  {:else if settings?.error}
    <p role="alert" class="text-chrome-dense text-(--solus-status-error)">{settings.error}</p>
  {/if}
  <p class="text-chrome-dense text-(--solus-text-tertiary)">
    Point it at {localOrigin ?? "this host's port"} and pass the Host header, or forward it as X-Forwarded-Host.
  </p>
</form>
