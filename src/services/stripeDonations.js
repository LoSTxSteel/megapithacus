const { listGuildIds } = require('./storage');
const {
  getStripeConfig,
  findByStripePaymentId,
  createDonationFromStripe,
  parseDiscordIdFromText,
  updateStripeConfig,
} = require('./donations');
const { listSucceededPayments } = require('./stripe');
const { postDonationLog } = require('./donationLog');

const POLL_MS = 5 * 60 * 1000;
const LOOKBACK_MS = 48 * 60 * 60 * 1000;

let timer = null;
let running = false;

function resolveCreds(guildId) {
  const stripe = getStripeConfig(guildId);
  const secretKey = stripe.secretKey || process.env.STRIPE_SECRET_KEY || '';

  if (!stripe.enabled) {
    return { ok: false, reason: 'disabled' };
  }
  if (!secretKey) {
    return { ok: false, reason: 'missing_credentials' };
  }
  return { ok: true, secretKey };
}

async function syncGuildStripe(client, guildId) {
  const creds = resolveCreds(guildId);
  if (!creds.ok) return { ok: false, reason: creds.reason, created: 0 };

  const end = new Date();
  const lastSync = getStripeConfig(guildId).lastSyncAt;
  const startMs = Math.max(
    end.getTime() - LOOKBACK_MS,
    lastSync
      ? new Date(lastSync).getTime() - 60 * 60 * 1000
      : end.getTime() - LOOKBACK_MS
  );

  let payments;
  try {
    payments = await listSucceededPayments({
      secretKey: creds.secretKey,
      createdGte: startMs / 1000,
    });
  } catch (error) {
    console.warn(`Stripe sync failed for ${guildId}:`, error.message);
    return { ok: false, reason: error.message, created: 0 };
  }

  const discordGuild = await client.guilds.fetch(guildId).catch(() => null);
  let created = 0;

  for (const payment of payments) {
    if (!payment.paymentIntentId) continue;
    if (findByStripePaymentId(guildId, payment.paymentIntentId)) continue;

    const meta = payment.metadata || {};
    const noteBlob = [
      payment.note,
      payment.description,
      meta.discord_id,
      meta.discordId,
      meta.discord,
      meta.user_id,
      meta.userId,
    ]
      .filter(Boolean)
      .join(' ');

    const donorId =
      parseDiscordIdFromText(meta.discord_id) ||
      parseDiscordIdFromText(meta.discordId) ||
      parseDiscordIdFromText(noteBlob);

    const result = createDonationFromStripe(guildId, {
      payment,
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

  updateStripeConfig(guildId, { lastSyncAt: end.toISOString() });

  return { ok: true, created, scanned: payments.length };
}

async function syncAllGuilds(client) {
  if (running) return;
  running = true;
  try {
    for (const guildId of listGuildIds()) {
      const creds = resolveCreds(guildId);
      if (!creds.ok) continue;
      await syncGuildStripe(client, guildId);
    }
  } finally {
    running = false;
  }
}

function startStripeDonationSync(client) {
  if (timer) return;
  setTimeout(() => {
    syncAllGuilds(client).catch((err) =>
      console.warn('Stripe donation sync startup:', err.message)
    );
  }, 25_000);
  timer = setInterval(() => {
    syncAllGuilds(client).catch((err) =>
      console.warn('Stripe donation sync:', err.message)
    );
  }, POLL_MS);
  console.log('Stripe donation sync started (poll every 5m)');
}

module.exports = {
  startStripeDonationSync,
  syncGuildStripe,
  syncAllGuilds,
  resolveCreds,
};
