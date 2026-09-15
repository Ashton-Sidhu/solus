# Worktree setup and recovery

A requested worktree must be ready before Solus starts the provider. Setup checks that the selected base resolves to a commit, reserves a new branch, creates the checkout, and copies files selected by `.worktreeinclude`. Existing setup steps and Stop remain available.

If setup fails, Solus keeps the failed step and its error visible. It does not start the provider in the project directory. The shared conversation card offers two actions:

- **Retry setup** repeats worktree preparation.
- **Work locally** clears the requesting client's worktree choice and retries in the project directory.

The host keeps the full failed prompt in memory, including expanded context and image attachments. The existing retry RPC combines that prompt with the requesting client's current run configuration. Thus another connected desktop, web, or mobile client can recover the failed setup without possessing the original optimistic user message. Editor and Pill modes use the same card and recovery command. Both providers use the same setup path. After an action, input focus returns to the conversation.

The retained prompt is not durable across a host restart. A new setup attempt replaces it; Stop and host shutdown clear it. Successful setup also clears the retained failure. A host restart requires the user to submit the prompt again.

Cleanup applies only to resources owned by the failed attempt. Branch reservation must succeed before cleanup can own that branch. A registered checkout is removed only when its branch and resolved path match the attempt. The branch reference is deleted only after no checkout holds it and only if its commit still matches the reserved commit. An existing destination or branch remains untouched. Cleanup failures are logged for inspection.

Focused tests cover an empty repository, failed file preparation from a base ahead of the current checkout, destination and branch collisions, cancellation, and successful setup. Dispatch tests verify that failure does not start the provider and that explicit local recovery preserves the original prompt and image attachment.
