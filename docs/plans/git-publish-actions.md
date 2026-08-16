# Git publish actions

## Decision

Solus owns Git publish workflows on the host. Clients request one intent through
`gitRunAction`; they do not compose commit, push, and pull-request RPC calls.

The supported intents are:

- `commit`
- `commit_push`
- `push`
- `create_pull_request`
- `commit_push_pull_request`

The host validates the working-tree state, runs the required phases in order,
and publishes typed `git.actionProgressed` events. An action can create a
semantic feature branch before the commit when work starts on the target branch.

## Commit scope and message

A commit intent can carry two optional fields. Both are valid only with a commit
action; the host rejects them on other intents.

- `filePaths` — repository-relative paths to commit, file level only. When the
  field is absent, the host commits every change. An empty array is invalid.
- `commitMessage` — a manual commit subject. When the field is absent or blank,
  the host uses the message generator.

For a selected subset, the host uses Git's own pathspec-restricted commit. It
reads the current worktree content for those paths only, and it does not change
the staged or unstaged state of any other file. The host stages a selected
untracked file first, so the pathspec can find it, and removes that staging
again if the commit fails. A failed selective commit leaves the repository in
its initial state.

## Pull-request authoring

The pull-request writer reads the complete target-to-head change:

- commit subjects
- diff statistics
- a bounded patch
- the repository pull-request template, when present

It asks the host's source-control writer for a structured title and Markdown
body. By default, this is the host text-generation model. A host can select a
dedicated source-control writer without changing session models. The host then
calls GitHub CLI with explicit `--title` and `--body-file` arguments.
If generation fails, the host uses a deterministic draft from the commit and
diff context. Existing pull requests are returned after the push instead of
creating duplicates.

Delegated GitHub credentials apply only to GitHub CLI calls. Git commands keep
the normal host environment. A created or existing pull request remains linked
to the session task.

## Client behavior

Desktop, web, and mobile use the same status-aware primary action:

- Dirty work on the target branch creates a feature branch, commits, pushes,
  and opens a pull request.
- Dirty work on a feature branch commits and publishes it.
- Clean unpublished commits push and open a pull request.
- A published pull request opens directly, or pushes pending commits first.
- A branch behind its upstream must sync before it can publish.

The primary action stays one click: it commits every change and generates the
message. Beside it, **Commit with options…** and **Commit and push with
options…** open a composer that lists the changed files with their status and
line totals. The user selects a subset and can type a message. The composer
sends the same intent with `filePaths` and `commitMessage`. It is disabled when
the working tree is clean.

Clients show the phase labels from the host event. They refresh detailed Git
state after completion or failure.

## Writing settings

Text-generation models are host settings because a remote client must use the
models installed on the selected host. The general text-generation model names
sessions and handles short background writing. The optional source-control
writer overrides it only for commit messages and pull-request authoring. If a
saved model is unavailable, Solus keeps the selection and reports the effective
fallback model.

Source-control writing preferences are host settings. The selected style applies
in every project, while repository-convention mode reads local examples from
the repository where the Git action runs:

- **Repository conventions** uses the 20 latest non-merge commit subjects as
  style examples.
- **Conventional Commits** gives the writer an explicit Conventional Commit
  policy.
- **Custom instructions** apply the same host-owned writing direction to
  commit messages and pull-request drafts.
- **Follow pull-request template** controls whether the authoring context reads
  and preserves the repository template.

General settings owns the global text-generation model. Source Control owns a
Text generation section with the writing style, pull-request-template behavior,
custom instructions, and optional writer override. Both use the same
host-framed RPC state on desktop, web, and mobile. This matches T3Code's settings
ownership while keeping Solus pull-request terminology.
