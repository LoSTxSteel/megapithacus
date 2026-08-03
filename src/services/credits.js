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
    boostCreditType: 'seasonal',
    inviteEnabled: false,
    inviteChannelId: null,
    inviteCreditAmount: 1,
    inviteCreditType: 'seasonal',
    invitesRequiredPerReward: 1,
    inviteStats: {},
    inviteAttributions: {},
  };
}

function getCredits(guildId) {
  const guild = getGuild(guildId);
  const raw = guild.credits || {};
  return {
    users: { ...(raw.users || {}) },
  };
}

function normalizeBoostCreditType(type) {
  return type === 'permanent' ? 'permanent' : 'seasonal';
}

function normalizeInviteStats(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [userId, entry] of Object.entries(raw)) {
    out[String(userId)] = {
      invites: Math.max(0, Math.floor(Number(entry?.invites) || 0)),
      rewardsGiven: Math.max(0, Math.floor(Number(entry?.rewardsGiven) || 0)),
    };
  }
  return out;
}

function normalizeInviteAttributions(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [joinedId, entry] of Object.entries(raw)) {
    if (!entry?.inviterId) continue;
    out[String(joinedId)] = {
      inviterId: String(entry.inviterId),
      joinedAt: entry.joinedAt || null,
    };
  }
  return out;
}

function getRewards(guildId) {
  const guild = getGuild(guildId);
  const merged = {
    ...defaultRewards(),
    ...(guild.rewards || {}),
  };
  const boostAmount = Number(merged.boostSeasonalAmount);
  merged.boostSeasonalAmount =
    Number.isFinite(boostAmount) && boostAmount >= 0
      ? Math.floor(boostAmount)
      : 3;
  merged.boostCreditType = normalizeBoostCreditType(merged.boostCreditType);

  const inviteAmount = Number(merged.inviteCreditAmount);
  merged.inviteCreditAmount =
    Number.isFinite(inviteAmount) && inviteAmount >= 0
      ? Math.floor(inviteAmount)
      : 1;
  merged.inviteCreditType = normalizeBoostCreditType(merged.inviteCreditType);

  const perReward = Number(merged.invitesRequiredPerReward);
  merged.invitesRequiredPerReward =
    Number.isFinite(perReward) && perReward >= 1 ? Math.floor(perReward) : 1;

  merged.inviteEnabled = Boolean(merged.inviteEnabled);
  merged.inviteChannelId = merged.inviteChannelId
    ? String(merged.inviteChannelId)
    : null;
  merged.inviteStats = normalizeInviteStats(merged.inviteStats);
  merged.inviteAttributions = normalizeInviteAttributions(
    merged.inviteAttributions
  );
  return merged;
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

function parseNonNegativeAmount(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n < 0) {
    return { ok: false, error: 'Amount must be zero or a positive number.' };
  }
  return { ok: true, amount: Math.floor(n) };
}

function parsePositiveInt(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n < 1) {
    return { ok: false, error: 'Value must be a whole number of at least 1.' };
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
  const type = normalizeBoostCreditType(rewards.boostCreditType);
  if (amount <= 0) {
    return { ok: false, reason: 'zero_amount' };
  }

  const next = {
    ...current,
    [type]: current[type] + amount,
    lastBoostCreditPremiumSince: key,
  };
  setUserCredits(guildId, userId, next);
  return {
    ok: true,
    amount,
    type,
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

function setBoostAmount(guildId, amount) {
  const parsed = parseNonNegativeAmount(amount);
  if (!parsed.ok) return parsed;
  const rewards = getRewards(guildId);
  rewards.boostSeasonalAmount = parsed.amount;
  saveRewards(guildId, rewards);
  return { ok: true, rewards: getRewards(guildId) };
}

function setBoostCreditType(guildId, type) {
  const typeCheck = assertType(type);
  if (!typeCheck.ok) return typeCheck;
  const rewards = getRewards(guildId);
  rewards.boostCreditType = type;
  saveRewards(guildId, rewards);
  return { ok: true, rewards: getRewards(guildId) };
}

function setInviteEnabled(guildId, enabled) {
  const rewards = getRewards(guildId);
  rewards.inviteEnabled = Boolean(enabled);
  saveRewards(guildId, rewards);
  return getRewards(guildId);
}

function setInviteChannel(guildId, channelId) {
  const rewards = getRewards(guildId);
  rewards.inviteChannelId = channelId ? String(channelId) : null;
  saveRewards(guildId, rewards);
  return getRewards(guildId);
}

function setInviteAmount(guildId, amount) {
  const parsed = parseNonNegativeAmount(amount);
  if (!parsed.ok) return parsed;
  const rewards = getRewards(guildId);
  rewards.inviteCreditAmount = parsed.amount;
  saveRewards(guildId, rewards);
  return { ok: true, rewards: getRewards(guildId) };
}

function setInviteCreditType(guildId, type) {
  const typeCheck = assertType(type);
  if (!typeCheck.ok) return typeCheck;
  const rewards = getRewards(guildId);
  rewards.inviteCreditType = type;
  saveRewards(guildId, rewards);
  return { ok: true, rewards: getRewards(guildId) };
}

function setInvitesRequiredPerReward(guildId, amount) {
  const parsed = parsePositiveInt(amount);
  if (!parsed.ok) return parsed;
  const rewards = getRewards(guildId);
  rewards.invitesRequiredPerReward = parsed.amount;
  saveRewards(guildId, rewards);
  return { ok: true, rewards: getRewards(guildId) };
}

function getInviterStats(rewards, inviterId) {
  const id = String(inviterId);
  return (
    rewards.inviteStats[id] || {
      invites: 0,
      rewardsGiven: 0,
    }
  );
}

/**
 * Record a successful attributed invite and grant credit batches when due.
 */
function recordInviteJoin(guildId, joinedUserId, inviterId) {
  if (!joinedUserId || !inviterId) {
    return { ok: false, reason: 'missing_ids' };
  }
  if (String(joinedUserId) === String(inviterId)) {
    return { ok: false, reason: 'self_invite' };
  }

  const rewards = getRewards(guildId);
  const joinedId = String(joinedUserId);
  const inviter = String(inviterId);

  // Already attributed (rejoin edge case) — ignore
  if (rewards.inviteAttributions[joinedId]) {
    return { ok: false, reason: 'already_attributed' };
  }

  const N = Math.max(1, Number(rewards.invitesRequiredPerReward) || 1);
  const amount = Math.max(0, Number(rewards.inviteCreditAmount) || 0);
  const type = normalizeBoostCreditType(rewards.inviteCreditType);
  const stats = getInviterStats(rewards, inviter);

  stats.invites += 1;
  rewards.inviteAttributions[joinedId] = {
    inviterId: inviter,
    joinedAt: new Date().toISOString(),
  };

  let granted = 0;
  const earnedBatches = Math.floor(stats.invites / N);
  while (stats.rewardsGiven < earnedBatches && amount > 0) {
    addCredit(guildId, inviter, amount, type);
    stats.rewardsGiven += 1;
    granted += 1;
  }

  rewards.inviteStats[inviter] = stats;
  saveRewards(guildId, rewards);

  const progressInCycle = stats.invites % N;
  return {
    ok: true,
    invites: stats.invites,
    rewardsGiven: stats.rewardsGiven,
    required: N,
    progressInCycle,
    remainingToReward: progressInCycle === 0 ? 0 : N - progressInCycle,
    granted,
    amount: granted > 0 ? amount : 0,
    type,
  };
}

/**
 * Reverse attribution when a tracked member leaves; claw back credit if below reward floor.
 */
function recordInviteLeave(guildId, leftUserId) {
  const rewards = getRewards(guildId);
  const leftId = String(leftUserId);
  const attr = rewards.inviteAttributions[leftId];
  if (!attr?.inviterId) {
    return { ok: false, reason: 'not_tracked' };
  }

  const inviter = String(attr.inviterId);
  const N = Math.max(1, Number(rewards.invitesRequiredPerReward) || 1);
  const amount = Math.max(0, Number(rewards.inviteCreditAmount) || 0);
  const type = normalizeBoostCreditType(rewards.inviteCreditType);
  const stats = getInviterStats(rewards, inviter);

  stats.invites = Math.max(0, stats.invites - 1);
  delete rewards.inviteAttributions[leftId];

  let clawedBack = 0;
  const earnedBatches = Math.floor(stats.invites / N);
  while (stats.rewardsGiven > earnedBatches && amount > 0) {
    removeCredit(guildId, inviter, amount, type);
    stats.rewardsGiven -= 1;
    clawedBack += 1;
  }

  rewards.inviteStats[inviter] = stats;
  saveRewards(guildId, rewards);

  return {
    ok: true,
    inviterId: inviter,
    invites: stats.invites,
    rewardsGiven: stats.rewardsGiven,
    clawedBack,
    amount: clawedBack > 0 ? amount : 0,
    type,
  };
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
  setBoostAmount,
  setBoostCreditType,
  setInviteEnabled,
  setInviteChannel,
  setInviteAmount,
  setInviteCreditType,
  setInvitesRequiredPerReward,
  recordInviteJoin,
  recordInviteLeave,
};
