# Review guides

A review guide is a walkthrough of a change that an agent writes for the
person who decides if the change should land. To review this session, send `/review-guide` in the conversation.
Add a focus if needed, for example `/review-guide focus on the migration tests`.
Claude or Codex reads the before and after Git trees for this session’s completed turns.
The guide appears inside the reply on desktop, web, and mobile. Each file reference names a captured turn. The client reads that turn’s Git patch from the session host when it opens the guide. You can ask
follow-up questions or run the command again with a different focus.

Working-tree, branch, and pull request guides use the structured sections below.
Desktop and web show all three. Mobile also shows the pull request guide.

## Sections

The guide groups the change by concern, not by file. Each section has a title,
an explanation, and the diff of the files it is about. Sections are in reading
order: `core`, then `supporting`, then `low-signal`. Low-signal sections are
closed until you open them.

On desktop and web, guides with three or more main sections have a rail on
the left. Hover over it or focus it with the keyboard to see the section
titles. Select a title to jump to that section. A darker marker shows your
current section.

Working-tree, branch, and pull request guides include every changed file. If the agent leaves a file out, Solus adds
it to a **Remaining changes** section.

## Attention

A section can ask for one decision: a tradeoff to weigh, a contract that
changes, a product decision, a risk to accept, or an accessibility effect. The
guide shows it below the explanation. Most sections have no attention. The
agent is told not to invent concerns.

## Diffs come from the real change

The agent names line ranges, not diff text. Solus cuts the hunks that those
ranges touch from the exact patch it reviewed, so the line numbers are real and
the text is the change. Line counts also come from the patch. When no range
lands on a hunk, the section shows the whole diff of that file. You can expand
the context around a hunk, and comments on guide lines go to the same review
drafts as comments in the Diff tab.

A file the change does not contain is removed from the guide.

## When the change moves

A guide is written for one revision of the change. When the change moves on —
a push, a new base, or an edit in the working tree — the guide stays readable
and shows as **Outdated**. **Regenerate guide** writes a new guide for the
whole change.

If the change moves while a guide is being written, Solus keeps that guide
and shows it as outdated. It does not discard a finished guide. A request for
a guide that is already being written for the same revision joins that run and
does not start a second one. A request for a newer revision stops the old run
and starts again.

One job manager on the host (`ReviewGuideJobs` in
`packages/server/src/review/guide-jobs.ts`) owns each structured guide job, for pull
requests and for local changes. Pull request guides run one at a time; local
guides run in parallel.

## Ask about a section

On a pull request guide, each section has **Ask about this section**. It opens
a pull-request-aware session beside the review, with a draft that names the
section, its decision, and its files. You write the question and send it. The
guide stays open at the same place.

Guides for a working tree or a branch do not have this action yet.

## In the mobile app

On iOS and Android, the pull request screen has a **Guide** tab when the host
has review guides. The guide is a tour: one stop for each section, in section
order, with the section's explanation, its attention note, and its hunks. Tap a
hunk to open that file in the **Files** tab. For tours with three or more stops,
a darker marker shows your current stop. Use **All stops** to jump to any stop.
**Write guide** asks the host to write a guide for the pull request. The tab
shows the progress and keeps the last guide readable. A guide for an older
head stays readable, but it does not show its hunks until it is written again.
