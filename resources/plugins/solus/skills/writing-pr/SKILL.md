---
name: writing-pr
description: Write a pull request title and body that follows the Solus pull request guidelines. Use whenever you create or open a pull request, run `gh pr create` or `gh pr edit`, or write or update a pull request title or description.
---

# Writing a pull request

The Solus "Make pull request" button writes pull requests with the same rules as this skill. Follow them, so that a pull request you open looks like one the button opens.

Instructions from the user and from the repository (`CLAUDE.md`, `AGENTS.md`) take precedence over this skill.

## Steps

1. Read the complete branch change against the base branch. Use `origin/<base>` when it exists, else `<base>`:
   - `git log --no-merges --pretty=format:%s <base>..HEAD`
   - `git diff <base>...HEAD`

   Write about the final change only, not the steps you took to get there.
2. Look for a pull request template on the base branch. Check these paths in this order with `git show <base>:<path>`, and use the first one that is not empty:
   - `.github/pull_request_template.md`
   - `.github/PULL_REQUEST_TEMPLATE.md`
   - `docs/pull_request_template.md`
   - `PULL_REQUEST_TEMPLATE.md`
3. If there is a template, follow it. Keep its Markdown structure, fill its sections with facts from the commits and diff, and remove its HTML comments. Fill a testing or validation section only because the template asks for one. Do not apply the body rules below.
4. If there is no template, write the body with the body rules below.
5. Write a title that is concise, specific, and describes the user-visible outcome. Use one line with no period at the end. Follow the title style of the repository's recent commits.
6. Never invent a link, an image, or a number that the commits, the diff, or your own captured evidence do not contain.
7. Pass the body with `gh pr create --body-file <file>` (or `gh pr edit --body-file <file>`), so that the shell does not change the Markdown.

## Body rules

- dont write essays, dont include that you ran tests. rather, write a concise body. focus on mermaid codeblock diagrams, code samples/snippets (this can be internals, or even sample usage). use bullet points for the text you do write. 'validation/i ran tests' is not needed
- for visual changes (either directly or indirectly) show a table of before and after with uploaded images/videos.
- for benchmarks, always show tables of before/after (baseline from target branch, candidate from the PR)
- dont at intermidate PR details - e.g. if we reduced PR size from +6k lines to +1k lines, dont even mention it. if we refactored from one commit to another it doesnt matter. only the final aggregate squash merge commit is what matters for commentary
- for truely impressive, difficult, or high risk/wide scoped changes you might write the body like a technical blog (again with context, storytelling, code samples/before/after etc diagrams, images whatever.
- feel free to use code refs
