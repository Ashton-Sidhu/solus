# Antigravity

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

`/login` signs in again the way you last signed in.

On a shared host, each member signs in with their own account in Settings → Providers → Your seats. A member's sign-in stays in their own Antigravity profile on the host. In a conversation, `/login` starts the same sign-in.

## In a session

- Choose Antigravity and a model in the model picker. After the first Antigravity session on a host, the picker also lists models your Google account offers that Solus does not know yet.
- Solus answers Antigravity's permission requests from the session's permission mode. Reads are always allowed. In Plan mode, edits and commands are refused.
- A subagent or swarm worker that Antigravity starts shows as a subagent card with its role and prompt. The card does not yet show the subagent's own steps.
- Antigravity's questions show as question cards. A form question shows as a form; you can answer or decline it.
- When Google's API fails during a turn, the turn shows the error, not a success. When you reach your quota or a rate limit, the session waits for the reset, as it does for Claude and Codex.
- A message you send while a turn runs joins that turn (Antigravity 1.5 and later). With an older Antigravity, it waits for the turn to end.
- The slash menu lists Antigravity's own commands, such as `/plan` and `/compact`, after the host has opened its first Antigravity session.
- The slash menu lists your Antigravity skills: the project's (`.gemini/skills`, `.agents/skills`, `.agent/skills`) and your own. A skill you install in Settings → Skills is installed for Antigravity too, and skills in your agent profile reach your Antigravity seat on every host.
- Solus keeps the session's history, so it shows after a restart and on every client. Session search finds the session's messages.
- Insights counts Antigravity turns as their own provider, with their tokens and their cost at Google's API prices (`docs/model-prices.md`). A Google account subscription does not bill these prices; they show what the work would cost on the API.

## Limits

- Solus tools (such as starting other sessions) are not available to Antigravity yet. For the same reason, Antigravity cannot be the model that writes titles and commit text, or the review agent: those answers come back through a Solus tool. Antigravity can be the worker model of child sessions and can run automations.
- You cannot switch an open session to Antigravity, and the session cloud copy does not include Antigravity sessions.
- Antigravity shows no usage meters. A limit shows only when a turn reaches it.
- On mobile, Gemini Enterprise and Vertex AI must be set up once on desktop or web. After that, `/login` on mobile works.

The design is in `docs/plans/antigravity-provider.md`.
