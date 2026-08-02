const { listGuildIds } = require('./storage');
const {
  getPayPalConfig,
  findByPayPalTransactionId,
  createDonationFromPayPal,
  parseDiscordIdFromText,
  updatePayPalConfig,
} = require('./donations');
const { listReceivedTransactions } = require('./paypal');
const { postDonationLog } = require('./donationLog');

const POLL_MS = 5 * 60 * 1000;
const LOOKBACK_MS = 48 * 60 * 60 * 1000;

let timer = null;
let running = false;

function resolveCreds(guildId) {
  const paypal = getPayPalConfig(guildId);
  const clientId = paypal.clientId || process.env.PAYPAL_CLIENT_ID || '';
  const clientSecret =
    paypal.clientSecret || process.env.PAYPAL_CLIENT_SECRET || '';
  const mode =
    paypal.mode ||
    (process.env.PAYPAL_MODE === 'sandbox' ? 'sandbox' : 'live');

  if (!paypal.enabled) {
    return { ok: false, reason: 'disabled' };
  }
  if (!clientId || !clientSecret) {
    return { ok: false, reason: 'missing_credentials' };
  }
  return { ok: true, clientId, clientSecret, mode };
}

async function syncGuildPayPal(client, guildId) {
  const creds = resolveCreds(guildId);
  if (!creds.ok) return { ok: false, reason: creds.reason, created: 0 };

  const end = new Date();
  const lastSync = getPayPalConfig(guildId).lastSyncAt;
  const start = new Date(
    Math.max(
      end.getTime() - LOOKBACK_MS,
      lastSync
        ? new Date(lastSync).getTime() - 60 * 60 * 1000
        : end.getTime() - LOOKBACK_MS
    )
  );

  let credits;
  try {
    credits = await listReceivedTransactions({
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
      mode: creds.mode,
      startDate: start,
      endDate: end,
    });
  } catch (error) {
    console.warn(`PayPal sync failed for ${guildId}:`, error.message);
    return { ok: false, reason: error.message, created: 0 };
  }

  const discordGuild = await client.guilds.fetch(guildId).catch(() => null);
  let created = 0;

  for (const tx of credits) {
    if (!tx.transactionId) continue;
    if (findByPayPalTransactionId(guildId, tx.transactionId)) continue;

    const noteBlob = [tx.note, tx.customField, tx.invoiceId]
      .filter(Boolean)
      .join(' ');
    const donorId = parseDiscordIdFromText(noteBlob);

    const result = createDonationFromPayPal(guildId, {
      transaction: tx,
      donorId,
    });
    if (!result.ok) continue;

    if (discordGuild) {
      await postDonationLog(discordGuild, result.record).catch((err) =>
        console.warn('Donation log post failed:', err.message)
      );
    }
    created += 1;
  }

  updatePayPalConfig(guildId, { lastSyncAt: end.toISOString() });

  return { ok: true, created, scanned: credits.length };
}

async function syncAllGuilds(client) {
  if (running) return;
  running = true;
  try {
    for (const guildId of listGuildIds()) {
      const creds = resolveCreds(guildId);
      if (!creds.ok) continue;
      await syncGuildPayPal(client, guildId);
    }
  } finally {
    running = false;
  }
}

function startPayPalDonationSync(client) {
  if (timer) return;
  setTimeout(() => {
    syncAllGuilds(client).catch((err) =>
      console.warn('PayPal donation sync startup:', err.message)
    );
  }, 20_000);
  timer = setInterval(() => {
    syncAllGuilds(client).catch((err) =>
      console.warn('PayPal donation sync:', err.message)
    );
  }, POLL_MS);
  console.log('PayPal donation sync started (poll every 5m)');
}

module.exports = {
  startPayPalDonationSync,
  syncGuildPayPal,
  syncAllGuilds,
  resolveCreds,
};
