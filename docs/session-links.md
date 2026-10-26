# Session links

A session link lets anyone with it open one session, with no account. You decide
what they can do. The design is in `plans/custom-roles.md`.

## Make a link

1. Open the session and choose **Share**.
2. Under **Who has access**, choose **Anyone with the link**.
3. Choose **Copy link** and send it.

To change what the link allows, or how long it lasts, open **Advanced** at the
bottom of the share card. Closed, its row says how many permissions the link
gives and when it expires, for example "4 permissions · expires in 24 hours".

A new session link is **Custom** with these choices on:

| Choice | What a guest can do |
| --- | --- |
| Watch the session (always on) | Read the conversation, the agent's work, and its plans, live |
| See changes | Open the diffs the agent made |
| Suggest messages | Write a message that waits for you to send or dismiss |
| Attach files | Add files to a suggestion or a prompt |

These are off until you turn them on:

| Choice | What a guest can do |
| --- | --- |
| See files | Browse every file in the session's checkout |
| Prompt directly | Send turns, stop them, and change the queue |
| Approve tools and answer questions | Allow what the agent runs, answer its questions, and accept its plans. **This lets the guest run commands on your computer.** Turning it on also turns on Prompt directly. |
| Use devices | Use simulators and phones connected to your computer |
| Use app panels | Use interactive panels from the agent's tools |

Turning on a choice also turns on what it needs: Approve, Use devices, and Use
app panels bring Prompt directly, and Attach files brings Suggest messages.
Turning Prompt directly off turns off the choices that need it. Watch the
session is always on.

A change takes effect at once. Guests who have the link open stay connected and
get the new choices.

You can also choose **Can view** (watch and see everything that can be read) or
**Can edit** (everything, including approvals).

## Suggestions

When a guest can suggest but not prompt, their composer says "Suggest a
message". Their message shows under the queue for everyone who can prompt the
session, with **Send** and **Dismiss**, on desktop, web, and mobile.

- **Send** runs it as your own turn. The agent sees `Message from guest <name>,
  sent by <you>:` before the text, so a guest's text never runs as a command.
- **Dismiss** removes it and its files.
- The guest sees what became of it and can withdraw it while it waits.
- A guest can have three suggestions waiting at a time.
- A suggestion that waits when the computer restarts is lost.

## How long a link lasts

A new link lasts one day. Under **Advanced**, choose the **Expires** menu to make it last 1
hour, 1 day, 7 days, or never expire. When it expires, its guests are
disconnected and the link opens nothing. Set a new expiry to make the same link
work again.

To end a link at once, choose another access.

## Where a link works

A link uses this computer's Solus Cloud link (HTTPS) or its Tailscale address. It
never uses a plain network address, because anyone on that network could read
the link and use it. If neither is available, the dialog says so.

## Limits

- A guest's images must be PNG, JPEG, GIF, or WebP, and must be the type they
  claim. Other files are stored as files.
- The conversation shows what the agent's tools read and wrote, whatever the
  choices say. Do not share a session whose transcript holds something private.
- Custom choices are for session links. A work's link is Can view, Can comment,
  or Can edit.
- Mobile shows and decides suggestions but does not make links yet.
