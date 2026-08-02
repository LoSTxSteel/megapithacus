const { EmbedBuilder } = require('discord.js');
const { getGuild, listGuildIds, updateGuild } = require('./storage');
const { queryCluster } = require('./nitrado');
const { brandEmbed } = require('../utils/embeds');
const { isFeatureEnabled, isFeatureConfigured } = require('./featureSetup');

const INTERVAL_MS = 5 * 60 * 1000;
let timer = null;

function sanitizeInline(value) {
  return String(value ?? '').replace(/`/g, "'");
}

function formatCount(players, maxPlayers) {
  const max = maxPlayers || '—';
  return `${players}/${max}`;
}

function formatServerBlock(server) {
  const icon = server.online ? '🟢' : '🔴';
  const players = server.online ? Number(server.players) || 0 : 0;
  const count = formatCount(players, server.maxPlayers);
  const name = sanitizeInline(server.name || 'Server');

  return [
    `${icon} \`${name} - ${count}\``,
    `Population: ${count}`,
  ].join('\n');
}

function orderedResults(guildConfig, cluster) {
  const results = cluster?.results || [];
  if (!results.length) return [];

  const byKey = new Map();
  for (const result of results) {
    byKey.set(String(result.serviceId || result.id), result);
  }

  const ordered = [];
  const seen = new Set();
  for (const server of guildConfig.servers || []) {
    const key = String(server.serviceId || server.id);
    const result = byKey.get(key);
    if (result) {
      ordered.push(result);
      seen.add(key);
    }
  }

  for (const result of results) {
    const key = String(result.serviceId || result.id);
    if (!seen.has(key)) ordered.push(result);
  }

  return ordered;
}

function buildPopEmbed(guildConfig, cluster) {
  const blocks = orderedResults(guildConfig, cluster).map(formatServerBlock);
  const description = cluster
    ? blocks.length
      ? blocks.join('\n\n')
      : '_No synced servers._'
    : '_Unable to query servers. Check Server Setup tokens and sync._';

  return brandEmbed(
    new EmbedBuilder()
      .setTitle('Server Status & Population')
      .setDescription(description),
    guildConfig,
    { accent: true, context: 'Server Status · every 5m' }
  );
}

async function refreshGuildPop(client, guildId) {
  const guildConfig = getGuild(guildId);
  if (!isFeatureEnabled(guildConfig, 'popManager')) return;
  if (!isFeatureConfigured(guildConfig, 'popManager')) return;

  const setup = guildConfig.featureSetup.popManager || {};
  // Prefer text channel; legacy installs used a forum thread id
  const channelId = setup.channelId || setup.threadId;
  const { messageId } = setup;
  const discordGuild = await client.guilds.fetch(guildId).catch(() => null);
  if (!discordGuild || !channelId) return;

  const channel = await discordGuild.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased?.()) return;

  if (channel.name === 'pop-manager' && channel.setName) {
    await channel.setName('server-status').catch(() => null);
  }

  let cluster = null;
  if ((guildConfig.servers || []).length && (guildConfig.nitradoAccounts || []).length) {
    cluster = await queryCluster(guildConfig.servers, guildConfig);
  }

  const embed = buildPopEmbed(guildConfig, cluster);

  try {
    const message = messageId
      ? await channel.messages.fetch(messageId).catch(() => null)
      : null;

    if (message) {
      await message.edit({ embeds: [embed] });
      if (message.id !== messageId || !setup.channelId) {
        updateGuild(guildId, {
          featureSetup: {
            popManager: {
              channelId: channel.id,
              messageId: message.id,
            },
          },
        });
      }
    } else {
      const sent = await channel.send({ embeds: [embed] });
      updateGuild(guildId, {
        featureSetup: {
          popManager: {
            channelId: channel.id,
            messageId: sent.id,
          },
        },
      });
    }
  } catch (error) {
    console.warn(`Server Status refresh failed for ${guildId}:`, error.message);
  }
}

async function refreshAll(client) {
  for (const guildId of listGuildIds()) {
    try {
      await refreshGuildPop(client, guildId);
    } catch (error) {
      console.warn(`Server Status error (${guildId}):`, error.message);
    }
  }
}

function startPopManager(client) {
  if (timer) clearInterval(timer);
  // First refresh shortly after boot, then every 5 minutes.
  setTimeout(() => {
    refreshAll(client).catch((err) =>
      console.warn('Server Status startup refresh:', err.message)
    );
  }, 15_000);
  timer = setInterval(() => {
    refreshAll(client).catch((err) =>
      console.warn('Server Status interval:', err.message)
    );
  }, INTERVAL_MS);
  console.log('Server Status scheduler started (every 5 minutes)');
}

module.exports = {
  startPopManager,
  refreshAll,
  refreshGuildPop,
  buildPopEmbed,
  INTERVAL_MS,
};
