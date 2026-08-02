const { getGuild, listGuildIds, updateGuild, syncServersFromNitrado } = require('./storage');
const {
  isFeatureEnabled,
  isFeatureConfigured,
  ensureMapForums,
  getMapFeatureThread,
} = require('./featureSetup');
const {
  collectPerMapLogs,
  buildMapChatEmbed,
  buildMapAdminEmbed,
} = require('./gameLogs');

const INTERVAL_MS = 10 * 60 * 1000;
let timer = null;

async function editMapFeatureThread(discordGuild, guildId, featureKey, serviceId, embed) {
  const guild = getGuild(guildId);
  const entry = getMapFeatureThread(guild, serviceId, featureKey);
  if (!entry?.threadId) return;

  const thread = await discordGuild.channels.fetch(entry.threadId).catch(() => null);
  if (!thread) return;

  try {
    const message = entry.messageId
      ? await thread.messages.fetch(entry.messageId).catch(() => null)
      : await thread.fetchStarterMessage().catch(() => null);

    if (message) {
      await message.edit({ embeds: [embed] });
      if (message.id !== entry.messageId) {
        const mapForums = { ...(guild.featureSetup.mapForums || {}) };
        const mapEntry = { ...(mapForums[serviceId] || {}) };
        mapEntry.threads = {
          ...(mapEntry.threads || {}),
          [featureKey]: { ...entry, messageId: message.id },
        };
        mapForums[serviceId] = mapEntry;
        updateGuild(guildId, { featureSetup: { mapForums } });
      }
    } else {
      const sent = await thread.send({ embeds: [embed] });
      const mapForums = { ...(getGuild(guildId).featureSetup.mapForums || {}) };
      const mapEntry = { ...(mapForums[serviceId] || {}) };
      mapEntry.threads = {
        ...(mapEntry.threads || {}),
        [featureKey]: { ...entry, messageId: sent.id },
      };
      mapForums[serviceId] = mapEntry;
      updateGuild(guildId, { featureSetup: { mapForums } });
    }
  } catch (error) {
    console.warn(`${featureKey}/${serviceId} refresh failed:`, error.message);
  }
}

async function syncMapForums(discordGuild, guildId) {
  const guild = getGuild(guildId);
  try {
    const ensured = await ensureMapForums(discordGuild, guild);
    if (ensured.discovered?.length) {
      syncServersFromNitrado(guildId, ensured.discovered);
    }
    return getGuild(guildId);
  } catch (error) {
    console.warn(`Map forum sync skipped (${guildId}):`, error.message);
    return guild;
  }
}

async function refreshAdminBoard(client, guildId) {
  const guild = getGuild(guildId);
  if (!isFeatureEnabled(guild, 'adminLogging') || !isFeatureConfigured(guild, 'adminLogging')) {
    return;
  }

  const discordGuild = await client.guilds.fetch(guildId).catch(() => null);
  if (!discordGuild) return;

  const guildFresh = await syncMapForums(discordGuild, guildId);

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
    await editMapFeatureThread(
      discordGuild,
      guildId,
      'adminLogging',
      serviceId,
      buildMapAdminEmbed(
        guildFresh.clusterName,
        mapData.name || server.name,
        mapData.admin || [],
        mapData.error || 'OK',
        guildFresh
      )
    );
  }
}

async function refreshChatBoard(client, guildId) {
  const guild = getGuild(guildId);
  if (!isFeatureEnabled(guild, 'chatLogs') || !isFeatureConfigured(guild, 'chatLogs')) {
    return;
  }

  const discordGuild = await client.guilds.fetch(guildId).catch(() => null);
  if (!discordGuild) return;

  const guildFresh = await syncMapForums(discordGuild, guildId);

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
    await editMapFeatureThread(
      discordGuild,
      guildId,
      'chatLogs',
      serviceId,
      buildMapChatEmbed(
        guildFresh.clusterName,
        mapData.name || server.name,
        mapData.chat || [],
        mapData.error || 'OK',
        guildFresh
      )
    );
  }
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
  console.log('Log boards scheduler started (every 10 minutes · per-map forums)');
}

module.exports = {
  startLogBoards,
  refreshAllLogBoards,
  refreshGuildLogBoards,
  refreshAdminBoard,
  refreshChatBoard,
  syncMapForums,
  INTERVAL_MS,
};
