const fs = require('fs');
const path = require('path');
const { dataDirFrom } = require('../utils/paths');

const DATA_DIR = dataDirFrom(__dirname);
const GUILDS_FILE = path.join(DATA_DIR, 'guilds.json');

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(GUILDS_FILE)) {
    fs.writeFileSync(GUILDS_FILE, JSON.stringify({}, null, 2));
  }
}

function readAll() {
  ensureStore();
  return JSON.parse(fs.readFileSync(GUILDS_FILE, 'utf8'));
}

function writeAll(data) {
  ensureStore();
  fs.writeFileSync(GUILDS_FILE, JSON.stringify(data, null, 2));
}

function defaultFeatureSetup() {
  return {
    categoryId: null,
    popManager: { forumId: null, threadId: null, messageId: null },
    banLogging: { forumId: null },
    donationLogging: { forumId: null },
    donationStats: {
      channelId: null,
      lastDailyKey: null,
      lastMonthlyAt: null,
    },
    adminLogging: { ready: false },
    chatLogs: { ready: false },
    joinLeaveLogs: { ready: false },
    /** Per-map forums named after the map */
    mapForums: {},
  };
}

function defaultBotCustom() {
  return {
    nickname: null,
    embedColor: null,
    footerText: null,
  };
}

function defaultPingRoles() {
  return {
    ban: [],
    unban: [],
    kick: [],
    reminder: [],
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
  };
}

function defaultGuild() {
  return {
    clusterName: 'My ASE Cluster',
    platform: 'Microsoft Store',
    hoster: 'Nitrado',
    servers: [],
    nitradoAccounts: [],
    authorisedAdmins: [],
    authorisedEventStaff: [],
    features: {
      popManager: false,
      banLogging: false,
      donationLogging: false,
      donationStats: false,
      adminLogging: false,
      chatLogs: false,
      joinLeaveLogs: false,
    },
    featureSetup: defaultFeatureSetup(),
    botSetupRoleId: null,
    botCustom: defaultBotCustom(),
    pingRoles: defaultPingRoles(),
    permissions: {
      donations: [],
      serverPower: [],
      rewardManager: [],
      creditManager: [],
    },
    credits: defaultCredits(),
    rewards: defaultRewards(),
    donations: {
      currency: 'GBP',
      currencySymbol: '£',
      methods: [],
      records: [],
      statsHistory: [],
      paypal: {
        enabled: false,
        clientId: null,
        clientSecret: null,
        mode: 'live',
        lastSyncAt: null,
      },
      stripe: {
        enabled: false,
        secretKey: null,
        lastSyncAt: null,
      },
    },
    subscription: {
      tier: 'free',
      expiresAt: null,
    },
  };
}

function mergeFeatureSetup(current = {}, patch = {}) {
  const defaults = defaultFeatureSetup();
  const keys = new Set([
    ...Object.keys(defaults),
    ...Object.keys(current || {}),
    ...Object.keys(patch || {}),
  ]);

  const merged = { ...defaults, ...current, ...patch };
  for (const key of keys) {
    if (key === 'categoryId') continue;
    if (
      typeof defaults[key] === 'object' ||
      typeof current[key] === 'object' ||
      typeof patch[key] === 'object'
    ) {
      merged[key] = {
        ...(defaults[key] || {}),
        ...(current[key] || {}),
        ...(patch[key] || {}),
      };
    }
  }
  return merged;
}

function getGuild(guildId) {
  const all = readAll();
  const defaults = defaultGuild();
  if (!all[guildId]) {
    all[guildId] = defaults;
    writeAll(all);
    return structuredClone(all[guildId]);
  }

  const current = all[guildId];
  return {
    ...defaults,
    ...current,
    features: { ...defaults.features, ...(current.features || {}) },
    featureSetup: mergeFeatureSetup(current.featureSetup, {}),
    botCustom: { ...defaults.botCustom, ...(current.botCustom || {}) },
    pingRoles: { ...defaults.pingRoles, ...(current.pingRoles || {}) },
    permissions: {
      ...defaults.permissions,
      ...(current.permissions || {}),
      donations: current.permissions?.donations || [],
      serverPower: current.permissions?.serverPower || [],
      rewardManager: current.permissions?.rewardManager || [],
      creditManager: current.permissions?.creditManager || [],
    },
    credits: {
      ...defaults.credits,
      ...(current.credits || {}),
      users: current.credits?.users || {},
    },
    rewards: {
      ...defaults.rewards,
      ...(current.rewards || {}),
    },
    donations: {
      ...defaults.donations,
      ...(current.donations || {}),
      currency: current.donations?.currency || defaults.donations.currency,
      currencySymbol:
        current.donations?.currencySymbol || defaults.donations.currencySymbol,
      methods: current.donations?.methods || [],
      records: current.donations?.records || [],
      statsHistory: current.donations?.statsHistory || [],
      paypal: {
        ...defaults.donations.paypal,
        ...(current.donations?.paypal || {}),
      },
      stripe: {
        ...defaults.donations.stripe,
        ...(current.donations?.stripe || {}),
      },
    },
    subscription: { ...defaults.subscription, ...(current.subscription || {}) },
    servers: current.servers || [],
    nitradoAccounts: current.nitradoAccounts || [],
    authorisedAdmins: current.authorisedAdmins || [],
    authorisedEventStaff: current.authorisedEventStaff || [],
  };
}

function updateGuild(guildId, patch) {
  const all = readAll();
  const current = all[guildId] || defaultGuild();
  const next = { ...current, ...patch };

  if (patch.features) {
    next.features = { ...(current.features || {}), ...patch.features };
  }
  if (patch.featureSetup) {
    next.featureSetup = mergeFeatureSetup(current.featureSetup, patch.featureSetup);
  }
  if (patch.botCustom) {
    next.botCustom = { ...(current.botCustom || {}), ...patch.botCustom };
  }
  if (patch.pingRoles) {
    next.pingRoles = { ...(current.pingRoles || {}), ...patch.pingRoles };
  }
  if (patch.permissions) {
    next.permissions = {
      ...(current.permissions || {}),
      ...patch.permissions,
    };
  }
  if (patch.credits) {
    next.credits = {
      ...(current.credits || {}),
      ...patch.credits,
      users: patch.credits.users ?? current.credits?.users ?? {},
    };
  }
  if (patch.rewards) {
    next.rewards = {
      ...(current.rewards || {}),
      ...patch.rewards,
    };
  }
  if (patch.donations) {
    next.donations = {
      ...(current.donations || {}),
      ...patch.donations,
      methods: patch.donations.methods ?? current.donations?.methods ?? [],
      records: patch.donations.records ?? current.donations?.records ?? [],
      statsHistory:
        patch.donations.statsHistory ?? current.donations?.statsHistory ?? [],
      paypal: {
        ...(current.donations?.paypal || {}),
        ...(patch.donations.paypal || {}),
      },
      stripe: {
        ...(current.donations?.stripe || {}),
        ...(patch.donations.stripe || {}),
      },
    };
  }

  all[guildId] = next;
  writeAll(all);
  return getGuild(guildId);
}

function listGuildIds() {
  return Object.keys(readAll());
}

function normalizeGamertag(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ');
}

function maskToken(token) {
  const value = String(token || '');
  if (value.length <= 10) return '••••••••';
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function addNitradoAccount(guildId, { label, token }) {
  const guild = getGuild(guildId);
  const cleanToken = String(token || '').trim();
  const cleanLabel = String(label || 'Nitrado account').trim().slice(0, 64) || 'Nitrado account';

  if (!cleanToken || cleanToken.length < 20) {
    return { ok: false, reason: 'invalid' };
  }

  if (guild.nitradoAccounts.some((a) => a.token === cleanToken)) {
    return { ok: false, reason: 'duplicate' };
  }

  const account = {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    label: cleanLabel,
    token: cleanToken,
    addedAt: new Date().toISOString(),
  };

  const nitradoAccounts = [...guild.nitradoAccounts, account];
  updateGuild(guildId, { nitradoAccounts });
  return { ok: true, account, nitradoAccounts };
}

function removeNitradoAccount(guildId, accountId) {
  const guild = getGuild(guildId);
  const before = guild.nitradoAccounts.length;
  const nitradoAccounts = guild.nitradoAccounts.filter((a) => a.id !== accountId);
  const servers = (guild.servers || []).filter((s) => s.accountId !== accountId);
  updateGuild(guildId, { nitradoAccounts, servers });
  return before !== nitradoAccounts.length;
}

function addToList(guildId, listKey, entry, { caseInsensitive = false } = {}) {
  const guild = getGuild(guildId);
  const list = [...(guild[listKey] || [])];
  const value = caseInsensitive ? normalizeGamertag(entry) : entry;
  if (!value) {
    return { added: false, list, reason: 'empty' };
  }

  const exists = caseInsensitive
    ? list.some((item) => item.toLowerCase() === value.toLowerCase())
    : list.includes(value);

  if (exists) {
    return { added: false, list, reason: 'duplicate' };
  }

  list.push(value);
  updateGuild(guildId, { [listKey]: list });
  return { added: true, list };
}

function removeFromList(guildId, listKey, entry, { caseInsensitive = false } = {}) {
  const guild = getGuild(guildId);
  const before = guild[listKey] || [];
  const value = caseInsensitive ? normalizeGamertag(entry) : entry;
  const list = caseInsensitive
    ? before.filter((item) => item.toLowerCase() !== value.toLowerCase())
    : before.filter((item) => item !== value);
  updateGuild(guildId, { [listKey]: list });
  return { removed: list.length !== before.length, list };
}

function addServer(guildId, server) {
  const guild = getGuild(guildId);
  const serviceId = String(server.serviceId).trim();

  if (guild.servers.some((s) => String(s.serviceId) === serviceId)) {
    const err = new Error(`Service ${serviceId} is already registered.`);
    err.code = 'DUPLICATE';
    throw err;
  }

  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const entry = {
    id,
    serviceId,
    accountId: server.accountId || null,
    name: server.name,
    map: server.map || server.name,
  };
  guild.servers.push(entry);
  updateGuild(guildId, { servers: guild.servers });
  return entry;
}

function syncServersFromNitrado(guildId, discovered) {
  const servers = [];

  for (const item of discovered) {
    if (item.error || !item.service) continue;
    const service = item.service;
    const serviceId = String(service.id);
    const name =
      service.details?.name ||
      service.type_human ||
      service.game_human ||
      `Service ${serviceId}`;

    servers.push({
      id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}${serviceId}`,
      serviceId,
      accountId: item.accountId,
      name: String(name).slice(0, 80),
      map: String(name).slice(0, 80),
    });
  }

  updateGuild(guildId, { servers });
  return servers;
}

function removeServer(guildId, target) {
  const guild = getGuild(guildId);
  const needle = String(target).toLowerCase();
  const before = guild.servers.length;
  guild.servers = guild.servers.filter(
    (s) =>
      s.id !== target &&
      String(s.serviceId) !== String(target) &&
      s.name.toLowerCase() !== needle
  );
  updateGuild(guildId, { servers: guild.servers });
  return before !== guild.servers.length;
}

module.exports = {
  getGuild,
  updateGuild,
  listGuildIds,
  addServer,
  removeServer,
  addToList,
  removeFromList,
  addNitradoAccount,
  removeNitradoAccount,
  syncServersFromNitrado,
  normalizeGamertag,
  maskToken,
  defaultGuild,
  defaultFeatureSetup,
  defaultBotCustom,
  defaultPingRoles,
  defaultCredits,
  defaultRewards,
};
