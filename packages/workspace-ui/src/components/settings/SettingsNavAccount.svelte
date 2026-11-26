<script lang="ts">
  /** The settings sidebar footer: who is signed in, or a way to sign in. It opens
   *  Account & sync, where sign-in and sync live, as T3 Code's footer opens its account. */
  import { UserRound as PersonIcon } from "@lucide/svelte";
  import { accountStore } from "../../contexts";
  import { accountInitial } from "../session/lib/account-menu";

  let { isActive, onSelect }: { isActive: boolean; onSelect: () => void } = $props();

  const signedIn = $derived(accountStore.state.kind === "signed-in" ? accountStore.state : null);
</script>

<button
  type="button"
  onclick={onSelect}
  aria-current={isActive ? "page" : undefined}
  aria-label={signedIn ? `Account & sync: ${signedIn.identity.email}` : "Account & sync: sign in"}
  class="flex h-10 w-full min-w-0 cursor-pointer items-center gap-[0.625rem] overflow-hidden rounded-lg px-[0.625rem] text-left text-foreground transition-[color,background] duration-150 hover:bg-sidebar-accent {isActive ? 'bg-sidebar-accent' : ''}"
>
  {#if signedIn?.identity.picture}
    <img src={signedIn.identity.picture} alt="" class="size-6 shrink-0 rounded-full object-cover shadow-[0_0_0_1px_color-mix(in_oklch,var(--foreground)_10%,transparent)]" />
  {:else if signedIn}
    <span class="flex size-6 shrink-0 items-center justify-center rounded-full bg-[color-mix(in_oklch,var(--primary)_16%,transparent)] text-xs font-semibold text-[color-mix(in_oklch,var(--primary)_80%,var(--foreground))]" aria-hidden="true">{accountInitial(signedIn.identity)}</span>
  {:else}
    <span class="flex size-6 shrink-0 items-center justify-center text-muted-foreground"><PersonIcon size={16} /></span>
  {/if}
  <span class="flex min-w-0 flex-1 flex-col leading-tight">
    <span class="truncate text-workspace-chrome">{signedIn ? (signedIn.identity.name ?? signedIn.identity.email) : "Sign in"}</span>
    <span class="truncate text-chrome-dense text-muted-foreground">{signedIn ? "Account & sync" : "Sync settings and use your organization"}</span>
  </span>
</button>
