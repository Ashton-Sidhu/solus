<script lang="ts">
  import { localApi } from "@solus/client-core/local-api";
  /** A browser-auth prompt: what to confirm or return, where, and why.
   *  The browser is opened for the user already — the Open action is the
   *  fallback for when it wasn't, or landed behind another window. */
  import { ArrowSquareOutIcon, CircleNotchIcon } from "phosphor-svelte";
  import CopyButton from "../ui/CopyButton.svelte";
  import { Button } from "../ui/button";
  import { Input } from "../ui/input";

  interface Props {
    url: string;
    code?: string;
    requiresCodeInput?: boolean;
    why: string;
    onsubmit?: (code: string) => Promise<void>;
    /** Given only where there is a waiting flow to call off. */
    oncancel?: () => void;
    /** Who is signing in, for the field that asks for their code. */
    label?: string;
  }

  let {
    url,
    code,
    requiresCodeInput = false,
    why,
    onsubmit,
    oncancel,
    label = "your provider",
  }: Props = $props();
  let returnedCode = $state("");
  /** Handing the code over is the last thing the user does, and the CLI takes a
   *  few seconds to answer. Without a state to show, Submit looks like it did
   *  nothing and they paste it again. */
  let submitState = $state<"idle" | "submitting" | "sent">("idle");

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!onsubmit || !returnedCode.trim() || submitState !== "idle") return;
    submitState = "submitting";
    try {
      await onsubmit(returnedCode);
      submitState = "sent";
      returnedCode = "";
    } catch {
      // Reported where this step's other failures are. Back to idle so the code
      // can be corrected rather than the prompt being stuck on a dead attempt.
      submitState = "idle";
    }
  }
</script>

<div class="text-xs mt-3.5 flex flex-wrap items-baseline gap-3">
  <span class="min-w-0 flex-1 text-pretty leading-relaxed text-(--solus-text-tertiary)">
    {submitState === "sent" ? `Code sent — finishing sign-in on the host…` : why}
  </span>
  {#if code}
    <code
      class="shrink-0 font-mono text-sm st text-(--solus-text-primary)"
    >
      {code}
    </code>
    <CopyButton text={code} />
  {/if}
  <button
    type="button"
    class="inline-flex shrink-0 items-center gap-1 text-(--solus-accent) hover:underline"
    onclick={() => void localApi.openExternal(url)}
  >
    Open
    <ArrowSquareOutIcon size={11} />
  </button>
  {#if oncancel}
    <button
      type="button"
      class="shrink-0 text-(--solus-text-tertiary) hover:text-(--solus-text-secondary)"
      onclick={oncancel}
    >
      Cancel
    </button>
  {/if}
  {#if requiresCodeInput}
    {#if submitState === "sent"}
      <span
        class="flex w-full items-center gap-2 text-(--solus-text-tertiary)"
        role="status"
      >
        <CircleNotchIcon size={12} class="shrink-0 animate-spin text-(--solus-accent)" />
        Waiting for {label} to accept it.
      </span>
    {:else}
      <form class="flex w-full items-center gap-2" onsubmit={submit}>
        <Input
          bind:value={returnedCode}
          class="h-8 min-w-0 flex-1 font-mono"
          placeholder="Paste the code from {label}"
          autocomplete="one-time-code"
          aria-label="{label} sign-in code"
          dictation={false}
          disabled={submitState === "submitting"}
          autofocus
        />
        <Button
          type="submit"
          size="sm"
          disabled={!returnedCode.trim() || submitState === "submitting"}
        >
          {submitState === "submitting" ? "Sending…" : "Submit"}
        </Button>
      </form>
    {/if}
  {/if}
</div>
