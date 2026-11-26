# Save sessions to Solus Cloud

Solus can keep a copy of each session in Solus Cloud: the prompts, the answers, and the code changes of each turn. With a copy, a session can be read when the computer that ran it is off. Without a copy, each conversation stays on its computer, and you read it only from there.

**Save sessions to Solus Cloud** is on by default.

## Where to turn it off

Any one of these turns it off. If one of them says off, the copy is off.

| Where | What it covers |
| --- | --- |
| **Settings → Host → Save sessions to Solus Cloud**, on each host | Every session on that host |
| **Settings → Policy**, the rule **Cloud copy of sessions**, set by an organization owner | The work of that organization, on every host |
| An MDM policy on the computer | Every session on that computer, personal work too. The host switch is then locked. |

An organization policy does not lock the host switch. It stops only the work of that organization. A host that has not yet received the policy of an organization sends nothing of that organization's work.

## Who the copy is for

- **A session on your own computer:** the copy is yours. Only you can read it, and only when you are signed in. The people that you share the session with cannot read it.
- **A session on a cloud machine of your organization:** the copy belongs to the organization. The people who can open the session can read it.

## What Solus Cloud keeps

| | On | Off |
| --- | --- | --- |
| Prompts and answers | Kept | Not kept |
| Tool cards | Kept, with the size of the tool output but not the output | Not kept |
| Code changes of each turn, which can hold code that is not committed | Kept | Not kept |
| The prompt, system prompt, response, and thoughts in Insights | Kept, by the Insights rules | Not kept |
| Insights numbers: model, cost, and times | By the Insights rules | By the Insights rules |
| The session record: title, project folder, branch, repository address, host, status, and times | Kept for sessions on a cloud machine | Kept for sessions on a cloud machine |
| Who the session is shared with | Kept for sessions on a cloud machine | Kept for sessions on a cloud machine |

Solus writes the title from your first prompt. A session on your own computer sends no session record and no share list to Solus Cloud, with the copy on or off.

So for a session on a cloud machine, with the copy off, the correct statement is "Solus Cloud keeps no conversation of the session", not "nothing from a prompt reaches Solus Cloud".

## How Solus reads your sessions

Where Solus reads a session from depends on the setting and on the kind of computer that ran it.

| The session ran on | On | Off |
| --- | --- | --- |
| **Your own computer** | Listed and read from that computer. When it is off, you can read your copy, read-only, if you are signed in. | Read only while that computer is on |
| **A cloud machine of your organization** | Listed from Solus Cloud, also while the machine is stopped. Read from the machine while it is on, else from the copy. | Listed and read only while the machine is on |

Other differences when the copy is off:

- **Search** looks only in the hosts that are on now. If a host does not answer, Solus says that the search is incomplete.
- **Continue on another host** (Run on) needs the first host to be on, because the second host copies the session from it. With the copy on, the second host can also take the session from Solus Cloud, if your Solus Cloud stores sessions.
- **A stopped cloud machine** shows its sessions when it starts again.
- **The phone** keeps the last page of each session that it opened, so you can see it before the host answers. It does not get a session from Solus Cloud.

When Solus cannot read a session because its computer is off and there is no copy, it says: "Solus Cloud has no copy of this session. It is stored only on the machine that ran it."

## When you change the setting

- **Off to on:** a host sends the copy of a session at the next change to that session.
- **On to off:** hosts stop sending. What Solus Cloud already has stays there. For an organization whose policy turns the copy off, Solus does not read that stored copy. You cannot delete the stored copy from Solus yet.
