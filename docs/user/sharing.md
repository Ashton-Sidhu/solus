# Share a session

Share a session with people in your organization, a team, the whole organization, or anyone who has its link. The people you share with watch the session live, and you choose if they can also see the changes, suggest messages, or drive the agent.

## Before you start

- **Sign in** to share with people, a team, or your organization. A link works without an account.
- **Link the computer** that runs the session (under Connections in Settings) so that members can reach it. If the computer is not linked, the choices for people, teams, and the organization are not available.
- **Give the computer a route for links.** Link it, or use Tailscale. Solus never sends a link over a plain network address, where anyone on that network could read it.
- **Keep the computer on.** Solus changes who has access on the computer that holds the session, so that computer must be online.

## Share

1. Choose **Share** in the session header. In a narrow window, choose the faces beside it, then **Who can open…**.
2. To add a person, type a name or an email in **Add people by name or email**. A person that you add can edit.
3. Under **Who has access**, choose the general access:
   - **Only you**: nobody else can open it, except the people that you added by name.
   - **A team** or **Everyone in your organization**, with a role.
   - **Anyone with the link**: anyone on the internet who has the link.
4. To send the link, choose **Copy link**.

To change the role of a person, choose their role and select a different one. To remove a person, choose their role, then **Remove access**. To stop all sharing, remove each person, and set the general access to **Only you**.

## Roles

| Role | They can |
| --- | --- |
| **Can view** | Watch the session |
| **Can edit** | Watch and drive the session, and share it |
| **Custom** | Only the actions that you choose. Only a link can have this role, and a session link starts with it. |
| **Owner** | Everything. The person who started the session is its owner. |

Only the owner and editors can change who has access. A viewer can see that a link exists, but cannot copy it.

## What a link lets people do

Open **Advanced** under the link to choose the actions:

| Action | At the start |
| --- | --- |
| **Watch the session**: the conversation, the agent's work, and its plans | On, always |
| **See changes**: the diffs that the agent made | On |
| **Suggest messages**: someone who can prompt sends or dismisses each one | On |
| **Attach files**, with a suggestion or a prompt | On |
| **See files**: every file in the checkout of the session | Off |
| **Prompt directly**: send turns, stop them, and change the queue | Off |
| **Approve tools and answer questions** | Off |
| **Use devices**: simulators and phones connected to the computer | Off |
| **Use app panels** from the agent's tools | Off |

- Turns that a guest sends with **Prompt directly** run on your login.
- **Approve tools and answer questions** lets the guest run commands on your computer. Turn it on only for a person you trust.
- Everything that the agent prints is visible to anyone who can watch. Share only a session that you are comfortable to show.

**Expires** sets how long the link works: 1 hour, 1 day (the default), 7 days, or never. To end a link, choose a different general access. The link and its guests stop at once. If you choose the link again, Solus makes a new link.

## When someone opens the link

The link goes to a different place for each kind of computer:

- **A session on your own computer:** the link goes to that computer. Everyone who opens it is a guest, with the actions of the link.
- **A session on a cloud machine of your organization:** the link goes to Solus Cloud. A member of your organization whose own access is at least that of the link opens the session in the full app, as themselves. Anyone else is a guest.

A guest does not need an account. Their browser keeps their name and color when they come back.

People that you share with by name, or by team, see the session in **Shared with you** and get a notice.

## When the computer is off

- **A session on your own computer:** nobody that you shared with can open it until the computer is back.
- **A session on a cloud machine,** with **Save sessions to Solus Cloud** on ([Save sessions to Solus Cloud](./saving-sessions.md)): people read the last copy in Solus Cloud, read-only. When the machine is back, the live session replaces the copy. With the setting off, nobody can open it until the machine is back.

## On the phone

On the phone, choose **Share with guest** on a session:

- **Create viewer link** makes a link that lets people watch for 24 hours.
- **Copy** or **Share** sends it.
- **Stop sharing by link** turns it off.

To share with people, a team, or the organization, or to choose the actions of a link, use the desktop app or the web app.

## What Solus Cloud keeps

For a session on a cloud machine, Solus Cloud keeps who the session is shared with and with which role, so that a link can find the machine that holds the session. It keeps a hash of the link, never the link itself. For a session on your own computer, the share list stays on that computer.
