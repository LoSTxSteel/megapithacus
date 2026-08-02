const { ChannelType, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const { getGuild, updateGuild, syncServersFromNitrado } = require('./storage');
const { listAllServicesForGuild } = require('./nitrado');
const { brandEmbed } = require('../utils/embeds');

const CATEGORY_NAME = 'Megapithacus';

/** Single live post features (cluster-wide) */
const LIVE_BOARD_FEATURES = new Set(['popManager']);

/**
 * Per-map Discord forums named after the map. Each map forum contains
 * feature threads (Chat Logs, Admin Logs, Join / Leave).
 */
const MAP_THREAD_SPECS = {
  chatLogs: {
    threadName: 'Chat Logs',
    blurb: 'In-game chat for this map — refreshed from Nitrado every 10 minutes.',
    refreshMinutes: 10,
  },
  adminLogging: {
    threadName: 'Admin Logs',
    blurb: 'In-game admin commands for this map — refreshed from Nitrado every 10 minutes.',
    refreshMinutes: 10,
  },
  joinLeaveLogs: {
    threadName: 'Join / Leave',
    blurb: 'Player join and leave events for this map (polled every 60 seconds).',
    refreshMinutes: null,
    appendOnly: true,
  },
};

const MAP_FORUM_FEATURES = new Set(Object.keys(MAP_THREAD_SPECS));

const FEATURE_META = {
  popManager: {
    key: 'popManager',
    label: 'Pop Manager',
    short: 'Auto-refreshing cluster population embed every 5 minutes',
    forumName: 'pop-manager',
    forumTopic: 'Live ASE cluster population — updated every 5 minutes by Megapithacus.',
    liveThreadName: 'Live Cluster Population',
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
    short:
      'Forum logs for donations + donation-stats channel (daily totals, trend chart, monthly review)',
    forumName: 'donation-logs',
    forumTopic:
      'Donation logs — money received (auto-confirmed) and Mark as Delivered for rewards.',
    refreshMinutes: null,
  },
  adminLogging: {
    key: 'adminLogging',
    label: 'Admin Logging',
    short: 'Per-map forum (map name) with Admin Logs thread — Nitrado refresh every 10 minutes',
    forumName: null,
    refreshMinutes: 10,
    perMap: true,
  },
  chatLogs: {
    key: 'chatLogs',
    label: 'Chat Logs',
    short: 'Per-map forum (map name) with Chat Logs thread — Nitrado refresh every 10 minutes',
    forumName: null,
    refreshMinutes: 10,
    perMap: true,
  },
  joinLeaveLogs: {
    key: 'joinLeaveLogs',
    label: 'Join / Leave Logs',
    short: 'Per-map forum (map name) with Join / Leave thread — live player traffic',
    forumName: null,
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

async function ensureLiveBoard(discordGuild, forum, meta, guildConfig) {
  const existing = guildConfig.featureSetup[meta.key] || {};
  let threadId = existing.threadId;
  let messageId = existing.messageId;
  let thread = threadId
    ? await discordGuild.channels.fetch(threadId).catch(() => null)
    : null;

  if (!thread) {
    const created = await forum.threads.create({
      name: meta.liveThreadName || meta.label,
      message: {
        embeds: [
          emptyBoardEmbed(
            meta.liveThreadName || meta.label,
            meta.short,
            meta.refreshMinutes
          ),
        ],
      },
    });
    const starter = await created.fetchStarterMessage();
    threadId = created.id;
    messageId = starter?.id || null;
  } else if (!messageId) {
    const starter = await thread.fetchStarterMessage().catch(() => null);
    messageId = starter?.id || null;
  }

  return {
    forumId: forum.id,
    threadId,
    messageId,
  };
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
 * One Discord forum per map (forum name = map name), each with Chat / Admin / Join-Leave threads.
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

  const soft = Boolean(options.softMaps);
  let targets = [];
  let discovered = [];
  let errors = [];

  if (soft && !(guildConfig.nitradoAccounts || []).length) {
    errors = [
      'Map forums skipped — add a Nitrado token and sync maps, then run Setup again.',
    ];
  } else {
    const found = await discoverMapTargets(guildConfig);
    targets = found.targets;
    discovered = found.discovered;
    errors = found.errors;
    if (!targets.length && !soft) {
      throw new Error(
        errors[0] ||
          'No Nitrado services found. Add a token in Server Setup and sync servers.'
      );
    }
  }

  if (discovered?.length) {
    syncServersFromNitrado(discordGuild.id, discovered);
    guildConfig = getGuild(discordGuild.id);
  }

  const existing = {
    ...(getGuild(discordGuild.id).featureSetup?.mapForums || {}),
  };

  for (const target of targets) {
    const prev = existing[target.key] || {};
    let forum = prev.forumId
      ? await discordGuild.channels.fetch(prev.forumId).catch(() => null)
      : null;

    if (!forum || forum.type !== ChannelType.GuildForum) {
      forum = discordGuild.channels.cache.find(
        (c) =>
          c.type === ChannelType.GuildForum &&
          c.parentId === category.id &&
          c.name === target.name
      );
    }

    if (!forum) {
      forum = await discordGuild.channels.create({
        name: target.name,
        type: ChannelType.GuildForum,
        parent: category.id,
        topic: `${target.name} — Chat, Admin, and Join/Leave logs (Nitrado \`${target.key}\`).`,
        reason: 'Megapithacus per-map log forum',
      });
    } else if (forum.name !== target.name) {
      await forum.setName(target.name).catch(() => null);
    }

    const threads = { ...(prev.threads || {}) };
    for (const [featureKey, spec] of Object.entries(MAP_THREAD_SPECS)) {
      const ensured = await ensureThreadInForum(
        forum,
        spec.threadName,
        `${spec.blurb}\nMap: **${target.name}** · Nitrado \`${target.key}\``,
        spec.refreshMinutes,
        guildConfig
      );
      threads[featureKey] = {
        ...ensured,
        threadName: spec.threadName,
      };
    }

    existing[target.key] = {
      forumId: forum.id,
      name: target.name,
      serviceId: target.key,
      accountId: target.accountId || prev.accountId || null,
      threads,
    };
  }

  updateGuild(discordGuild.id, {
    featureSetup: {
      ...(getGuild(discordGuild.id).featureSetup || {}),
      categoryId: category.id,
      mapForums: existing,
    },
  });

  return {
    mapForums: existing,
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
    mapThreads: result.mapForums,
    targets: result.targets,
    discovered: result.discovered,
    errors: result.errors,
  };
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

    featureState = { ready: true };
    setupExtras = {
      mapCount: Object.keys(result.mapForums || {}).length,
      discoverErrors: result.errors || [],
      mapForums: result.mapForums,
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

    if (LIVE_BOARD_FEATURES.has(featureKey)) {
      featureState = {
        ...featureState,
        ...(await ensureLiveBoard(discordGuild, forum, meta, {
          ...guildConfig,
          featureSetup: {
            ...guildConfig.featureSetup,
            [featureKey]: featureState,
          },
        })),
      };
    }
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
    return Boolean(guild.featureSetup?.[key]?.ready);
  }
  const setup = guild.featureSetup?.[key];
  if (!setup?.forumId) return false;
  if (LIVE_BOARD_FEATURES.has(key)) {
    return Boolean(setup.threadId && setup.messageId);
  }
  return true;
}

function getMapForumEntry(guild, serviceId) {
  return guild.featureSetup?.mapForums?.[String(serviceId)] || null;
}

function getMapFeatureThread(guild, serviceId, featureKey) {
  return getMapForumEntry(guild, serviceId)?.threads?.[featureKey] || null;
}

const KNOWN_CHANNEL_NAMES = new Set([
  ...Object.values(FEATURE_META)
    .map((m) => m.forumName)
    .filter(Boolean),
  'donation-stats',
  'admin-logging',
  'chat-logs',
]);

module.exports = {
  FEATURE_META,
  LIVE_BOARD_FEATURES,
  MAP_FORUM_FEATURES,
  MAP_THREAD_SPECS,
  CATEGORY_NAME,
  KNOWN_CHANNEL_NAMES,
  ensureCategory,
  setupFeature,
  ensureMapForums,
  ensureMapForumThreads,
  discoverMapTargets,
  isFeatureEnabled,
  isFeatureConfigured,
  getMapForumEntry,
  getMapFeatureThread,
  emptyBoardEmbed,
  threadNameForMap,
};
