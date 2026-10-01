<script lang="ts">
  import { userColorIndex, userInitials, userKey, type User } from "@solus/contracts/user";
  import { presenceTint } from "./lib/users";

  /**
   * One person, in their colour (`userColorIndex`): the avatar from their sign-in
   * when it loads, their initials on a wash of the colour until then. The same
   * face and colour stand for them in every stack, row and card, so a reader
   * learns a person once. A ring marks the author of the turn in flight; a dot
   * marks a draft being typed. Both are finite: they paint once and hold.
   */
  interface Props {
    user: User;
    size?: 14 | 16 | 18 | 20 | 24 | 32;
    /** The turn running in this session is theirs. */
    ringed?: boolean;
    /** They have a draft in this session. */
    composing?: boolean;
    class?: string;
  }
  let { user, size = 18, ringed = false, composing = false, class: className = "" }: Props = $props();

  const tint = $derived(presenceTint(userColorIndex(user)));
  // Initials at a size the circle can hold: two letters need under half the diameter each.
  const fontSize = $derived(Math.max(7, Math.round(size * 0.42)));
</script>

<span
  class="relative inline-flex shrink-0 items-center justify-center rounded-full font-medium leading-none whitespace-nowrap select-none {className}"
  style="width:{size}px;height:{size}px;font-size:{fontSize}px;background:linear-gradient({tint.fill}, {tint.fill}) var(--presence-avatar-surface, var(--background));color:{tint.ink};box-shadow:var(--tw-ring-shadow, 0 0 #0000), {ringed
    ? `0 0 0 1.5px var(--background), 0 0 0 3px ${tint.color}`
    : `0 0 0 .5px color-mix(in oklch, var(--foreground) 12%, transparent) inset`}"
  data-user-avatar={userKey(user.id)}
  aria-hidden="true"
>
  {userInitials(user)}
  {#if user.avatarUrl}
    <img
      src={user.avatarUrl}
      alt=""
      class="absolute inset-0 size-full rounded-full object-cover"
      onerror={(event) => {
        if (event.currentTarget instanceof HTMLImageElement) event.currentTarget.style.display = "none";
      }}
    />
  {/if}
  {#if composing}
    <!-- The dot sits on the rim, cut out of the avatar by a background ring so
         it reads as a mark on the person rather than a smudge over them. -->
    <span
      class="absolute -right-px -bottom-px block rounded-full"
      style="width:{Math.max(5, Math.round(size * 0.32))}px;height:{Math.max(5, Math.round(size * 0.32))}px;background:{tint.color};box-shadow:0 0 0 1.5px var(--background)"
    ></span>
  {/if}
</span>
