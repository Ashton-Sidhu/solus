# Review lenses

A lens is an HTML view of a change that an agent makes from your prompt. Use it
to explain a change or to draw it: an architecture diagram, a risk table, a
data-flow trace, or any other view you describe.

The Lens tab is in the review panel, after Map and Guide, for a working tree, a
session, a branch, and a pull request. It works on desktop, web, and mobile, and
with Claude and Codex. The lens starts with the review agent, model, and
reasoning effort from Settings → Review. You can change them for one lens.

Design and decisions: [plans/review-lenses.md](plans/review-lenses.md).

## Make a lens

1. Open a review and select **Lens**.
2. Select a saved lens, or type a one-time prompt and select **Generate**.
   To see several saved lenses together, tick up to four of them and select
   **Generate as one lens**. Solus makes one lens with a tab for each, in the
   order you ticked them.
3. Wait for the lens. You can leave the tab; the tab label shows a spinner
   while the lens is made and a dot when a new lens is ready. On the pull
   requests list, the row of that pull request shows a lens mark while the lens
   is queued or made, and after it is ready until you open it. When the lens is
   ready, Solus shows a toast. For a pull request, the toast has **Open lens**.
   Turn the toast off in **Settings → Notifications → Review lens ready**.

The list mark shows only lens runs that this client saw. A run that finished
before you opened Solus does not show on the list.

Solus never makes a lens by itself. Each lens is one agent run.

## One lens for each change

Each change has one lens. A new lens or a lens edit replaces it. Solus keeps
one previous version: **Restore previous** swaps the two, and a second
**Restore previous** swaps them back. If a run fails or you cancel it, the lens
you had stays.

The lens shows **Outdated** when the change moved after the lens was made.
Select **Regenerate** to make it again for the current change.

## Change a lens

Type a request in the bar under the lens, for example "make the diagram
bigger", and press Enter. The agent changes the lens it has, instead of
starting again.

The model chip in that bar sets the agent, model, and reasoning effort for
edits and for **Regenerate**. It starts at the choice in Settings → Review. A
change in the chip is for this lens only. The lens header keeps its actions as
icons: **Regenerate**, **New lens**, **Restore previous**, **Pin a comment**,
**Show prompt**, **Save as work**, and **Save prompt as a lens**.

## Comment on a lens

Select **Comment**, then select a point on the lens. To apply your open comments,
keep **Apply comments** on and send an edit, or select **Apply comments now**.
Applied comments are marked resolved.

On a pull request, **Post to PR** sends a comment to the pull request:

- If the comment is on a part of the lens that points to a line in the diff,
  it becomes a line comment in your pending review. It goes out when you
  submit the review.
- If not, Solus asks you to confirm, then posts it as a conversation comment.
  **Retract** deletes it from the pull request.

## Combined lenses

A combined lens is still one lens: one agent run, one HTML view, and one
previous version for Restore. Its prompt joins the saved prompts, so
**Regenerate** and edits work as for any lens. If the run fails, you get no tab
at all, and the lens you had stays. All tabs share the lens size limit, so a
lens with four tabs has less room for each one.

## Find pull requests with a lens

On the Pull requests page, open **Filters** and set **Review lens** to **Has
review lens**. The list then shows only the pull requests that have a lens.
The host reads its saved lenses for the listed rows in one request. A lens
that is made later appears without a reload.

## Saved lenses

Settings → Review → Lenses holds your saved lenses: a name and a prompt each.
Start from a template or add your own. To keep a one-time prompt, select
**Save as lens**. An edit to a saved lens does not change lenses that were
already made from it.

## Keep a lens

**Save as work** copies the lens into Folio as an artifact work. The review
lens itself stays in the review cache.

## Safety

A lens runs in a sandbox with no network access, so it cannot send the code it
shows to a server. The agent that makes a lens reads the change, and a pull
request from another person can contain instructions for it. Read a lens on
an untrusted pull request as you would read its code.
