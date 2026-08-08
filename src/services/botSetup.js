const { ChannelType, PermissionFlagsBits } = require('discord.js');
const {
  FEATURE_META,
  CATEGORY_NAME,
  KNOWN_CHANNEL_NAMES,
  MAP_FORUM_FEATURES,
  ensureCategory,
  setupFeature,
  ensureMapForums,
  markMapLogFeaturesReady,
} = require('./featureSetup');
const {
  getGuild,
  updateGuild,
  defaultFeatureSetup,
} = require('./storage');
const { brand } = require('../config');
const {
  PERMISSION_AREAS,
  getPermissions,
  setAreaRoles,
} = require('./guildPermissions');

const ADMIN_ROLE_NAME = 'Megapithacus';

async function ensureAdminRole(discordGuild, existingRoleId) {
  if (existingRoleId) {
    const existing = await discordGuild.roles.fetch(existingRoleId).catch(() => null);
    if (existing) return { role: existing, created: false };
  }

  const byName = discordGuild.roles.cache.find(
    (r) => r.name === ADMIN_ROLE_NAME && !r.managed
  );
  if (byName) return { role: byName, created: false };

  const me = discordGuild.members.me;
  const role = await discordGuild.roles.create({
    name: ADMIN_ROLE_NAME,
    color: brand.color,
    hoist: true,
    mentionable: false,
    reason: 'Megapithacus /setup — bot admin role (incl. server power)',
    permissions: [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.EmbedLinks,
      PermissionFlagsBits.AttachFiles,
      PermissionFlagsBits.ReadMessageHistory,
      PermissionFlagsBits.UseApplicationCommands,
    ],
  });

  if (me?.roles?.highest) {
    const targetPos = Math.max(1, me.roles.highest.position - 1);
    await role.setPosition(targetPos).catch(() => null);
  }

  return { role, created: true };
}

function grantRoleToBotAreas(guildId, roleId) {
  const granted = [];
  for (const area of Object.values(PERMISSION_AREAS)) {
    const current = getPermissions(guildId)[area.key] || [];
    if (!current.includes(roleId)) {
      setAreaRoles(guildId, area.key, [...current, roleId]);
    }
    granted.push(area.label);
  }
  return granted;
}

function collectStoredChannelIds(guildConfig) {
  const ids = new Set();
  const setup = guildConfig.featureSetup || {};
  if (setup.categoryId) ids.add(String(setup.categoryId));

  for (const meta of Object.values(FEATURE_META)) {
    const state = setup[meta.key] || {};
    if (state.forumId) ids.add(String(state.forumId));
    if (state.channelId) ids.add(String(state.channelId));
    if (state.threadId) ids.add(String(state.threadId));
    for (const entry of Object.values(state.threads || {})) {
      if (entry?.threadId) ids.add(String(entry.threadId));
    }
    // Legacy nested mapThreads under a feature
    for (const entry of Object.values(state.mapThreads || {})) {
      if (entry?.threadId) ids.add(String(entry.threadId));
    }
  }

  // Legacy: one forum per map
  for (const mapEntry of Object.values(setup.mapForums || {})) {
    if (mapEntry?.forumId) ids.add(String(mapEntry.forumId));
    for (const thread of Object.values(mapEntry?.threads || {})) {
      if (thread?.threadId) ids.add(String(thread.threadId));
    }
  }

  // Legacy donation-stats channel (no longer created)
  if (setup.donationStats?.channelId) {
    ids.add(String(setup.donationStats.channelId));
  }

  return ids;
}

/**
 * Find every Discord channel/category that looks like Megapithacus logging.
 */
async function scanBotChannels(discordGuild, guildConfig) {
  await discordGuild.channels.fetch().catch(() => null);

  const found = new Map();
  const mark = (channel, reason) => {
    if (!channel?.id) return;
    found.set(channel.id, { channel, reason });
  };

  const storedIds = collectStoredChannelIds(guildConfig);
  for (const id of storedIds) {
    const ch = discordGuild.channels.cache.get(id);
    if (ch) mark(ch, 'stored id');
  }

  const categories = discordGuild.channels.cache.filter(
    (c) => c.type === ChannelType.GuildCategory && c.name === CATEGORY_NAME
  );
  for (const category of categories.values()) {
    mark(category, 'Megapithacus category');
    for (const child of discordGuild.channels.cache.values()) {
      if (child.parentId === category.id) {
        mark(child, `under ${CATEGORY_NAME}`);
      }
    }
  }

  for (const channel of discordGuild.channels.cache.values()) {
    if (KNOWN_CHANNEL_NAMES.has(channel.name)) {
      mark(channel, `known name ${channel.name}`);
    }
  }

  return [...found.values()];
}

/**
 * Delete scanned bot channels (forums/text first, then categories).
 */
async function wipeBotChannels(discordGuild, guildConfig) {
  const scanned = await scanBotChannels(discordGuild, guildConfig);
  const nonCategories = scanned.filter(
    (x) => x.channel.type !== ChannelType.GuildCategory
  );
  const categories = scanned.filter(
    (x) => x.channel.type === ChannelType.GuildCategory
  );

  const deleted = [];
  const failed = [];

  for (const { channel, reason } of [...nonCategories, ...categories]) {
    try {
      await channel.delete(`Megapithacus /setup reset (${reason})`);
      deleted.push({ id: channel.id, name: channel.name, reason });
    } catch (error) {
      failed.push({
        id: channel.id,
        name: channel.name,
        error: error.message,
      });
    }
  }

  // Reset feature setup completely (threads/mapForums wholesale-replaced when present)
  updateGuild(discordGuild.id, {
    featureSetup: {
      ...defaultFeatureSetup(),
      mapForums: {},
      adminLogging: { forumId: null, ready: false, threads: {} },
      chatLogs: { forumId: null, ready: false, threads: {} },
      joinLeaveLogs: { forumId: null, ready: false, threads: {} },
      gamerscoreDetection: { channelId: null, ready: false },
      spoofDetection: { channelId: null, ready: false },
    },
    features: {
      popManager: false,
      banLogging: false,
      donationLogging: false,
      adminLogging: false,
      chatLogs: false,
      joinLeaveLogs: false,
      gamerscoreDetection: false,
      spoofDetection: false,
    },
  });

  return { scanned: scanned.length, deleted, failed };
}

async function rebuildLoggingChannels(discordGuild) {
  const created = [];
  const warnings = [];

  const category = await ensureCategory(discordGuild, null);
  updateGuild(discordGuild.id, {
    featureSetup: {
      ...(getGuild(discordGuild.id).featureSetup || {}),
      categoryId: category.id,
    },
  });
  created.push({ type: 'category', name: CATEGORY_NAME, id: category.id });

  const nonMapKeys = Object.keys(FEATURE_META).filter(
    (key) => !MAP_FORUM_FEATURES.has(key)
  );

  for (const key of nonMapKeys) {
    try {
      const result = await setupFeature(discordGuild, key, { softMaps: true });
      const dest = result.channel || result.forum;
      if (dest) {
        created.push({
          type: result.channel ? 'text' : 'forum',
          name:
            result.meta.channelName ||
            result.meta.forumName ||
            result.meta.label,
          id: dest.id,
          key,
        });
      }
      updateGuild(discordGuild.id, {
        features: {
          ...(getGuild(discordGuild.id).features || {}),
          [key]: true,
        },
      });
    } catch (error) {
      warnings.push(`${FEATURE_META[key].label}: ${error.message}`);
    }
  }

  // Create admin-logs / chat-logs / join-leave-logs forums + per-map threads
  try {
    const result = await ensureMapForums(discordGuild, getGuild(discordGuild.id), {
      softMaps: true,
    });
    const states = result.featureStates || {};
    const mapCount = Math.max(
      0,
      ...Object.values(states).map((s) => Object.keys(s.threads || {}).length)
    );
    const ready = mapCount > 0;
    markMapLogFeaturesReady(discordGuild.id, ready);
    updateGuild(discordGuild.id, {
      features: {
        ...(getGuild(discordGuild.id).features || {}),
        adminLogging: true,
        chatLogs: true,
        joinLeaveLogs: true,
      },
    });
    for (const [key, state] of Object.entries(states)) {
      if (state.forumId) {
        created.push({
          type: 'forum',
          name: FEATURE_META[key]?.forumName || key,
          id: state.forumId,
          key,
        });
      }
    }
    created.push({
      type: 'maps',
      name: ready
        ? `${mapCount} map thread(s) in Admin / Chat / Join-Leave forums`
        : 'map log threads (pending Nitrado sync)',
      id: category.id,
      key: 'mapLogs',
    });
    if (result.errors?.length) {
      warnings.push(...result.errors);
    }
    if (!ready) {
      warnings.push(
        'Map log threads will be created when you Sync servers (Server Setup).'
      );
    }
  } catch (error) {
    warnings.push(`Map logs: ${error.message}`);
  }

  return { category, created, warnings };
}

/**
 * Full /setup: Megapithacus role first → wipe → recreate staff-only log channels.
 * Role must exist before channel create so overwrites can allow ViewChannel.
 */
async function runFullSetup(discordGuild) {
  const guildId = discordGuild.id;
  const guildConfig = getGuild(guildId);

  const roleResult = await ensureAdminRole(
    discordGuild,
    guildConfig.botSetupRoleId
  );
  updateGuild(guildId, { botSetupRoleId: roleResult.role.id });
  const areas = grantRoleToBotAreas(guildId, roleResult.role.id);

  const wipe = await wipeBotChannels(discordGuild, getGuild(guildId));
  const rebuild = await rebuildLoggingChannels(discordGuild);

  return {
    wipe,
    rebuild,
    roleResult,
    areas,
  };
}

module.exports = {
  ADMIN_ROLE_NAME,
  ensureAdminRole,
  grantRoleToBotAreas,
  scanBotChannels,
  wipeBotChannels,
  rebuildLoggingChannels,
  runFullSetup,
};
