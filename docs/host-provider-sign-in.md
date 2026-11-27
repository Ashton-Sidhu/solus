# Sign in to a provider after you add a machine

An agent can add a machine for you with `add_host`. You choose the machine on
the **Add machine** card, and Solus pairs it. Often you add the machine to run
work there with one provider, for example "run the tests on my Build Mac with
Antigravity". That provider must be signed in on the new machine.

## What you see

1. You add the machine on the **Add machine** card.
2. The agent passes the provider that the work needs (`provider` on
   `add_host`). The session host reads the new machine's providers.
   - The provider is signed in there: the work continues at once.
   - The provider is not signed in there: the conversation shows the
     **Sign in** card, "Sign in to Google Antigravity on Build Mac".
3. You sign in. The account stays on the new machine, never on the device that
   you sign in from.
4. The new machine reports the sign-in. The session host closes the card on
   every client, and the agent continues the work. You do not type the request
   again.

The agent also learns which providers are ready on the new machine, whether or
not it asked for one.

## The Sign in card

| Action | Desktop and web | Phone |
| --- | --- | --- |
| **Sign in** | Opens the machine's page in Connections, on the **AI providers** tab, and starts the sign-in there. Each provider shows with its own icon. | Signs in from the card: the phone's browser opens the provider's page, and you paste the code here if the provider asks for one. |
| **Manage host** | Opens the machine's page in Connections, on **Overview**. | Opens the machine's page in Settings. |
| **Not now** | The agent does not use that provider on the machine, and asks you what to do. | The same. |

Sending a message while the card is open is the same as **Not now**.

## Back to the conversation

On desktop and web, the conversation comes back by itself. When the card
closes and you are still on that machine's page, Solus shows the conversation
again and puts the cursor in its input. If you went to another page in the
meantime, Solus does not move you.

While the conversation waits, the machine's page shows a bar: "Integration
tests waits for Google Antigravity. It continues when you finish signing in."
Its **Back to the conversation** button returns at once.

## Rules

- Only the new machine says that a provider is signed in. A client's answer to
  the card can only skip it. The session host checks the machine each time the
  machine reports a seat change, and every few seconds.
- The card closes when the run stops. The agent then learns that the sign-in
  did not finish.
- No account name, code, or token goes in the transcript or in the agent's
  answer. The agent learns only `ready`, `needs-sign-in`, or `not-installed`
  for each provider.
