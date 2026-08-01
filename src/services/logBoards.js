const { getGuild, listGuildIds, updateGuild, syncServersFromNitrado } = require('./storage');
const {
  isFeatureEnabled,
  isFeatureConfigured,
  ensureMapForumThreads,
} = require('./featureSetup');
const {
  collectPerMapLogs,
  buildMapChatEmbed,
  buildMapAdminEmbed,
} = require('./gameLogs');

const INTERVAL_MS = 10 * 60 * 1000;
let timer = null;

async function editMapThread(discordGuild, featureKey, mapKey, embed, setup) {
  const entry = setup.mapThreads?.[mapKey];
  if (!entry?.threadId) return setup;

  const thread = await discordGuild.channels.fetch(entry.threadId).catch(() => null);
  if (!thread) return setup;

  try {
    const message = entry.messageId
      ? await thread.messages.fetch(entry.messageId).catch(() => null)
      : await thread.fetchStarterMessage().catch(() => null);

    if (message) {
      await message.edit({ embeds: [embed] });
      if (message.id !== entry.messageId) {
        setup = {
          ...setup,
          mapThreads: {
            ...setup.mapThreads,
            [mapKey]: { ...entry, messageId: message.id },
          },
        };
      }
    } else {
      const sent = await thread.send({ embeds: [embed] });
      setup = {
        ...setup,
        mapThreads: {
          ...setup.mapThreads,
          [mapKey]: { ...entry, messageId: sent.id },
        },
      };
    }
  } catch (error) {
    console.warn(`${featureKey}/${mapKey} refresh failed:`, error.message);
  }

  return setup;
}

async function refreshAdminBoard(client, guildId) {
  const guild = getGuild(guildId);
  if (!isFeatureEnabled(guild, 'adminLogging') || !isFeatureConfigured(guild, 'adminLogging')) {
    return;
  }

  const discordGuild = await client.guilds.fetch(guildId).catch(() => null);
  if (!discordGuild) return;

  const forum = await discordGuild.channels
    .fetch(guild.featureSetup.adminLogging.forumId)
    .catch(() => null);
  if (!forum) return;

  let ensured;
  try {
    ensured = await ensureMapForumThreads(
      discordGuild,
      forum,
      'adminLogging',
      guild
    );
  } catch (error) {
    console.warn(`Admin logging thread sync skipped: ${error.message}`);
    return;
  }
  if (ensured.discovered?.length) {
    syncServersFromNitrado(guildId, ensured.discovered);
  }
  let setup = {
    ...guild.featureSetup.adminLogging,
    mapThreads: ensured.mapThreads,
  };
  const guildFresh = getGuild(guildId);

  const collected =
    (guildFresh.nitradoAccounts || []).length
      ? await collectPerMapLogs(guildFresh)
      : { byMap: {}, errors: ['Add Nitrado token first'] };

  for (const server of guildFresh.servers || []) {
    const serviceId = String(server.serviceId);
    const mapData = collected.byMap[serviceId] || {
      name: server.name,
      admin: [],
      error: 'No data',
    };
    setup = await editMapThread(
      discordGuild,
      'adminLogging',
      serviceId,
      buildMapAdminEmbed(
        guildFresh.clusterName,
        mapData.name || server.name,
        mapData.admin || [],
        mapData.error || 'OK',
        guildFresh
      ),
      setup
    );
  }

  updateGuild(guildId, { featureSetup: { adminLogging: setup } });
}

async function refreshChatBoard(client, guildId) {
  const guild = getGuild(guildId);
  if (!isFeatureEnabled(guild, 'chatLogs') || !isFeatureConfigured(guild, 'chatLogs')) {
    return;
  }

  const discordGuild = await client.guilds.fetch(guildId).catch(() => null);
  if (!discordGuild) return;

  const forum = await discordGuild.channels
    .fetch(guild.featureSetup.chatLogs.forumId)
    .catch(() => null);
  if (!forum) return;

  let ensured;
  try {
    ensured = await ensureMapForumThreads(
      discordGuild,
      forum,
      'chatLogs',
      guild
    );
  } catch (error) {
    console.warn(`Chat logging thread sync skipped: ${error.message}`);
    return;
  }
  if (ensured.discovered?.length) {
    syncServersFromNitrado(guildId, ensured.discovered);
  }
  let setup = {
    ...guild.featureSetup.chatLogs,
    mapThreads: ensured.mapThreads,
  };
  const guildFresh = getGuild(guildId);

  const collected =
    (guildFresh.nitradoAccounts || []).length
      ? await collectPerMapLogs(guildFresh)
      : { byMap: {}, errors: ['Add Nitrado token first'] };

  for (const server of guildFresh.servers || []) {
    const serviceId = String(server.serviceId);
    const mapData = collected.byMap[serviceId] || {
      name: server.name,
      chat: [],
      error: 'No data',
    };
    setup = await editMapThread(
      discordGuild,
      'chatLogs',
      serviceId,
      buildMapChatEmbed(
        guildFresh.clusterName,
        mapData.name || server.name,
        mapData.chat || [],
        mapData.error || 'OK',
        guildFresh
      ),
      setup
    );
  }

  updateGuild(guildId, { featureSetup: { chatLogs: setup } });
}

async function refreshGuildLogBoards(client, guildId) {
  await refreshAdminBoard(client, guildId);
  await refreshChatBoard(client, guildId);
}

async function refreshAllLogBoards(client) {
  for (const guildId of listGuildIds()) {
    try {
      await refreshGuildLogBoards(client, guildId);
    } catch (error) {
      console.warn(`Log boards error (${guildId}):`, error.message);
    }
  }
}

function startLogBoards(client) {
  if (timer) clearInterval(timer);
  setTimeout(() => {
    refreshAllLogBoards(client).catch((err) =>
      console.warn('Log boards startup refresh:', err.message)
    );
  }, 20_000);
  timer = setInterval(() => {
    refreshAllLogBoards(client).catch((err) =>
      console.warn('Log boards interval:', err.message)
    );
  }, INTERVAL_MS);
  console.log('Log boards scheduler started (every 10 minutes · per-map Nitrado logs)');
}

module.exports = {
  startLogBoards,
  refreshAllLogBoards,
  refreshGuildLogBoards,
  refreshAdminBoard,
  refreshChatBoard,
  INTERVAL_MS,
};
