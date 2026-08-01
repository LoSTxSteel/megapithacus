const { ChannelType, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const { getGuild, updateGuild, syncServersFromNitrado } = require('./storage');
const { listAllServicesForGuild } = require('./nitrado');
const { brandEmbed } = require('../utils/embeds');

const CATEGORY_NAME = 'Megapithacus';

/** Single live post features (cluster-wide) */
const LIVE_BOARD_FEATURES = new Set(['popManager']);

/** Forum with one post/thread per synced map */
const MAP_FORUM_FEATURES = new Set(['adminLogging', 'chatLogs']);

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
  payLogging: {
    key: 'payLogging',
    label: 'Admin Pay',
    short: 'Approvals and logs for completed events, pay requests, and payouts',
    forumName: 'admin-pay',
    forumTopic:
      'Admin Pay — approve completed events and pay requests. Also records bonuses and payouts.',
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
    short: 'Per-map in-game admin commands from Nitrado — refreshed every 10 minutes',
    forumName: 'admin-logging',
    forumTopic:
      'One forum post per map. In-game admin commands are pulled from Nitrado ASE logs every 10 minutes.',
    refreshMinutes: 10,
    perMap: true,
  },
  chatLogs: {
    key: 'chatLogs',
    label: 'Chat Logs',
    short: 'Per-map in-game chat logs in a forum — refreshed every 10 minutes',
    forumName: 'chat-logs',
    forumTopic: 'One forum post per synced map for in-game chat — refreshed every 10 minutes.',
    refreshMinutes: 10,
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

/**
 * Ensure a forum post exists for each Nitrado service / map.
 * Returns updated mapThreads object.
 */
async function ensureMapForumThreads(discordGuild, forum, featureKey, guildConfig) {
  const meta = FEATURE_META[featureKey];
  const existing = {
    ...((guildConfig.featureSetup[featureKey] || {}).mapThreads || {}),
  };

  const { targets, discovered, errors } = await discoverMapTargets(guildConfig);

  if (!targets.length) {
    const err =
      errors[0] ||
      'No Nitrado services found. Add a token in Server Setup and make sure the account has ASE servers.';
    throw new Error(err);
  }

  for (const target of targets) {
    const prev = existing[target.key];
    let thread = prev?.threadId
      ? await discordGuild.channels.fetch(prev.threadId).catch(() => null)
      : null;

    if (!thread) {
      const created = await forum.threads.create({
        name: target.name,
        message: {
          embeds: [
            emptyBoardEmbed(
              target.name,
              `${meta.label} for **${target.name}** (Nitrado \`${target.key}\`).`,
              meta.refreshMinutes
            ),
          ],
        },
      });
      const starter = await created.fetchStarterMessage();
      existing[target.key] = {
        threadId: created.id,
        messageId: starter?.id || null,
        name: target.name,
        serviceId: target.key,
        accountId: target.accountId || null,
      };
    } else {
      if (thread.name !== target.name) {
        await thread.setName(target.name).catch(() => null);
      }
      let messageId = prev?.messageId;
      if (!messageId) {
        const starter = await thread.fetchStarterMessage().catch(() => null);
        messageId = starter?.id || null;
      }
      existing[target.key] = {
        threadId: thread.id,
        messageId,
        name: target.name,
        serviceId: target.key,
        accountId: target.accountId || prev?.accountId || null,
      };
    }
  }

  return { mapThreads: existing, targets, discovered, errors };
}

/**
 * @param {{ softMaps?: boolean }} [options]
 * softMaps: create the forum even when no Nitrado tokens are linked yet
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

  const forum = await ensureForum(
    discordGuild,
    category,
    meta.forumName,
    meta.forumTopic,
    guildConfig.featureSetup[featureKey]?.forumId
  );

  let featureState = {
    ...(guildConfig.featureSetup[featureKey] || {}),
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

  let setupExtras = {};

  if (MAP_FORUM_FEATURES.has(featureKey)) {
    if (!(guildConfig.nitradoAccounts || []).length) {
      if (!options.softMaps) {
        throw new Error(
          'Add a Nitrado token in **/management → Server Setup** first, then run Setup again.'
        );
      }
      featureState = {
        ...featureState,
        forumId: forum.id,
        mapThreads: {},
      };
      setupExtras = {
        mapCount: 0,
        discoverErrors: [
          'No Nitrado tokens yet — forum created; sync maps later from Server Setup.',
        ],
      };
    } else {
      const { mapThreads, targets, discovered, errors } = await ensureMapForumThreads(
        discordGuild,
        forum,
        featureKey,
        guildConfig
      );

      if (discovered?.length) {
        syncServersFromNitrado(discordGuild.id, discovered);
      }

      featureState = {
        ...featureState,
        forumId: forum.id,
        mapThreads,
      };
      setupExtras = {
        mapCount: targets.length,
        discoverErrors: errors,
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
  const setup = guild.featureSetup?.[key];
  if (!setup?.forumId) return false;
  if (LIVE_BOARD_FEATURES.has(key)) {
    return Boolean(setup.threadId && setup.messageId);
  }
  if (MAP_FORUM_FEATURES.has(key)) {
    // Forum exists; map threads are created on setup/refresh when servers are synced
    return true;
  }
  return true;
}

const KNOWN_CHANNEL_NAMES = new Set([
  ...Object.values(FEATURE_META).map((m) => m.forumName),
  'donation-stats',
]);

module.exports = {
  FEATURE_META,
  LIVE_BOARD_FEATURES,
  MAP_FORUM_FEATURES,
  CATEGORY_NAME,
  KNOWN_CHANNEL_NAMES,
  ensureCategory,
  setupFeature,
  ensureMapForumThreads,
  discoverMapTargets,
  isFeatureEnabled,
  isFeatureConfigured,
  emptyBoardEmbed,
  threadNameForMap,
};
