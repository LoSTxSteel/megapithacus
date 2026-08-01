const {
  listBansNeedingReminders,
  updateBan,
  getBanById,
  listBansWithEndTimes,
} = require('./banStore');
const { postBanReminder } = require('./banLog');
const { getGuild } = require('./storage');
const { unbanPlayerOnCluster } = require('./nitradoModeration');

const INTERVAL_MS = 30 * 1000; // 30s backup sweep (short test bans need this)
let timer = null;
let clientRef = null;

/** banId:kind -> Timeout */
const scheduled = new Map();

function clearBanSchedule(banId) {
  for (const key of [...scheduled.keys()]) {
    if (key.startsWith(`${banId}:`)) {
      clearTimeout(scheduled.get(key));
      scheduled.delete(key);
    }
  }
}

function scheduleTimer(banId, kind, delayMs) {
  const key = `${banId}:${kind}`;
  if (scheduled.has(key)) {
    clearTimeout(scheduled.get(key));
    scheduled.delete(key);
  }
  if (delayMs > 2147483647) return; // setTimeout max ~24.8d; longer ones rely on sweep
  const handle = setTimeout(() => {
    scheduled.delete(key);
    processBanKind(banId, kind).catch((err) =>
      console.warn(`Scheduled ban ${kind} failed (${banId}):`, err.message)
    );
  }, Math.max(0, delayMs));
  scheduled.set(key, handle);
}

/**
 * Schedule exact 24h / 1h / expiry timers for a ban.
 */
function scheduleBanTimers(ban) {
  if (!ban?.id || !ban.endsAt) return;
  clearBanSchedule(ban.id);

  const ends = new Date(ban.endsAt).getTime();
  if (Number.isNaN(ends)) return;
  const now = Date.now();
  const starts = ban.startsAt ? new Date(ban.startsAt).getTime() : now;
  const duration = ends - starts;

  if (!ban.reminded24h && duration > 24 * 60 * 60 * 1000) {
    const at = ends - 24 * 60 * 60 * 1000;
    if (at > now) scheduleTimer(ban.id, '24h', at - now);
  }

  if (!ban.reminded1h && duration > 60 * 60 * 1000) {
    const at = ends - 60 * 60 * 1000;
    if (at > now) scheduleTimer(ban.id, '1h', at - now);
  }

  if (!ban.expiredNotified) {
    scheduleTimer(ban.id, 'expired', ends - now);
  }
}

function rescheduleAllBans() {
  for (const ban of listBansWithEndTimes()) {
    if (!ban.expiredNotified) scheduleBanTimers(ban);
  }
}

async function autoUnbanIfNeeded(ban) {
  if (ban.autoUnbannedAt) {
    return { skipped: true, already: true };
  }

  const guildConfig = getGuild(ban.guildId);
  const profileLike = {
    gamertag: ban.gamertag || ban.targetGamertag,
    characterName: ban.characterName,
  };

  // Test / no-server guilds: treat as local success
  const hasLiveServers = (guildConfig.servers || []).some(
    (s) => s.serviceId && !String(s.serviceId).startsWith('fake')
  );

  if (!hasLiveServers) {
    updateBan(ban.id, {
      active: false,
      autoUnbannedAt: new Date().toISOString(),
      nitradoExpiry: {
        okCount: 0,
        failCount: 0,
        summary: 'Local/test expiry — no live Nitrado services to unban.',
      },
    });
    return { skipped: true, local: true };
  }

  const nitradoExpiry = await unbanPlayerOnCluster(guildConfig, profileLike);
  if (nitradoExpiry.allFailed) {
    return { ok: false, nitradoExpiry };
  }

  updateBan(ban.id, {
    active: false,
    autoUnbannedAt: new Date().toISOString(),
    nitradoExpiry: {
      okCount: nitradoExpiry.okCount,
      failCount: nitradoExpiry.failCount,
      summary: nitradoExpiry.summary,
    },
  });
  return { ok: true, nitradoExpiry };
}

async function processBanKind(banId, kind) {
  const ban = getBanById(banId);
  if (!ban) return;

  if (kind === '24h' && ban.reminded24h) return;
  if (kind === '1h' && ban.reminded1h) return;
  if (kind === 'expired' && ban.expiredNotified) return;

  // Re-check timing for early/late timer fire
  if (ban.endsAt) {
    const remaining = new Date(ban.endsAt).getTime() - Date.now();
    if (kind === 'expired' && remaining > 2000) {
      scheduleBanTimers(ban);
      return;
    }
    if (kind === '1h' && remaining > 60 * 60 * 1000) return;
    if (kind === '24h' && remaining > 24 * 60 * 60 * 1000) return;
  }

  if (!clientRef) return;
  const guild = await clientRef.guilds.fetch(ban.guildId).catch(() => null);
  if (!guild) return;

  if (kind === 'expired') {
    const unban = await autoUnbanIfNeeded(ban);
    if (unban.ok === false) {
      console.warn(`Auto-unban failed for ${ban.id}:`, unban.nitradoExpiry?.summary);
      // Still try to warn admins so they can unban manually
    }
  }

  const fresh = getBanById(banId) || ban;
  const result = await postBanReminder(guild, fresh, kind);
  if (!result.ok) {
    console.warn(
      `Ban ${kind} notify failed (${banId}): ${result.reason || 'unknown'}`
    );
    // Retry soon via interval sweep — do NOT mark notified
    return;
  }

  if (kind === '24h') updateBan(banId, { reminded24h: true });
  if (kind === '1h') updateBan(banId, { reminded1h: true, reminded24h: true });
  if (kind === 'expired') {
    updateBan(banId, {
      expiredNotified: true,
      reminded1h: true,
      reminded24h: true,
      active: false,
    });
    clearBanSchedule(banId);
  }
}

async function runBanReminders(client) {
  if (client) clientRef = client;
  const due = listBansNeedingReminders();
  for (const { ban, kind } of due) {
    try {
      await processBanKind(ban.id, kind);
    } catch (error) {
      console.warn(`Ban reminder failed (${ban.id}):`, error.message);
    }
  }
}

function onBanCreated(ban) {
  scheduleBanTimers(ban);
  // If already expired (clock skew / 0 delay), process immediately
  if (ban.endsAt && new Date(ban.endsAt).getTime() <= Date.now()) {
    processBanKind(ban.id, 'expired').catch(() => {});
  }
}

function startBanReminders(client) {
  clientRef = client;
  if (timer) clearInterval(timer);

  rescheduleAllBans();

  setTimeout(() => {
    runBanReminders(client).catch((err) =>
      console.warn('Ban reminders startup:', err.message)
    );
  }, 5_000);

  timer = setInterval(() => {
    runBanReminders(client).catch((err) =>
      console.warn('Ban reminders interval:', err.message)
    );
  }, INTERVAL_MS);

  console.log('Ban reminders started (exact timers + 30s sweep)');
}

module.exports = {
  startBanReminders,
  runBanReminders,
  onBanCreated,
  scheduleBanTimers,
  INTERVAL_MS,
};
