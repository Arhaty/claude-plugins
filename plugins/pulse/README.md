# pulse

A row just above the prompt that lists your Claude Code cloud sessions that are running, queued or
waiting on you. Each title links to the session on claude.ai/code, and a session waiting on you
names the tool it wants approved. When nothing is active, the row hides itself.

```text
☁ 2 cloud: ● Refactor the parser (running ↗)  ◆ Migrate the build (needs you: approve Bash ↗)  ↻ Hide
```

## Prerequisites

- Claude Code signed in with a claude.ai account. Pulse uses the session's own credential, through
  `$.session.authorize()`. With an API key or a third-party provider there is no claude.ai login to
  use: pulse says so once in a toast, draws no row and makes no requests. If you log in during the
  session, it starts after your next turn.
- An interactive terminal or desktop session: those draw the row above the prompt. In `claude -p`
  or an SDK session pulse does nothing.

## Install

```text
/plugin install pulse --marketplace arhaty/claude-plugins
```

Or, with the marketplace already added, `/plugin install pulse@arhaty`.

## What the row shows

Up to four sessions, then `+N more`. Each has a status icon, its title (cut at 28 characters) and
its state:

| Icon | State     | Meaning                                                |
| ---- | --------- | ------------------------------------------------------ |
| ●    | running   | The session is working, or starting up.                |
| ◌    | queued    | The session is queued and has not started yet.         |
| ◆    | needs you | The session is waiting for your approval or an answer. |

A session waiting on a tool approval reads `needs you: approve <tool>`. Idle and archived
sessions, and local sessions shared over Remote Control, are left out.

- **↻** checks again now.
- **Hide** hides the row and stops checking for the rest of the session.

Pulse checks when the session starts, every 60 s after that, and after each of your turns, so a
cloud session you just launched shows up quickly. A check reads up to five pages of 100 sessions.

## Privacy

Pulse has no server and no telemetry. It sends one request per page,
`GET https://api.anthropic.com/v1/code/sessions`, with your session's claude.ai credential. Claude
Code attaches the credential itself; pulse holds only an opaque handle to it. What it reads stays
in the session's memory and is not written to disk.

## Limitations

The endpoint pulse reads is the one Claude Code itself uses to list cloud sessions. It is not a
documented public API and may change without notice. If it does, the row shows the HTTP error, with
a **Retry** button.
