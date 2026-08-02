# Cybrancee upload guide

Upload **`megapithacus-cybrancee.zip`** in the Cybrancee file manager, then **extract it into the server root**.

After extract you must see these **in the root** (not inside another folder):

- `index.js`
- `package.json`
- `.env`
- `src/` (folder containing `index.js`)

If everything landed inside a subfolder like `Megapithacus/`, move the contents up to the root.

Startup / main file: `index.js`

## Panel settings

| Setting | Value |
|---|---|
| Language / egg | **Node.js** |
| Node version | **18+** (20 recommended) |
| Startup / main file | `index.js` **or** `src/index.js` |
| Install command | `npm install` (panel usually runs this) |

Start command if editable:

```bash
npm start
```

## Environment variables

Create a `.env` file on the host (do **not** upload your local secret zip if you share files). Minimum:

```env
DISCORD_TOKEN=your_bot_token
DISCORD_CLIENT_ID=your_application_id
DISCORD_GUILD_ID=optional_guild_id_for_fast_slash_deploy
```

Copy from `.env.example` and fill in values.

## After first upload

1. Start the bot once so dependencies install.
2. In the console / file manager, run slash command deploy if needed:

```bash
npm run deploy
```

3. In Discord: `/setup` → `/management` → Server Setup (Nitrado) → enable features.

## Notes

- Persistent data is stored under `data/` — keep backups of that folder.
- PayPal / Stripe keys can be set in Discord via `/donatemanage`, or in `.env`.
