const { ChannelType, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const { getGuild, updateGuild, syncServersFromNitrado } = require('./storage');
const { listAllServicesForGuild } = require('./nitrado');
const { brandEmbed } = require('../utils/embeds');

const CATEGORY_NAME = 'Megapithacus';

/** Live embed posted in a text channel (cluster-wide) */
const TEXT_LIVE_FEATURES = new Set(['popManager']);

/**
 * Three Discord forums (Admin / Chat / Join-Leave). Each holds one thread per map.
 */
const MAP_LOG_FORUM_SPECS = {
  adminLogging: {
    forumName: 'admin-logs',
    forumTopic:
      'In-game admin commands — one thread per map, refreshed from Nitrado every 10 minutes.',
    blurb: 'In-game admin commands for this map — refreshed from Nitrado every 10 minutes.',
    refreshMinutes: 10,
  },
  chatLogs: {
    forumName: 'chat-logs',
    forumTopic:
      'In-game chat — one thread per map, refreshed from Nitrado every 10 minutes.',
    blurb: 'In-game chat for this map — refreshed from Nitrado every 10 minutes.',
    refreshMinutes: 10,
  },
  joinLeaveLogs: {
    forumName: 'join-leave-logs',
    forumTopic:
      'Player join and leave events — one thread per map (polled every 60 seconds).',
    blurb: 'Player join and leave events for this map (polled every 60 seconds).',
    refreshMinutes: null,
    appendOnly: true,
  },
};

const MAP_FORUM_FEATURES = new Set(Object.keys(MAP_LOG_FORUM_SPECS));

/** @deprecated alias — specs are forums now, not per-map threads */
const MAP_THREAD_SPECS = MAP_LOG_FORUM_SPECS;

const FEATURE_META = {
  popManager: {
    key: 'popManager',
    label: 'Pop Manager',
    short: 'Auto-refreshing cluster population embed every 5 minutes',
    channelName: 'pop-manager',
    channelTopic:
      'Live ASE cluster population — updated every 5 minutes by Megapithacus.',
    refreshMinutes: 5,
  },
  banLogging: {
    key: 'banLogging',
    label: 'Ban Logging',
    short: 'Forum logs for bans issued by the bot',
    forumName: 'ban-logging',
    forumTopic:
      'Ban logs from Megapithacus — who banned, who was banned, duration, servers, reason.',
    refreshMinutes: null,
  },
  donationLogging: {
    key: 'donationLogging',
    label: 'Donation Logs',
    short: 'Forum logs for donations (auto-confirm + Mark as Delivered)',
    forumName: 'donation-logs',
    forumTopic:
      'Donation logs — money received (auto-confirmed) and Mark as Delivered for rewards.',
    refreshMinutes: null,
  },
  adminLogging: {
    key: 'adminLogging',
    label: 'Admin Logging',
    short: 'Admin Logs forum with one thread per map — Nitrado refresh every 10 minutes',
    forumName: 'admin-logs',
    forumTopic: MAP_LOG_FORUM_SPECS.adminLogging.forumTopic,
    refreshMinutes: 10,
    perMap: true,
  },
  chatLogs: {
    key: 'chatLogs',
    label: 'Chat Logs',
    short: 'Chat Logs forum with one thread per map — Nitrado refresh every 10 minutes',
    forumName: 'chat-logs',
    forumTopic: MAP_LOG_FORUM_SPECS.chatLogs.forumTopic,
    refreshMinutes: 10,
    perMap: true,
  },
  joinLeaveLogs: {
    key: 'joinLeaveLogs',
    label: 'Join / Leave Logs',
    short: 'Join / Leave forum with one thread per map — live player traffic',
    forumName: 'join-leave-logs',
    forumTopic: MAP_LOG_FORUM_SPECS.joinLeaveLogs.forumTopic,
    refreshMinutes: null,
    perMap: true,
  },
};

function emptyBoardEmbed(title, blurb, minutes, guild = null) {
  return brandEmbed(
    new EmbedBuilder()
      .setTitle(title)
      .setDescription(
        `${blurb}\n\nWaiting for the next refresh${
          minutes ? ` (every **${minutes}** minutes)` : ''
        }.`
      ),
    guild,
    { accent: true, context: 'Feature board' }
  );
}

async function ensureCategory(discordGuild, existingCategoryId) {
  if (existingCategoryId) {
    const existing = await discordGuild.channels.fetch(existingCategoryId).catch(() => null);
    if (existing && existing.type === ChannelType.GuildCategory) {
      return existing;
    }
  }

  const byName = discordGuild.channels.cache.find(
    (c) => c.type === ChannelType.GuildCategory && c.name === CATEGORY_NAME
  );
  if (byName) return byName;

  return discordGuild.channels.create({
    name: CATEGORY_NAME,
    type: ChannelType.GuildCategory,
    reason: 'Megapithacus feature setup',
  });
}

async function ensureForum(discordGuild, category, forumName, topic, existingForumId) {
  if (existingForumId) {
    const existing = await discordGuild.channels.fetch(existingForumId).catch(() => null);
    if (existing && existing.type === ChannelType.GuildForum) {
      return existing;
    }
  }

  const byName = discordGuild.channels.cache.find(
    (c) =>
      c.type === ChannelType.GuildForum &&
      c.parentId === category.id &&
      c.name === forumName
  );
  if (byName) return byName;

  return discordGuild.channels.create({
    name: forumName,
    type: ChannelType.GuildForum,
    parent: category.id,
    topic,
    reason: 'Megapithacus feature setup',
  });
}

async function ensureTextChannel(
  discordGuild,
  category,
  channelName,
  topic,
  existingChannelId
) {
  if (existingChannelId) {
    const existing = await discordGuild.channels
      .fetch(existingChannelId)
      .catch(() => null);
    if (existing && existing.type === ChannelType.GuildText) {
      return existing;
    }
  }

  const byName = discordGuild.channels.cache.find(
    (c) =>
      c.type === ChannelType.GuildText &&
      c.parentId === category.id &&
      c.name === channelName
  );
  if (byName) return byName;

  return discordGuild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    parent: category.id,
    topic,
    reason: 'Megapithacus feature setup',
  });
}

/** Live embed message in a text channel (Pop Manager). */
async function ensureTextLiveBoard(discordGuild, channel, meta, guildConfig) {
  const existing = guildConfig.featureSetup[meta.key] || {};
  let messageId = existing.messageId || null;

  if (messageId) {
    const message = await channel.messages.fetch(messageId).catch(() => null);
    if (message) {
      return { channelId: channel.id, messageId: message.id };
    }
  }

  const sent = await channel.send({
    embeds: [
      emptyBoardEmbed(meta.label, meta.short, meta.refreshMinutes, guildConfig),
    ],
  });

  return { channelId: channel.id, messageId: sent.id };
}

function threadNameForMap(serverName) {
  return String(serverName || 'Map').slice(0, 90);
}

function serviceDisplayName(service, fallbackId) {
  return (
    service?.details?.name ||
    service?.type_human ||
    service?.game_human ||
    service?.type ||
    `Service ${fallbackId}`
  );
}

/**
 * Discover every service on linked Nitrado accounts (plus any already-synced maps).
 */
async function discoverMapTargets(guildConfig) {
  const targets = new Map();

  for (const server of guildConfig.servers || []) {
    targets.set(String(server.serviceId), {
      key: String(server.serviceId),
      name: threadNameForMap(server.name),
      accountId: server.accountId || null,
    });
  }

  if (!(guildConfig.nitradoAccounts || []).length) {
    return {
      targets: [...targets.values()],
      discovered: [],
      errors: ['No Nitrado tokens saved. Add one in Server Setup first.'],
    };
  }

  const discovered = await listAllServicesForGuild(guildConfig);
  const errors = [];

  for (const item of discovered) {
    if (item.error) {
      errors.push(`${item.accountLabel}: ${item.error}`);
      continue;
    }
    if (!item.service?.id) continue;

    const id = String(item.service.id);
    const name = threadNameForMap(serviceDisplayName(item.service, id));
    targets.set(id, {
      key: id,
      name,
      accountId: item.accountId,
      service: item.service,
    });
  }

  return {
    targets: [...targets.values()],
    discovered,
    errors,
  };
}

async function ensureThreadInForum(forum, threadName, blurb, refreshMinutes, guildConfig) {
  const existing = forum.threads?.cache?.find((t) => t.name === threadName);
  if (existing) {
    const starter = await existing.fetchStarterMessage().catch(() => null);
    return { threadId: existing.id, messageId: starter?.id || null };
  }

  // Active threads may not be in cache — search fetched
  try {
    const active = await forum.threads.fetchActive();
    const hit = active.threads.find((t) => t.name === threadName);
    if (hit) {
      const starter = await hit.fetchStarterMessage().catch(() => null);
      return { threadId: hit.id, messageId: starter?.id || null };
    }
  } catch {
    // ignore
  }

  const created = await forum.threads.create({
    name: threadName,
    message: {
      embeds: [
        emptyBoardEmbed(threadName, blurb, refreshMinutes, guildConfig),
      ],
    },
  });
  const starter = await created.fetchStarterMessage().catch(() => null);
  return { threadId: created.id, messageId: starter?.id || null };
}

/**
 * Delete legacy per-map forums (old architecture: one forum named after each map).
 */
async function wipeLegacyMapForums(discordGuild, guildConfig) {
  const legacy = guildConfig.featureSetup?.mapForums || {};
  const deleted = [];

  for (const entry of Object.values(legacy)) {
    const forumId = entry?.forumId;
    if (!forumId) continue;
    const channel = await discordGuild.channels.fetch(forumId).catch(() => null);
    if (!channel) continue;
    try {
      await channel.delete('Megapithacus migrate: per-feature forums replace per-map forums');
      deleted.push(forumId);
    } catch {
      // ignore — full /setup wipe will catch leftovers under Megapithacus
    }
  }

  return deleted;
}

function emptyMapLogFeatureState(existingForumId = null) {
  return {
    forumId: existingForumId || null,
    ready: false,
    threads: {},
  };
}

/**
 * Three forums (admin-logs, chat-logs, join-leave-logs), each with one thread per map.
 * Thread keys are Nitrado service IDs (stable). Thread names are map/server display names.
 */
async function ensureMapForums(discordGuild, guildConfig, options = {}) {
  const category = await ensureCategory(
    discordGuild,
    guildConfig.featureSetup?.categoryId
  );

  updateGuild(discordGuild.id, {
    featureSetup: {
      ...(getGuild(discordGuild.id).featureSetup || {}),
      categoryId: category.id,
    },
  });

  // Drop old per-map forums so we never keep dual systems
  if (Object.keys(guildConfig.featureSetup?.mapForums || {}).length) {
    await wipeLegacyMapForums(discordGuild, guildConfig);
    updateGuild(discordGuild.id, {
      featureSetup: { mapForums: {} },
    });
    guildConfig = getGuild(discordGuild.id);
  }

  const soft = Boolean(options.softMaps);
  const found = await discoverMapTargets(guildConfig);
  let targets = found.targets;
  let discovered = found.discovered;
  let errors = found.errors;

  if (!targets.length) {
    if (!soft) {
      throw new Error(
        errors[0] ||
          'No Nitrado services found. Add a token in Server Setup and sync servers.'
      );
    }
    if (!(guildConfig.nitradoAccounts || []).length) {
      errors = [
        'Map log threads pending — add a Nitrado token and use Sync servers.',
        ...errors,
      ];
    } else if (!errors.length) {
      errors = [
        'Map log threads pending — Sync servers to import maps, then threads are created automatically.',
      ];
    }
  }

  if (discovered?.length) {
    syncServersFromNitrado(discordGuild.id, discovered);
    guildConfig = getGuild(discordGuild.id);
  }

  const featureStates = {};

  for (const [featureKey, spec] of Object.entries(MAP_LOG_FORUM_SPECS)) {
    const prev = getGuild(discordGuild.id).featureSetup?.[featureKey] || {};
    const forum = await ensureForum(
      discordGuild,
      category,
      spec.forumName,
      spec.forumTopic,
      prev.forumId || null
    );

    const threads = {};
    for (const target of targets) {
      const prevThread = prev.threads?.[target.key] || {};
      const ensured = await ensureThreadInForum(
        forum,
        target.name,
        `${spec.blurb}\nMap: **${target.name}** · Nitrado \`${target.key}\``,
        spec.refreshMinutes,
        guildConfig
      );
      threads[target.key] = {
        threadId: ensured.threadId,
        messageId: ensured.messageId || prevThread.messageId || null,
        threadName: target.name,
        serviceId: target.key,
        accountId: target.accountId || prevThread.accountId || null,
      };
    }

    featureStates[featureKey] = {
      forumId: forum.id,
      ready: Object.keys(threads).length > 0,
      threads,
    };
  }

  updateGuild(discordGuild.id, {
    featureSetup: {
      ...(getGuild(discordGuild.id).featureSetup || {}),
      categoryId: category.id,
      mapForums: {},
      ...featureStates,
    },
  });

  return {
    mapForums: featureStates,
    featureStates,
    targets,
    discovered,
    errors,
    category,
  };
}

/** @deprecated Use ensureMapForums — kept for callers during migration */
async function ensureMapForumThreads(discordGuild, _forum, _featureKey, guildConfig) {
  const result = await ensureMapForums(discordGuild, guildConfig);
  return {
    mapThreads: result.featureStates,
    targets: result.targets,
    discovered: result.discovered,
    errors: result.errors,
  };
}

/**
 * Mark per-map logging features ready when forums + threads exist.
 */
function markMapLogFeaturesReady(guildId, ready = true) {
  const guild = getGuild(guildId);
  const patch = {};
  for (const key of MAP_FORUM_FEATURES) {
    const current = guild.featureSetup?.[key] || {};
    patch[key] = {
      ...current,
      ready: Boolean(ready) && Boolean(current.forumId),
    };
  }
  return updateGuild(guildId, { featureSetup: patch });
}

/**
 * @param {{ softMaps?: boolean }} [options]
 */
async function setupFeature(discordGuild, featureKey, options = {}) {
  const meta = FEATURE_META[featureKey];
  if (!meta) {
    throw new Error(`Unknown feature: ${featureKey}`);
  }

  const me = discordGuild.members.me;
  if (!me?.permissions.has(PermissionFlagsBits.ManageChannels)) {
    throw new Error(
      'I need the **Manage Channels** permission to create the feature category and forums.'
    );
  }

  const guildConfig = getGuild(discordGuild.id);
  const category = await ensureCategory(discordGuild, guildConfig.featureSetup.categoryId);

  let forum = null;
  let channel = null;
  let featureState = { ...(guildConfig.featureSetup[featureKey] || {}) };
  let setupExtras = {};

  if (MAP_FORUM_FEATURES.has(featureKey)) {
    if (
      !options.softMaps &&
      !(guildConfig.nitradoAccounts || []).length &&
      !(guildConfig.servers || []).length
    ) {
      throw new Error(
        'Add a Nitrado token in **/management → Server Setup** first, then run Setup again.'
      );
    }

    const result = await ensureMapForums(discordGuild, getGuild(discordGuild.id), {
      softMaps: options.softMaps,
    });

    const states = result.featureStates || {};
    const mapCount = Object.keys(states[featureKey]?.threads || {}).length;
    featureState = states[featureKey] || emptyMapLogFeatureState();
    setupExtras = {
      mapCount,
      discoverErrors: result.errors || [],
      featureStates: states,
      forum: states[featureKey]?.forumId
        ? await discordGuild.channels.fetch(states[featureKey].forumId).catch(() => null)
        : null,
    };
    forum = setupExtras.forum;
  } else if (TEXT_LIVE_FEATURES.has(featureKey)) {
    channel = await ensureTextChannel(
      discordGuild,
      category,
      meta.channelName,
      meta.channelTopic,
      guildConfig.featureSetup[featureKey]?.channelId
    );

    featureState = {
      ...(await ensureTextLiveBoard(discordGuild, channel, meta, {
        ...guildConfig,
        featureSetup: {
          ...guildConfig.featureSetup,
          [featureKey]: { channelId: channel.id },
        },
      })),
    };
  } else {
    forum = await ensureForum(
      discordGuild,
      category,
      meta.forumName,
      meta.forumTopic,
      guildConfig.featureSetup[featureKey]?.forumId
    );

    featureState = {
      ...featureState,
      forumId: forum.id,
    };
  }

  const updated = updateGuild(discordGuild.id, {
    featureSetup: {
      categoryId: category.id,
      [featureKey]: featureState,
    },
  });

  return {
    category,
    forum,
    channel,
    config: updated,
    meta,
    ...setupExtras,
  };
}

function isFeatureEnabled(guild, key) {
  return Boolean(guild.features?.[key]);
}

function isFeatureConfigured(guild, key) {
  if (MAP_FORUM_FEATURES.has(key)) {
    const setup = guild.featureSetup?.[key];
    return Boolean(setup?.ready && setup?.forumId);
  }
  const setup = guild.featureSetup?.[key];
  if (!setup) return false;
  if (TEXT_LIVE_FEATURES.has(key)) {
    // channelId preferred; legacy forum-thread installs used threadId
    const destId = setup.channelId || setup.threadId;
    return Boolean(destId && setup.messageId);
  }
  return Boolean(setup.forumId);
}

/** @deprecated old per-map forum entry — use getMapFeatureThread */
function getMapForumEntry(guild, serviceId) {
  const sid = String(serviceId);
  const threads = {};
  for (const key of MAP_FORUM_FEATURES) {
    const entry = guild.featureSetup?.[key]?.threads?.[sid];
    if (entry) threads[key] = entry;
  }
  if (!Object.keys(threads).length) return null;
  return { serviceId: sid, threads };
}

function getMapFeatureThread(guild, serviceId, featureKey) {
  return guild.featureSetup?.[featureKey]?.threads?.[String(serviceId)] || null;
}

function countMapLogThreads(guild, featureKey = null) {
  if (featureKey) {
    return Object.keys(guild.featureSetup?.[featureKey]?.threads || {}).length;
  }
  let max = 0;
  for (const key of MAP_FORUM_FEATURES) {
    max = Math.max(max, Object.keys(guild.featureSetup?.[key]?.threads || {}).length);
  }
  return max;
}

const KNOWN_CHANNEL_NAMES = new Set([
  ...Object.values(FEATURE_META)
    .map((m) => m.forumName || m.channelName)
    .filter(Boolean),
  // Legacy channels wiped on /setup reset (no longer created)
  'donation-stats',
  'admin-logging',
  'Admin Logs',
  'Chat Logs',
  'Join / Leave',
  'Join Leave',
]);

module.exports = {
  FEATURE_META,
  TEXT_LIVE_FEATURES,
  /** @deprecated alias — pop manager is a text channel now */
  LIVE_BOARD_FEATURES: TEXT_LIVE_FEATURES,
  MAP_FORUM_FEATURES,
  MAP_LOG_FORUM_SPECS,
  MAP_THREAD_SPECS,
  CATEGORY_NAME,
  KNOWN_CHANNEL_NAMES,
  ensureCategory,
  ensureTextChannel,
  setupFeature,
  ensureMapForums,
  ensureMapForumThreads,
  markMapLogFeaturesReady,
  discoverMapTargets,
  isFeatureEnabled,
  isFeatureConfigured,
  getMapForumEntry,
  getMapFeatureThread,
  countMapLogThreads,
  emptyBoardEmbed,
  threadNameForMap,
};
