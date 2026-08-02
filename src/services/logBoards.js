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

const INTERVAL_MS = 5 * 60 * 1000;
let timer = null;

function persistThreadMessageId(guildId, featureKey, serviceId, entry, messageId) {
  const guild = getGuild(guildId);
  const featureState = { ...(guild.featureSetup[featureKey] || {}) };
  featureState.threads = {
    ...(featureState.threads || {}),
    [serviceId]: { ...entry, messageId },
  };
  updateGuild(guildId, { featureSetup: { [featureKey]: featureState } });
}

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
        persistThreadMessageId(guildId, featureKey, serviceId, entry, message.id);
      }
    } else {
      const sent = await thread.send({ embeds: [embed] });
      persistThreadMessageId(guildId, featureKey, serviceId, entry, sent.id);
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
    console.warn(`Map log forum sync skipped (${guildId}):`, error.message);
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
        server.name || mapData.name || serviceId,
        serviceId,
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
        server.name || mapData.name || serviceId,
        serviceId,
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
  console.log('Log boards scheduler started (every 5 minutes · 3 forums · per-map threads)');
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
