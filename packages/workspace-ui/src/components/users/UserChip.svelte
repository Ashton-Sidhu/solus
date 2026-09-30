<script lang="ts">
  import { userColorIndex, userKey, type User } from "@solus/contracts/user";
  import UserAvatar from "./UserAvatar.svelte";
  import { chipName, presenceTint } from "./lib/users";

  /**
   * A person as a name: their face and name in their colour. Inside a card or a
   * divider (`short`) the first name is enough; elsewhere the full name. The
   * colour mixes toward the foreground, so it reads in light and dark alike.
   */
  interface Props {
    user: User;
    size?: 14 | 16 | 18 | 20 | 24;
    /** Inside a card or a divider: the first name only. */
    short?: boolean;
    class?: string;
  }
  let { user, size = 14, short = false, class: className = "" }: Props = $props();
</script>

<span
  class="inline-flex max-w-[12rem] items-center gap-1 align-[-0.1875rem] font-medium whitespace-nowrap {className}"
  style:color={presenceTint(userColorIndex(user)).ink}
  data-testid="user-chip"
  data-user={userKey(user.id)}
>
  <UserAvatar {user} {size} />
  <span class="truncate">{chipName(user, short)}</span>
</span>
