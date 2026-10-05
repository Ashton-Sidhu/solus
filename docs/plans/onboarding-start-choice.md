# Shared onboarding start choice

Host and cloud onboarding end on **How do you want to start?**. This applies
on desktop, web, and mobile. Setup steps use the account or host that owns them.
The start choice uses the same component on every client.

- **Start something new** asks for a name and creates a project on the chosen host.
  If a cloud user has no host, this first returns to machine setup.
- **Open existing code** offers recent folders and the folder browser on the host.
  Cloud users can also choose a GitHub repository. Repository selection is a step
  inside this choice, rather than the last required setup stage. Back returns to
  existing code, then to the start choice.
- **New chat** opens a new chat, with no project ([Projects → Chats](../projects.md#chats)).

Continue and Skip on the cloud GitHub step both lead to the start choice. GitHub
is optional for a new project, a host folder, or chat. A user who later chooses a
repository can return to GitHub setup from existing code.

The header's **Skip setup** and Escape on a setup stage still end onboarding.
Escape on a project choice returns one step. Enter on a focused button runs that
button's action. Enter outside a field or button on the start screen chooses a
new project.

Cloud completion remains an account setting, shared across devices. Host
completion remains a client setting. Repository drafts use the existing machine
selection rule; folder drafts remain bound to their host. Both Claude and Codex
use the same start choices, with no change to their setup or run contracts.

Skipped cloud setup appears below the composer as a collapsed **Finish setup**
row with a step count. Opening it shows small actions that return to the required
setup stage. Completed steps disappear. The composer keeps a small **Connect
Claude** or **Connect Codex** action when a connection is required to send a
message. Token entry is available under **More options**. This applies to
desktop, web, and mobile.
