# Settings groups and provider defaults

Settings on desktop and web use the same groups as the current T3 Code settings navigation, with Solus names and capabilities:

- **App:** General, Appearance, Chat, Notifications, Keybindings, and Voice. General contains sidebar motion, the projects folder, background text generation, and version information. Chat contains response streaming, tool calls, changed-file summaries, and input-bar collapse.
- **Agents:** Providers, Sessions, Tasks, Agent profile, Tools, MCP, Skills, Devices, and Webhooks. Sessions contains the default provider and permission mode, automatic session names, rate-limit behavior, Auto routing, and lead and worker defaults.
- **Code:** Source Control and Review companion.
- **Connections:** Account & sync, Organization, Integrations, and Hosts.
- **Advanced:** Host, Telemetry, and Experimental.

Per-project values use scope selectors instead of a Projects settings destination.

Mobile uses App, Agents, and Connections for the corresponding native screens. Host-specific pages remain under each host. Desktop and web use one shared workspace layout; this change adds no phone layout to the web client.

## Provider model preferences

Open **Settings → Providers** to set the default model for Claude Code and Codex independently. Select a provider to open its detail page on desktop, web, or mobile. Choosing a model does not change the default provider. Select the default provider in **Settings → Sessions**.

**Built-in default** removes the saved model choice for that provider. It leaves the other provider's choice in place. **Auto** asks the run host to choose a model from the first prompt. It requires a TypeSafe key on that host and uses the routing options in Sessions.

Each concrete model exposes its supported reasoning levels and context windows. A model that supports fast mode exposes that switch. **Reset model options** removes the saved reasoning, context-window, and speed choices for that model. Model instructions can be cleared in their field; they apply whenever that model runs, including existing sessions.

Model defaults and options apply to new sessions. An open session or draft keeps its model and options. Unsupported saved options fall back to the model catalog's defaults. A saved model that is no longer available stays visible with a notice; new sessions use the provider's built-in default.

These are personal preferences in `defaultModels`, `modelOptionsByProvider`, and `modelInstructions`. They use the existing personal settings store and account sync. They do not require a new host RPC, local filesystem access, or a provider restart. Provider installation, updates, and sign-in remain scoped to the selected host and retain the existing seat rules.

## Private provider instances

The [T3 Code provider editor](https://github.com/pingdotgg/t3code/blob/main/apps/web/src/components/settings/ProviderSettingsPanel.tsx) is the reference for the complete control inventory. Solus supports named Claude Code and Codex instances on each host. Instances belong to the signed-in Solus user. Other users cannot list, edit, select, or read their secrets.

Desktop and web use an instance selector and detail editor. Mobile uses a provider list and a separate detail screen. Both expose the same private records and controls through typed host RPC. Existing provider installation and seat setup remain available in Providers.

Each provider has one selected instance for new sessions. A session keeps its bound instance when that selection changes. Older sessions without a binding use the built-in instance. Removing an instance with sessions is refused; disable it instead. Effective enablement is the project override when set, then the instance’s host setting. A disabled instance refuses new turns, including continuation turns. Running turns keep their captured runtime settings.

Runtime paths resolve on the host under the acting user's environment. A member cannot select a provider home outside their own home or seat directory. Launch arguments are literal arguments, with no shell expansion. Solus-owned protocol and session arguments cannot be replaced. Runtime edits and authentication changes create a new process identity for later turns. They do not stop a running turn.

Sensitive environment values use the host's secret store. Responses contain an empty value and a marker that lets an edit keep the stored value. Renaming a variable requires a new secret value. Events contain an invalidation signal, with no instance records or credentials. Stale writes are refused by revision. Reconnects clear private client state and reject old replies.

A custom provider home uses its own authentication. It does not inherit API keys or provider tokens from the base environment; keys explicitly entered in that instance still apply. A Codex shadow home links configuration, sessions, and skills from its base home. It never links or copies `auth.json`.

## Full provider-control inventory

| Area | Implemented controls | Differences from T3 Code |
| --- | --- | --- |
| Provider list | Add and remove named instances; enable and disable; display name; accent color; selected instance for new sessions | Built-in instances can be disabled but cannot be removed. Instances with sessions must be disabled instead of removed. |
| Scope | Private to one Solus user on one host; host selection; project instance selection and enablement overrides; reset to host settings | Project overrides stay private and apply across the project’s worktrees. |
| Status | Refresh; installed CLI version; authentication and subscription/account details; masked account display | Installation and update controls use the existing provider setup section. There is no new version-specific installer in the instance editor. |
| Authentication | Sign in; retry; cancel; open or copy link; submit a code where needed; change account; sign out | Uses the existing relayed CLI flow. Codex uses device authentication. There is no new sign-in-method selector. |
| Codex runtime | Binary path; CODEX_HOME; shadow home; launch arguments | Sharing is limited to configuration, sessions, and skills. |
| Claude runtime | Binary path; CLAUDE_CONFIG_DIR; launch arguments; auto-compaction token threshold; idle policy override | Idle policy supports default, ask on return, and never. Compaction before cache expiry is not implemented. |
| Environment | Add, edit, remove; sensitive or plain text; preserve masked values | Provider home and acting-user environment fields belong to Runtime and cannot be overridden here. |
| Models | Filter; favorite; show/hide; bulk visibility; move up/down; custom model add/edit/remove; copy built-in options | Custom options use Solus's supported reasoning, context-window, and speed contracts. Arbitrary option IDs, types, and presets are not implemented. Custom models stay visible in the model catalog. |
| Model defaults | Independent default per provider; supported reasoning, context window, speed, instructions; reset | The model list and initial default come from `model-profiles.json`. A saved personal default takes precedence and syncs through the existing settings service. Provider instances do not have separate model defaults. |
| Advanced | Status-check interval; zero disables repeated checks; interval reset; default idle-compaction policy | Checks run while the detail page is open. There is no host-wide background health worker. |
| Usage providers | Existing Solus usage reporting | Additional usage-source hubs and Cursor Keychain integration are not implemented. |

Claude's ask-on-return policy uses the SDK's `resume_return` dialog and the existing Solus question card. A cancelled question does not compact. Never returns `continue`. Background runs keep the existing unattended-question policy.

Provider history keeps its private instance location. Codex records a locator with a hashed owner key and the instance ID, and refuses another user instead of falling back to the host login. Claude stores each private thread’s transcript home. A Codex picker preview does not start a private provider process; opening the session can start its history reader.

New and resumed turns use the bound instance's runtime and custom model profiles. Model pickers receive the selected instance's catalog. A session that uses an older instance can retain a model absent from the selected catalog; its saved model stays visible. Full per-session model-catalog browsing across several instances is not implemented.

No live provider process, login, or credential is changed by tests. Verification uses fake storage, temporary directories, fake login processes, and deterministic client replies. No real agent turn or application build is required by these tests.

## Personal defaults and project overrides

In **Settings → Providers**, use **Provider model default** to select your personal model for each provider. Changes save at once. A fresh install uses the model marked as default in `model-profiles.json`. A saved personal choice takes precedence. Resetting to **Built-in default** removes the personal choice. **Auto** remains available only for a new session’s first prompt. The preference belongs to the signed-in user and is shared across that provider’s instances.

In **Settings → Providers**, use **Applying settings for** to choose **All projects** or a project on the selected host. With a project selected, the page chooses the Claude and Codex instance for new sessions and controls each instance’s availability. Each field can inherit its host value. **Reset to host settings** removes the project overrides. These preferences belong to your Solus user on that host; they are not written into the repository’s shared `.solus/config.json`.

Changing providers with **Option+Shift+G** or the model picker selects that provider’s saved default each time, including when switching back. The personal provider default takes precedence; the `model-profiles.json` default is the fallback. A provider switch in an existing conversation uses a concrete model because Auto can only route a first prompt.

A session keeps its bound instance when the project or host selection changes. Project enablement is checked again for each new turn. Existing sessions and composed drafts keep their chosen model when a personal default changes. Starting a new session from an existing session can still inherit its model, as before; a default does not replace an inherited or explicit model choice.

The scope sentence sits directly above the settings it controls. Desktop and web reuse the input bar’s project and host pickers. The project menu includes search and **All projects**. Scope menus wrap full names, and selecting a scope does not move a draft or start a session. Mobile uses the same selection rows as its draft host picker, with searchable project and host choices.

There is no separate Projects settings section. **Source Control** has the same project selector for branch names and copied files. Select **All projects** for your personal Source Control defaults. Organization project management is under **Organization**. Branch naming can be committed in `.solus/config.json`; copied ignored files are named in `.worktreeinclude`. Provider project overrides remain private on the host.

New controls require provider configuration version 2 on the selected host. Older replies are parsed with safe defaults. Their existing runtime controls keep working, while project overrides show an update notice. The client does not restart or upgrade a host automatically.

## Scope controls

The scope sentence follows T3 Code’s [settings scope selector](https://github.com/pingdotgg/t3code/blob/main/apps/web/src/components/settings/SettingsScopeSentence.tsx): **Applying settings for [All projects / project] on [host]**. It appears only on Providers and Source Control, which currently have per-project settings. Other pages keep their existing scope.

Switching settings pages keeps the selected project. Changing the host resets to All projects, so a path from another host cannot be applied by accident. Old Projects settings links open Providers with the same project selected. Native mobile exposes the scope selector inside the host’s Providers page; its picker returns to that same settings page.
