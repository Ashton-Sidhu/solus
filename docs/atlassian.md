# Atlassian connection

One Atlassian connection gives Solus access to Confluence pages and Jira
issues on one Atlassian Cloud site. Connect it in Settings → Integrations, or
when an agent asks for it in the conversation.

## Two ways to connect

- **Connect with Atlassian.** Sign in with a browser and approve the access
  that Solus asks for. Solus refreshes this grant itself. This option is
  available only when the build of Solus contains an Atlassian OAuth client.
- **Use an API token.** Enter your site (for example `acme.atlassian.net`),
  the email of your Atlassian account, and an API token. Create the token at
  id.atlassian.com → Security → API tokens. Use this option when the build
  has no OAuth client, or when your site admin blocks OAuth apps. When the
  build has no OAuth client, the token form is the only option.

Solus checks the token with Atlassian before it keeps it. If Atlassian refuses
the token, Solus shows the reason and keeps the connection that was there
before. Solus finds which products the token reaches: Jira, Confluence, or
both.

Solus accepts classic and scoped API tokens. A classic token goes to the site
address. A scoped token goes through `api.atlassian.com`. Solus finds the
correct one when you connect.

## When you are signed in to Solus Cloud

Your connections are in your Solus account, so Settings opens the Connections
page of the account website. The Atlassian row there has the same two ways to
connect. Select **Use an API token instead** to paste a token. The cloud does
the same check, keeps the token sealed in your account vault, and gives it to
each host that does work for you. A token replaces a browser sign-in, and a
browser sign-in replaces a token.

## What to know about API tokens

- A token acts as you, with all your Confluence and Jira access. An OAuth
  grant gets only the scopes that Solus asks for.
- When you are not signed in to Solus Cloud, the token stays on the host.
  When you are signed in, it stays in your account vault.
- Solus does not refresh or rotate the token. When Atlassian expires or
  revokes it, connect again with a new token.
- **Disconnect** removes the token from Solus. It does not revoke the token
  at Atlassian. To revoke it, go to id.atlassian.com.
- Settings and the account website show "API token" after the account when
  you connected with a token.

## Where this does not apply

- The mobile app does not show the Atlassian connection yet, for OAuth or
  for a token.
