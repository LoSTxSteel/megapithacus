const fs = require('fs');
const path = require('path');
const { dataDirFrom } = require('../utils/paths');

const DATA_DIR = dataDirFrom(__dirname);
const BANS_FILE = path.join(DATA_DIR, 'bans.json');

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(BANS_FILE)) {
    fs.writeFileSync(BANS_FILE, JSON.stringify({ bans: [] }, null, 2));
  }
}

function readAll() {
  ensureStore();
  try {
    return JSON.parse(fs.readFileSync(BANS_FILE, 'utf8'));
  } catch {
    return { bans: [] };
  }
}

function writeAll(data) {
  ensureStore();
  fs.writeFileSync(BANS_FILE, JSON.stringify(data, null, 2));
}

function newId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

const DURATIONS = [
  { value: '1h', label: '1 hour', ms: 1 * 60 * 60 * 1000 },
  { value: '6h', label: '6 hours', ms: 6 * 60 * 60 * 1000 },
  { value: '1d', label: '1 day', ms: 24 * 60 * 60 * 1000 },
  { value: '3d', label: '3 days', ms: 3 * 24 * 60 * 60 * 1000 },
  { value: '7d', label: '7 days', ms: 7 * 24 * 60 * 60 * 1000 },
  { value: '14d', label: '14 days', ms: 14 * 24 * 60 * 60 * 1000 },
  { value: '30d', label: '30 days', ms: 30 * 24 * 60 * 60 * 1000 },
  { value: 'perm', label: 'Permanent', ms: null },
  { value: 'custom', label: 'Custom duration…', ms: null },
];

const REASONS = [
  { value: 'cheating', label: 'Cheating / Hacks' },
  { value: 'exploiting', label: 'Exploiting / Duping' },
  { value: 'toxicity', label: 'Toxicity / Harassment' },
  { value: 'racism', label: 'Racism / Hate speech' },
  { value: 'griefing', label: 'Griefing' },
  { value: 'advertising', label: 'Advertising' },
  { value: 'threats', label: 'Threats / Doxxing' },
  { value: 'other', label: 'Other (type custom reason)' },
];

const UNBAN_REASONS = [
  { value: 'appeal', label: 'Appeal accepted' },
  { value: 'mistake', label: 'Banned by mistake' },
  { value: 'early', label: 'Early release' },
  { value: 'timeserved', label: 'Time served' },
  { value: 'other', label: 'Other (type custom reason)' },
];

const MAX_CUSTOM_MS = 365 * 24 * 60 * 60 * 1000;

function durationMeta(value) {
  return DURATIONS.find((d) => d.value === value) || null;
}

function reasonLabel(value) {
  return REASONS.find((r) => r.value === value)?.label || value;
}

function unbanReasonLabel(value) {
  return UNBAN_REASONS.find((r) => r.value === value)?.label || value;
}

/**
 * Parse custom durations like `45m`, `12h`, `2d`, `1w`, or `2 days`.
 * @returns {{ ms: number, label: string } | null}
 */
function parseCustomDuration(input) {
  const raw = String(input || '').trim().toLowerCase();
  if (!raw) return null;

  const match = raw.match(
    /^(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|wk|wks|week|weeks)$/
  );
  if (!match) return null;

  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const unit = match[2];
  let ms;
  let label;

  if (['m', 'min', 'mins', 'minute', 'minutes'].includes(unit)) {
    ms = amount * 60 * 1000;
    label = `${amount} minute${amount === 1 ? '' : 's'}`;
  } else if (['h', 'hr', 'hrs', 'hour', 'hours'].includes(unit)) {
    ms = amount * 60 * 60 * 1000;
    label = `${amount} hour${amount === 1 ? '' : 's'}`;
  } else if (['d', 'day', 'days'].includes(unit)) {
    ms = amount * 24 * 60 * 60 * 1000;
    label = `${amount} day${amount === 1 ? '' : 's'}`;
  } else {
    ms = amount * 7 * 24 * 60 * 60 * 1000;
    label = `${amount} week${amount === 1 ? '' : 's'}`;
  }

  if (ms > MAX_CUSTOM_MS) return null;
  return { ms, label };
}

function createBan(entry) {
  const all = readAll();
  const ban = {
    id: newId(),
    active: true,
    reminded24h: false,
    reminded1h: false,
    expiredNotified: false,
    createdAt: new Date().toISOString(),
    ...entry,
  };
  all.bans.unshift(ban);
  writeAll(all);
  return ban;
}

function updateBan(banId, patch) {
  const all = readAll();
  const idx = all.bans.findIndex((b) => b.id === banId);
  if (idx === -1) return null;
  all.bans[idx] = { ...all.bans[idx], ...patch };
  writeAll(all);
  return all.bans[idx];
}

function listActiveBans(guildId) {
  return readAll().bans.filter((b) => b.guildId === guildId && b.active);
}

/** Total bans issued by the bot (active + lifted), optionally for one guild. */
function countBansIssued(guildId = null) {
  const bans = readAll().bans || [];
  if (!guildId) return bans.length;
  return bans.filter((b) => b.guildId === guildId).length;
}

function matchesPlayerBan(ban, profile) {
  if (!ban || !profile) return false;
  if (profile.id && ban.profileId === profile.id) return true;
  if (profile.gamertag && ban.gamertag && ban.gamertag === profile.gamertag) {
    return true;
  }
  if (
    profile.specimenImplant &&
    ban.specimenImplant &&
    ban.specimenImplant === profile.specimenImplant
  ) {
    return true;
  }
  if (
    profile.gamertag &&
    ban.targetGamertag &&
    ban.targetGamertag === profile.gamertag
  ) {
    return true;
  }
  return false;
}

function findActiveBanForPlayer(guildId, profile) {
  const bans = readAll().bans.filter((b) => b.guildId === guildId && b.active);
  return bans.find((b) => matchesPlayerBan(b, profile)) || null;
}

/**
 * All ban records for a player (active + lifted), newest first.
 */
function listBansForPlayer(guildId, profile) {
  return readAll()
    .bans.filter((b) => b.guildId === guildId && matchesPlayerBan(b, profile))
    .sort((a, b) => {
      const at = new Date(b.startsAt || b.createdAt || 0).getTime();
      const bt = new Date(a.startsAt || a.createdAt || 0).getTime();
      return at - bt;
    });
}

function deactivateBan(banId, patch = {}) {
  return updateBan(banId, {
    active: false,
    expiredNotified: true,
    reminded1h: true,
    reminded24h: true,
    ...patch,
  });
}

function getBanById(banId) {
  return readAll().bans.find((b) => b.id === banId) || null;
}

function listBansWithEndTimes() {
  return readAll().bans.filter((b) => b.endsAt);
}

function listBansNeedingReminders(now = Date.now()) {
  // Include inactive bans that still need an expiry warning posted
  const bans = readAll().bans.filter((b) => b.endsAt);
  const due = [];

  for (const ban of bans) {
    const ends = new Date(ban.endsAt).getTime();
    if (Number.isNaN(ends)) continue;

    const remaining = ends - now;
    if (remaining <= 0 && !ban.expiredNotified) {
      due.push({ ban, kind: 'expired' });
      continue;
    }

    // Pre-expiry warnings only while still "in effect"
    if (!ban.active || ban.expiredNotified) continue;

    if (remaining > 0 && remaining <= 60 * 60 * 1000 && !ban.reminded1h) {
      due.push({ ban, kind: '1h' });
      continue;
    }
    if (
      remaining > 60 * 60 * 1000 &&
      remaining <= 24 * 60 * 60 * 1000 &&
      !ban.reminded24h
    ) {
      due.push({ ban, kind: '24h' });
    }
  }

  return due;
}

module.exports = {
  DURATIONS,
  REASONS,
  UNBAN_REASONS,
  durationMeta,
  reasonLabel,
  unbanReasonLabel,
  parseCustomDuration,
  createBan,
  updateBan,
  deactivateBan,
  listActiveBans,
  countBansIssued,
  findActiveBanForPlayer,
  listBansForPlayer,
  getBanById,
  listBansWithEndTimes,
  listBansNeedingReminders,
};
