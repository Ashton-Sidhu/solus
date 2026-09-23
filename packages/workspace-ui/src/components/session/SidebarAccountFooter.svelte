<script lang="ts">
  /** The sidebar footer: one row. Settings, keyboard shortcuts, and Docs sit on
   *  the left as icon buttons; the account sits on the right. Signed in, that is
   *  a quiet user icon that matches the row (the avatar waits in the menu, so a
   *  bright profile picture does not pull the eye), and its menu holds the account and organization pages and
   *  sign-out. Signed out it is a small "Sign in" button — the desktop app is
   *  free without an account, so it reads as a quiet control, never a pitch.
   *  Web and mobile cannot hold an account yet (`accountStore.isAvailable`), so
   *  their row has the icon buttons alone. */
  import { localApi } from "@solus/client-core/local-api";
  import {
    Settings as GearIcon,
    Keyboard as KeyboardIcon,
    UserRound as UserIcon,
    Building2 as OrganizationIcon,
    LibraryBig as BooksIcon,
    ArrowUpRight as ExternalIcon,
    LogIn as LogInIcon,
    LogOut as LogOutIcon,
    X as XIcon,
  } from "@lucide/svelte";
  import { accountStore, getWorkspaceContext } from "../../contexts";
  import { comboHint } from "../../lib/keybindings/manifest";
  import { requestInputFocus } from "../../lib/inputFocus";
  import * as Sidebar from "../ui/sidebar";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import * as TooltipUI from "../ui/tooltip";
  import { Button } from "../ui/button";
  import { accountInitial, consolePageUrl } from "./lib/account-menu";

  const DOCS_URL = "https://solus.sh/docs";

  const session = getWorkspaceContext();
  const account = $derived(accountStore.state);
  const signedIn = $derived(account.kind === "signed-in" ? account : null);
  const settingsOpen = $derived(session.router.at("settings"));
  // No keychain means no account on this device, so there is nothing to offer.
  const offersSignIn = $derived(
    accountStore.isAvailable && !signedIn && account.kind !== "unavailable",
  );
</script>

{#snippet utilityButton(
  label: string,
  shortcut: string | undefined,
  isActive: boolean,
  onclick: () => void,
  icon: typeof GearIcon,
)}
  {@const Icon = icon}
  <TooltipUI.Root>
    <TooltipUI.Trigger>
      {#snippet child({ props })}
        <Button
          {...props}
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          aria-current={isActive ? "page" : undefined}
          class="rounded-lg text-[color-mix(in_oklch,var(--foreground)_65%,transparent)] hover:bg-[color-mix(in_oklch,var(--foreground)_6%,transparent)] hover:text-foreground {isActive
            ? 'bg-[color-mix(in_oklch,var(--foreground)_6%,transparent)] text-foreground'
            : ''}"
          {onclick}
        >
          <Icon size={15} />
        </Button>
      {/snippet}
    </TooltipUI.Trigger>
    <TooltipUI.Content side="top" value={{ label, shortcut }} />
  </TooltipUI.Root>
{/snippet}

<Sidebar.MenuItem class="flex items-center gap-0.5">
  {@render utilityButton(
    "Settings",
    comboHint("global.settings"),
    settingsOpen && session.settingsTab !== "keybindings",
    () => session.showSettings(),
    GearIcon,
  )}
  {@render utilityButton(
    "Keyboard shortcuts",
    undefined,
    settingsOpen && session.settingsTab === "keybindings",
    () => session.showSettings("keybindings"),
    KeyboardIcon,
  )}
  {@render utilityButton(
    "Docs",
    undefined,
    false,
    () => void localApi.openExternal(DOCS_URL),
    BooksIcon,
  )}

  <div class="ml-auto flex min-w-0 items-center">
    {#if signedIn}
      <DropdownMenu.Root
        onOpenChange={(next) => {
          if (!next) requestInputFocus();
        }}
      >
        <DropdownMenu.Trigger>
          {#snippet child({ props })}
            <Button
              {...props}
              variant="ghost"
              size="icon-sm"
              aria-label={`Account: ${signedIn.profile.email}`}
              class="rounded-lg text-[color-mix(in_oklch,var(--foreground)_65%,transparent)] hover:bg-[color-mix(in_oklch,var(--foreground)_6%,transparent)] hover:text-foreground data-[state=open]:bg-[color-mix(in_oklch,var(--foreground)_6%,transparent)] data-[state=open]:text-foreground"
            >
              <UserIcon size={15} />
            </Button>
          {/snippet}
        </DropdownMenu.Trigger>
        <DropdownMenu.Content
          side="top"
          align="end"
          sideOffset={6}
          class="w-[min(15rem,calc(100vw-2rem))]"
        >
          <div class="flex items-center gap-2.5 px-2 pt-1.5 pb-2">
            {#if signedIn.profile.avatarUrl}
              <img
                src={signedIn.profile.avatarUrl}
                alt=""
                class="size-8 shrink-0 rounded-full object-cover shadow-[0_0_0_1px_color-mix(in_oklch,var(--foreground)_10%,transparent)]"
              />
            {:else}
              <span
                class="flex size-8 shrink-0 items-center justify-center rounded-full bg-[color-mix(in_oklch,var(--primary)_16%,transparent)] text-sm font-semibold text-[color-mix(in_oklch,var(--primary)_80%,var(--foreground))]"
                aria-hidden="true">{accountInitial(signedIn.profile)}</span
              >
            {/if}
            <div class="flex min-w-0 flex-1 flex-col">
              <span class="truncate text-sm font-medium text-foreground"
                >{signedIn.profile.name ?? signedIn.profile.email}</span
              >
              {#if signedIn.profile.name}
                <span class="truncate text-xs text-muted-foreground">{signedIn.profile.email}</span>
              {/if}
            </div>
          </div>
          <DropdownMenu.Separator />
          <!-- A main process older than `consoleUrl` sends none; the links go
               rather than open a page that cannot be named. -->
          {#if signedIn.consoleUrl}
            {@const consoleUrl = signedIn.consoleUrl}
            <DropdownMenu.Item
              onSelect={() => void localApi.openExternal(consolePageUrl(consoleUrl, "account"))}
            >
              <UserIcon />
              Account settings
              <ExternalIcon class="ml-auto text-muted-foreground" />
            </DropdownMenu.Item>
            <DropdownMenu.Item
              onSelect={() => void localApi.openExternal(consolePageUrl(consoleUrl, "teams"))}
            >
              <OrganizationIcon />
              Organization settings
              <ExternalIcon class="ml-auto text-muted-foreground" />
            </DropdownMenu.Item>
            <DropdownMenu.Separator />
          {/if}
          <DropdownMenu.Item onSelect={() => void accountStore.signOut()}>
            <LogOutIcon />
            Sign out
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    {:else if offersSignIn && account.kind === "signing-in"}
      <!-- The browser is waiting on this code; clicking cancels. -->
      <TooltipUI.Root>
        <TooltipUI.Trigger>
          {#snippet child({ props })}
            <Button
              {...props}
              variant="ghost"
              size="sm"
              class="h-7 gap-1.5 rounded-lg px-2 text-workspace-chrome font-normal text-muted-foreground hover:bg-[color-mix(in_oklch,var(--foreground)_6%,transparent)] hover:text-foreground"
              onclick={() => accountStore.cancelSignIn()}
            >
              <span class="font-mono">{account.userCode}</span>
              <XIcon size={12} />
            </Button>
          {/snippet}
        </TooltipUI.Trigger>
        <TooltipUI.Content side="top" value="Confirm this code in your browser. Click to cancel." />
      </TooltipUI.Root>
    {:else if offersSignIn}
      <Button
        variant="ghost"
        size="sm"
        class="h-7 gap-1.5 rounded-lg px-2 text-workspace-chrome font-normal text-[color-mix(in_oklch,var(--foreground)_65%,transparent)] hover:bg-[color-mix(in_oklch,var(--foreground)_6%,transparent)] hover:text-foreground"
        onclick={() => void accountStore.signIn()}
      >
        <LogInIcon size={14} />
        {account.kind === "invalid" ? "Sign in again" : "Sign in"}
      </Button>
    {/if}
  </div>
</Sidebar.MenuItem>
