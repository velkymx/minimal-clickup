# ClickUp Chat

A lightweight AIM/MSN/Discord-style chat client for ClickUp Chat, built with
Vue 3 + TypeScript + [VibeUI](https://github.com/velkymx/vibeui) (Bootstrap 5.3).

Talks directly to the ClickUp public API — v3 Chat endpoints for channels and
messages, v2 for your identity and the workspace member roster. Auth uses a
**personal API key** (`pk_…`), not OAuth.

## Features

- Chat page: channel sidebar with `#` channels and direct messages (Discord-style layout)
- Every other page: LinkedIn / Google Chat style dock — a Messaging tab
  bottom-right, plus up to 3 chat boxes. New DMs and pinned-channel messages
  pop a box automatically (checked every 50s)
- Message history with avatars, compact grouping of consecutive messages,
  reaction and reply-count badges
- Send messages (Enter to send, Shift+Enter for newline)
- Polling for new messages and channel activity (50s) plus exact unread
  counts (pinned channels 1 min, everything else 5 min) — the public API has
  no websocket — with an AIM-style beep on incoming messages
- Light/dark/auto color mode toggle
- DM channels labeled with the other members' usernames

## Setup

```bash
npm install
cp .env.example .env.local   # paste your ClickUp API key
npm run dev
```

Get your API key in ClickUp: avatar → **Settings** → **Apps** → **API Token**.

- `VITE_CLICKUP_API_KEY` — your `pk_…` key (required for auto-connect)
- `VITE_CLICKUP_WORKSPACE_ID` — optional; defaults to your first workspace

No `.env.local`? The app opens a setup dialog instead and keeps the key in
`localStorage`.

## How it works

- `vite.config.ts` proxies `/clickup/*` → `https://api.clickup.com` because the
  ClickUp API does not send CORS headers. The key is sent as the `Authorization`
  header on each request and never leaves your machine except to ClickUp.
- `src/lib/clickup.ts` — typed API client (v2 user/team, v3 chat)
- `src/composables/useChat.ts` — session, roster, channels, messages, polling
- `src/components/` — `AppNavbar`, `ChannelList`, `ChatWindow`, `ChatDock` +
  `ChatBox` (docked chat boxes), `MessageItem`, `SetupModal`

## Production note

The Vite proxy only exists in `npm run dev`. To deploy, put the same rewrite in
front of the static build (nginx `proxy_pass`, Cloudflare Worker, or a tiny
Express server) so `/clickup/*` reaches `api.clickup.com` — ideally injecting
the API key server-side so it never ships to browsers.
