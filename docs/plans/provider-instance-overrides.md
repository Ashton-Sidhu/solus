# Provider preferences and project overrides

Provider instances belong to one signed-in Solus user on one host. An instance
names its runtime, credentials, and model catalog. A
project override belongs to that same user and host. It does not enter the
repository's shared configuration or the organization's project record.

## Default model

The model list and the initial default come from `model-profiles.json`. A saved
personal default for the provider takes precedence. Resetting the preference
returns to the profile default. Provider instances do not have separate model
defaults. The legacy instance field is accepted for compatibility but is ignored
by model selection and is cleared when an instance is saved.

Provider selection through the keyboard or the UI uses the personal default each
time, including a switch back. An explicit model stays selected until the user
changes the model or provider. Auto remains a first-prompt choice. Existing
threads use a concrete default when their provider changes.

## Project overrides

A private project override names a canonical host project root. The server
resolves home paths and the project root before saving it. A managed worktree
uses the same root. A run can carry its project root separately from its working
directory, so a worktree does not change its provider policy.

An override can select a Claude instance and a Codex instance for new sessions.
It can also enable or disable each instance, replacing the corresponding host
setting. An absent field inherits the host setting. Reset removes both kinds of
override. Removing an unused instance removes references from project overrides.

A started session keeps its instance binding when a selection changes.
Effective availability is checked again before each turn. Project disablement
therefore stops a later continuation without interrupting a running turn. Auto
filters providers through the same project enablement rule.

The host's agent metadata carries a credential-free projection of instance model
preferences and project overrides. Clients derive a project's catalog without
changing shared host facts. The projection excludes runtime environment values,
provider homes, and authentication state. Each user reads their own projection.

## Settings surfaces

Desktop and web expose personal provider defaults and project overrides in Settings →
Providers. A scope sentence selects All projects or a project on a host, following
T3 Code. Native mobile offers the same project scope from its host Providers page.
Project preferences are saved through the existing typed provider-instances RPC
and its invalidation event. Revision checks reject stale writes.

There is no aggregate Projects settings page. Source Control has the same scope
selector for branch names and copied files. Those controls keep their own storage:
`.solus/config.json` and `.worktreeinclude`. Organization project management lives
in Organization settings. Private provider preferences do not modify those files.

## Older hosts

Hosts with these controls advertise provider `configurationVersion: 2`.
The client parses older replies with default `projects` and legacy `defaultModel`
fields. It shows an update notice for unsupported project controls.
Runtime edits sent to an older host omit the legacy default-model field. An older
host cannot receive a project-override write. No host is restarted automatically.

## Verification

Tests cover private ownership, personal defaults over profile defaults,
explicit choices, provider switches, project selection, enablement, reset,
worktree and Windows path matching, stable session bindings, older-host decoding,
and Svelte view updates. They use temporary directories and fake storage or
provider processes. They do not use live credentials or paid agent turns.
