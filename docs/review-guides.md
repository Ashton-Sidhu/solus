# Review guides

A review guide is a walkthrough of a change that an agent writes for the
person who decides if the change should land. It works on a working tree, a
session, a branch, and a pull request, with Claude and Codex. It shows on
desktop and web. Mobile does not show guides yet.

The guide explains the change. It does not look for bugs. Review agents and
human reviewers do that.

## Sections

The guide groups the change by concern, not by file. Each section has a title,
an explanation, and the diff of the files it is about. Sections are in reading
order: `core`, then `supporting`, then `low-signal`. Low-signal sections are
closed until you open them.

Every changed file is in the guide. If the agent leaves a file out, Solus adds
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

## Ask about a section

On a pull request guide, each section has **Ask about this section**. It opens
a pull-request-aware session beside the review, with a draft that names the
section, its decision, and its files. You write the question and send it. The
guide stays open at the same place.

Guides for a working tree, a session, or a branch do not have this action yet.
