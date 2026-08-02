const { getGuild, updateGuild } = require('./storage');

function defaultUserCredits() {
  return {
    seasonal: 0,
    permanent: 0,
    lastBoostCreditPremiumSince: null,
  };
}

function defaultCredits() {
  return { users: {} };
}

function defaultRewards() {
  return {
    boostEnabled: false,
    boostChannelId: null,
    boostSeasonalAmount: 3,
  };
}

function getCredits(guildId) {
  const guild = getGuild(guildId);
  const raw = guild.credits || {};
  return {
    users: { ...(raw.users || {}) },
  };
}

function getRewards(guildId) {
  const guild = getGuild(guildId);
  return {
    ...defaultRewards(),
    ...(guild.rewards || {}),
  };
}

function saveCredits(guildId, credits) {
  updateGuild(guildId, { credits });
}

function saveRewards(guildId, rewards) {
  updateGuild(guildId, { rewards });
}

function normalizeUser(raw) {
  const base = defaultUserCredits();
  return {
    seasonal: Math.max(0, Number(raw?.seasonal) || 0),
    permanent: Math.max(0, Number(raw?.permanent) || 0),
    lastBoostCreditPremiumSince: raw?.lastBoostCreditPremiumSince || null,
  };
}

function getUserCredits(guildId, userId) {
  const credits = getCredits(guildId);
  return normalizeUser(credits.users[String(userId)]);
}

function setUserCredits(guildId, userId, patch) {
  const credits = getCredits(guildId);
  const id = String(userId);
  const current = normalizeUser(credits.users[id]);
  credits.users[id] = normalizeUser({ ...current, ...patch });
  saveCredits(guildId, credits);
  return credits.users[id];
}

function parseAmount(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) {
    return { ok: false, error: 'Amount must be a positive number.' };
  }
  return { ok: true, amount: Math.floor(n) };
}

function assertType(type) {
  if (type !== 'seasonal' && type !== 'permanent') {
    return { ok: false, error: 'Type must be seasonal or permanent.' };
  }
  return { ok: true };
}

function addCredit(guildId, userId, amount, type) {
  const typeCheck = assertType(type);
  if (!typeCheck.ok) return typeCheck;
  const parsed = parseAmount(amount);
  if (!parsed.ok) return parsed;

  const current = getUserCredits(guildId, userId);
  const next = {
    ...current,
    [type]: current[type] + parsed.amount,
  };
  setUserCredits(guildId, userId, next);
  return { ok: true, credits: getUserCredits(guildId, userId), added: parsed.amount };
}

function removeCredit(guildId, userId, amount, type) {
  const typeCheck = assertType(type);
  if (!typeCheck.ok) return typeCheck;
  const parsed = parseAmount(amount);
  if (!parsed.ok) return parsed;

  const current = getUserCredits(guildId, userId);
  const next = {
    ...current,
    [type]: Math.max(0, current[type] - parsed.amount),
  };
  const removed = current[type] - next[type];
  setUserCredits(guildId, userId, next);
  return { ok: true, credits: getUserCredits(guildId, userId), removed };
}

function wipeSeasonal(guildId) {
  const credits = getCredits(guildId);
  let wiped = 0;
  for (const [userId, raw] of Object.entries(credits.users)) {
    const user = normalizeUser(raw);
    if (user.seasonal > 0) wiped += 1;
    credits.users[userId] = { ...user, seasonal: 0 };
  }
  saveCredits(guildId, credits);
  return { ok: true, wiped };
}

function wipePermanent(guildId) {
  const credits = getCredits(guildId);
  let wiped = 0;
  for (const [userId, raw] of Object.entries(credits.users)) {
    const user = normalizeUser(raw);
    if (user.permanent > 0) wiped += 1;
    credits.users[userId] = { ...user, permanent: 0 };
  }
  saveCredits(guildId, credits);
  return { ok: true, wiped };
}

function tryCreditBoost(guildId, userId, premiumSinceTimestamp) {
  if (!premiumSinceTimestamp) {
    return { ok: false, reason: 'no_boost' };
  }
  const key = String(premiumSinceTimestamp);
  const current = getUserCredits(guildId, userId);
  if (current.lastBoostCreditPremiumSince === key) {
    return { ok: false, reason: 'already_credited' };
  }

  const rewards = getRewards(guildId);
  const amount = Math.max(0, Number(rewards.boostSeasonalAmount) || 3);
  const next = {
    ...current,
    seasonal: current.seasonal + amount,
    lastBoostCreditPremiumSince: key,
  };
  setUserCredits(guildId, userId, next);
  return {
    ok: true,
    amount,
    credits: getUserCredits(guildId, userId),
  };
}

function setBoostEnabled(guildId, enabled) {
  const rewards = getRewards(guildId);
  rewards.boostEnabled = Boolean(enabled);
  saveRewards(guildId, rewards);
  return getRewards(guildId);
}

function setBoostChannel(guildId, channelId) {
  const rewards = getRewards(guildId);
  rewards.boostChannelId = channelId ? String(channelId) : null;
  saveRewards(guildId, rewards);
  return getRewards(guildId);
}

module.exports = {
  defaultCredits,
  defaultRewards,
  defaultUserCredits,
  getCredits,
  getRewards,
  getUserCredits,
  addCredit,
  removeCredit,
  wipeSeasonal,
  wipePermanent,
  tryCreditBoost,
  setBoostEnabled,
  setBoostChannel,
};
