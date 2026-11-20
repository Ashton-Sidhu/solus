import type { BranchRef } from "@solus/contracts/git-types";
import { useEffect, useState } from "react";

import type { ConversationStore } from "../conversation/conversation-store";

/**
 * The branches of a new session's project: the bases a new worktree can start
 * from. Null while they load. Empty for a folder without git, and when the
 * host refuses the list; then no worktree is offered. `enabled` turning true
 * again (the host connected) reads them again.
 */
export function useWorktreeBranches(store: ConversationStore, enabled: boolean): { readonly branches: readonly BranchRef[]; readonly currentBranch: string | null } | null {
  const [loaded, setLoaded] = useState<{ readonly store: ConversationStore; readonly branches: readonly BranchRef[]; readonly currentBranch: string | null } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    store.controller.branches().then(
      (result) => { if (current) setLoaded({ store, ...result }); },
      () => { if (current) setLoaded({ store, branches: [], currentBranch: null }); },
    );
    return () => { current = false; };
  }, [enabled, store]);
  return loaded?.store === store ? loaded : null;
}
