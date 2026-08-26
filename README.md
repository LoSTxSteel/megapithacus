# Megapithacus

Discord bot for **ARK: Survival Evolved (Microsoft Store)** clusters hosted on **Nitrado**.

## Features (v1)

- `/management` — admin hub with dropdown categories:
  - Admin Management
  - Server Setup (Nitrado tokens)
  - Server Management (ping roles)
  - Customise Bot
  - Admin Pay
  - Feature Management (**Server Status**, **Ban / Pay / Admin / Chat logging**)
- Feature **Setup** creates a `Megapithacus` category + log forum
- Server Status refreshes every 10 minutes
- Admin / Chat logging: one forum post per map, refresh every 15 minutes
- Player backend DB: logs joins (gamertag, IGN, implant, tribe, map, …)
- `/playersearch` — admin lookup + ban/unban/kick
- `/broadcast` — in-game cluster-wide broadcast (also in `/servermanager`)
- `/pay` — Admin Pay for permitted roles
- `/permissions` — owner-only role gates for Admin Pay
- `/help` — command overview

## Requirements

- Node.js 18+
- Discord bot application
- Nitrado long-life API token (added in Discord via Server Setup)
- ASE Microsoft Store servers on Nitrado

## Setup

```powershell
copy .env.example .env
npm install
npm run deploy
npm start
```

Required env vars: `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`.

## Admin flow

```
/management
→ Server Setup
→ Add Nitrado token
→ Sync servers to bot
→ Feature Management → Setup / Enable features
```

## License

MIT
