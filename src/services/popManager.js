const { EmbedBuilder } = require('discord.js');
const { getGuild, listGuildIds, updateGuild } = require('./storage');
const { queryCluster } = require('./nitrado');
const { brandEmbed } = require('../utils/embeds');
const { isFeatureEnabled, isFeatureConfigured } = require('./featureSetup');

const INTERVAL_MS = 5 * 60 * 1000;
let timer = null;

function buildPopEmbed(guildConfig, cluster) {
  const lines = (cluster?.results || []).map((server) => {
    const status = server.online ? 'Online' : 'Offline';
    const count = server.online
      ? `${server.players} / ${server.maxPlayers || '—'}`
      : server.error
        ? `error — ${server.error}`
        : `offline (\`${server.status}\`)`;
    return `${status} **${server.name}** — ${count}`;
  });

  const description = cluster
    ? [
        '**Platform:** Microsoft Store ASE · **Host:** Nitrado',
        `**Total players:** ${cluster.totalPlayers} / ${cluster.totalSlots || '—'}`,
        `**Maps online:** ${cluster.onlineMaps} / ${cluster.totalMaps}`,
        '',
        ...(lines.length ? lines : ['_No synced servers._']),
      ].join('\n')
    : '_Unable to query servers. Check Server Setup tokens and sync._';

  return brandEmbed(
    new EmbedBuilder()
      .setTitle(`${guildConfig.clusterName} — Live Population`)
      .setDescription(description),
    guildConfig,
    { accent: true, context: 'Pop · every 5m' }
  );
}

async function refreshGuildPop(client, guildId) {
  const guildConfig = getGuild(guildId);
  if (!isFeatureEnabled(guildConfig, 'popManager')) return;
  if (!isFeatureConfigured(guildConfig, 'popManager')) return;

  const { threadId, messageId } = guildConfig.featureSetup.popManager;
  const discordGuild = await client.guilds.fetch(guildId).catch(() => null);
  if (!discordGuild) return;

  const thread = await discordGuild.channels.fetch(threadId).catch(() => null);
  if (!thread) return;

  let cluster = null;
  if ((guildConfig.servers || []).length && (guildConfig.nitradoAccounts || []).length) {
    cluster = await queryCluster(guildConfig.servers, guildConfig);
  }

  const embed = buildPopEmbed(guildConfig, cluster);

  try {
    const message = messageId
      ? await thread.messages.fetch(messageId).catch(() => null)
      : await thread.fetchStarterMessage().catch(() => null);

    if (message) {
      await message.edit({ embeds: [embed] });
      if (message.id !== messageId) {
        updateGuild(guildId, {
          featureSetup: {
            popManager: {
              ...guildConfig.featureSetup.popManager,
              messageId: message.id,
            },
          },
        });
      }
    } else {
      const sent = await thread.send({ embeds: [embed] });
      updateGuild(guildId, {
        featureSetup: {
          popManager: {
            ...guildConfig.featureSetup.popManager,
            messageId: sent.id,
          },
        },
      });
    }
  } catch (error) {
    console.warn(`Pop Manager refresh failed for ${guildId}:`, error.message);
  }
}

async function refreshAll(client) {
  for (const guildId of listGuildIds()) {
    try {
      await refreshGuildPop(client, guildId);
    } catch (error) {
      console.warn(`Pop Manager error (${guildId}):`, error.message);
    }
  }
}

function startPopManager(client) {
  if (timer) clearInterval(timer);
  // First refresh shortly after boot, then every 5 minutes.
  setTimeout(() => {
    refreshAll(client).catch((err) => console.warn('Pop Manager startup refresh:', err.message));
  }, 15_000);
  timer = setInterval(() => {
    refreshAll(client).catch((err) => console.warn('Pop Manager interval:', err.message));
  }, INTERVAL_MS);
  console.log('Pop Manager scheduler started (every 5 minutes)');
}

module.exports = {
  startPopManager,
  refreshAll,
  refreshGuildPop,
  buildPopEmbed,
  INTERVAL_MS,
};
