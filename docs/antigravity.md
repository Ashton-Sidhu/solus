# Google Antigravity

Solus runs Google Antigravity as an agent, next to Claude Code and Codex. Solus starts Google's `agy` CLI on the host and talks to it with the Agent Client Protocol (ACP).

## Set up Antigravity on a host

1. Open the host's setup, or Settings → Connections → the host.
2. In the agents list, select **Add** next to **Antigravity**. Solus downloads Google's current `agy` release into its own folder and checks its SHA-512 digest. Solus turns off `agy`'s own updater. Updates come through the host's agent updates.
3. Select **Sign in**. Open the Google link on any device, sign in, and paste the code from the Antigravity page into Solus.

If `agy` is already on the host's `PATH`, Solus can use that copy. The Solus copy comes first when both exist.

## Sign in

Choose how to sign in on the Antigravity seat:

- **Google account:** the sign-in above. It works from desktop, web, and mobile, also when the host is remote.
- **Gemini Enterprise:** give your Google Cloud project id and location, then sign in with your work account. After the sign-in, your browser can show a page that cannot load. Copy that page's whole address and paste it into Solus.
- **Gemini API key:** paste a key from Google AI Studio.
- **Vertex AI:** give your Google Cloud project id and location, then paste a Google Cloud API key or the contents of your `application_default_credentials.json`.

Use a personal Google account for interactive development with the Gemini models in your plan. For unattended automations or agent worker pools, use a Gemini API key or Vertex AI. [Google's ACP guidance](https://discuss.ai.google.dev/t/tos-clarification-is-openbot-official-antigravity-acp-server-permitted-under-the-antigravity-terms-of-service/197826/2)

`/login` signs in again the way you last signed in.

On a shared host, each member signs in with their own account in Settings → Providers → Your seats. A member's sign-in stays in their own Antigravity profile on the host. In a conversation, `/login` starts the same sign-in.

## In a session

- Choose Antigravity and a model in the model picker. After the first Antigravity session on a host, the picker lists the models your Google account offers, in `agy`'s order. Before that first session, it lists the models Solus publishes.
- Settings → Providers has a Google Antigravity tab, the one Antigravity instance. There you can turn Antigravity off, set the `agy` binary to run (leave it empty to let Solus find it), add a custom model, and hide, order, or move models between current and legacy. Sign-in stays in Your seats: `agy` keeps one sign-in, so Antigravity has no second instance, home, or environment.
- An Antigravity turn has the Solus tools (such as starting other sessions), your MCP integrations, and app tools. Antigravity can write titles and commit text, review changes, be the worker model of child sessions, and run automations. Writing with Antigravity is slower than with Claude or Codex, because each start of `agy` takes a while.
- Antigravity can work across a codebase's granted folders on the session's host, including worktrees that Solus creates. Solus can serve file reads from a folder as soon as you attach it. Antigravity adds the folder to its workspace when a new prompt starts a turn and resumes the same conversation.
- Solus answers Antigravity's permission requests from the session's permission mode. Reads are always allowed. In Plan mode, Solus puts Antigravity in its own plan mode: Antigravity writes a plan, which shows as a plan card, and edits and commands are refused.
- A subagent or swarm worker that Antigravity starts shows as a subagent card with its role and prompt, and the subagent's own tool calls show inside that card.
- Antigravity's questions show as question cards. A form question shows as a form; you can answer or decline it.
- When Google's API fails during a turn, the turn shows the error, not a success. When you reach your quota or a rate limit, the session waits for the reset, as it does for Claude and Codex.
- A message you send while a turn runs joins that turn (Antigravity 1.5 and later). With an older Antigravity, it waits for the turn to end.
- A background command or a one-time `/schedule` keeps the turn open until it ends. A recurring schedule ends the turn, and each later reply from Antigravity opens a turn of its own in the session.
- The slash menu lists Antigravity's own commands, such as `/plan` and `/compact`, after the host has opened its first Antigravity session.
- The slash menu lists your Antigravity skills: the project's (`.gemini/skills`, `.agents/skills`, `.agent/skills`) and your own. A skill you install in Settings → Skills is installed for Antigravity too, and skills in your agent profile reach your Antigravity seat on every host.
- Solus keeps the session's history, so it shows after a restart and on every client. Session search finds the session's messages.
- You can switch an open Claude or Codex session to Antigravity, and back. Antigravity gets the conversation the same way the others do: a handoff transcript that it reads first.
- When another member continues an Antigravity session, it continues in their own Antigravity seat: Antigravity starts there with the session's history as a handoff, and the transcript shows the handoff divider. The session cloud copy includes Antigravity sessions, and a host that continues one does the same.
- Antigravity runs that use the host's own sign-in load the MCP servers you set up for `agy` in a terminal (`~/.gemini/config/mcp_config.json`). Settings → MCP lists those servers with the other tools' servers, so you can add them as Solus integrations.
- Insights counts Antigravity turns as their own provider, with their tokens and their cost at Google's API prices (`docs/model-prices.md`). A Google account subscription does not bill these prices; they show what the work would cost on the API.

## See subscription limits

Check your remaining subscription quota and credits in the official Google Antigravity client. Solus shows quota errors and any reset time that Antigravity reports for a turn.

On desktop and web, the project panel shows a provider's usage row when the host has quota values to display.

## Limits

- On a Mac, Google Antigravity keeps a Google sign-in in your keychain. Every seat on that Mac uses the last Google account that signed in, and a sign-out in Solus does not remove it from the keychain.
- On mobile, Gemini Enterprise and Vertex AI must be set up once on desktop or web. After that, `/login` on mobile works. Mobile has no seat settings for any provider.
- On a Solus Cloud machine, Settings does not show an Antigravity seat: the account keeps Claude and Codex connections only. On a host where each member is their own OS user, each member has an Antigravity seat folder. The sign-in there is in memory, so a member signs in again after the host restarts. The member's Antigravity sessions are kept on disk, so a session continues after the restart.

The design is in `docs/plans/antigravity-provider.md`.
