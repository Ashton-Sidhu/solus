<script lang="ts">
  import { ExternalLink as ExternalLinkIcon } from "@lucide/svelte";
  import { Button } from "../../ui/button";
  import { Input } from "../../ui/input";
  import { SourceLogo } from "../../ui/list-page";
  import type { MenuLinearKey } from "./lib/menu-linear-key.svelte";

  /**
   * Connect Linear inside the menu that adds a source. A saved key reads the
   * teams again, so the person picks one in the same menu.
   */
  interface Props {
    linearKey: MenuLinearKey;
    /** Why the last read of Linear failed, such as a key Linear refused. */
    problem?: string;
    onConnected: () => void;
  }
  let { linearKey, problem, onConnected }: Props = $props();

  let key = $state("");

  async function save(event: SubmitEvent) {
    event.preventDefault();
    const draft = key;
    key = "";
    if (await linearKey.connection.save(draft)) onConnected();
  }
</script>

<!-- Outside the command list: its Enter would pick a row instead of saving. -->
<form class="grid gap-1.5 border-t border-(--solus-menu-hairline) px-4 py-2.5 text-xs" onsubmit={save}>
  <label for="menu-linear-key-{linearKey.serverId}" class="flex items-center gap-2.5 text-(--solus-text-secondary)">
    <SourceLogo source="linear" />
    <span class="min-w-0">{problem ?? "Add Linear teams with a personal API key."}</span>
  </label>
  <div class="flex items-center gap-1.5">
    <Input
      id="menu-linear-key-{linearKey.serverId}"
      type="password"
      bind:value={key}
      autocomplete="new-password"
      maxlength={4096}
      placeholder="lin_api_…"
      disabled={linearKey.state.pending}
      class="h-7 min-w-0 flex-1 text-xs"
    />
    <Button type="submit" size="sm" class="text-xs" disabled={!key.trim() || linearKey.state.pending}>
      {linearKey.state.pending ? "Connecting…" : "Connect"}
    </Button>
  </div>
  {#if linearKey.state.error}
    <p class="m-0 text-(--failure)" role="alert">{linearKey.state.error}</p>
  {/if}
  <a
    href="https://linear.app/settings/account/security"
    target="_blank"
    rel="noreferrer"
    class="flex w-fit items-center gap-1 rounded-md text-(--solus-text-tertiary) no-underline transition-colors duration-150 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)]"
  >Create a key in Linear <ExternalLinkIcon size={11} aria-hidden="true" /></a>
</form>
