<script lang="ts">
  /** "Your own address" (plans/035 §0.8): the https address of the person's
   *  own ingress, a reverse proxy or a tunnel of their own, saved to the host
   *  setting `publicAddress`, then tested from outside as an app would reach
   *  it. Only a person who may change the host's settings (`host.admin`) sees
   *  this field; the address card says whom to ask otherwise. */
  import { onMount } from "svelte";
  import { connectionsStore } from "../../../contexts";
  import { hostSettingsStore } from "../../../contexts/app/host-settings.store.svelte";
  import { Button } from "../../ui/button";
  import { Input } from "../../ui/input";
  import { appAddressTestText, publicAddressProblem } from "../lib/app-addresses";
  import { outsideApps } from "./outside-apps.svelte";

  interface Props {
    serverId: string;
  }

  let { serverId }: Props = $props();

  let fieldEl = $state<HTMLInputElement | null>(null);
  const settings = $derived(hostSettingsStore.states.get(serverId));
  const saved = $derived(settings?.publicAddress ?? "");
  const localOrigin = $derived.by(() => {
    const localUrl = connectionsStore.appEndpointFor(serverId)?.localUrl;
    return localUrl && URL.canParse(localUrl) ? new URL(localUrl).origin : null;
  });
  const custom = $derived(connectionsStore.appEndpointFor(serverId)?.addresses.find((address) => address.source === "custom") ?? null);
  const test = $derived(connectionsStore.appAddressTestsFor(serverId).custom);
  const testText = $derived(custom ? appAddressTestText(test, custom.url) : null);

  // A draft of the field; null shows the saved value.
  let draft = $state<string | null>(null);
  const value = $derived(draft ?? saved);
  const problem = $derived(draft === null ? null : publicAddressProblem(draft));
  const hasChange = $derived(draft !== null && draft.trim() !== saved);
  const isBusy = $derived(!!settings?.saving || test?.kind === "running");

  onMount(() => fieldEl?.focus());

  async function save() {
    if (draft === null || problem || !settings || isBusy) return;
    if (await outsideApps.saveAndTestPublicAddress(serverId, draft)) draft = null;
  }
</script>

<form class="flex flex-col gap-2" onsubmit={(event) => { event.preventDefault(); void save(); }}>
  <label for="outside-apps-own-address-{serverId}" class="text-chrome-dense text-(--solus-text-secondary)">Your https address</label>
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
      class="h-8 min-w-0 flex-1 basis-56 bg-(--solus-form-input-bg) text-workspace-chrome"
    />
    <Button type="submit" size="sm" class="h-8 px-3.5 font-semibold" disabled={!hasChange || !!problem || !settings || isBusy}>
      {#if settings?.saving}Saving…{:else if test?.kind === "running"}Testing…{:else if value.trim() === "" && saved !== ""}Remove{:else}Save and test{/if}
    </Button>
  </div>
  {#if problem}
    <p role="alert" class="text-chrome-dense text-(--solus-status-error)">{problem}</p>
  {:else if settings?.error}
    <p role="alert" class="text-chrome-dense text-(--solus-status-error)">{settings.error}</p>
  {:else if testText && test && draft === null}
    <p
      role={test.kind === "done" && test.reachable ? "status" : "alert"}
      class={["text-chrome-dense select-text", test.kind === "done" && test.reachable ? "text-(--solus-status-complete)" : test.kind === "running" ? "text-(--solus-text-tertiary)" : "text-(--solus-status-error)"]}
    >
      {testText}
    </p>
  {/if}
  <p class="text-chrome-dense text-(--solus-text-secondary)">
    Point it at {localOrigin ?? "this host's port"} and pass the Host header, or forward it as X-Forwarded-Host.
  </p>
</form>
