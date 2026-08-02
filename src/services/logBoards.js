const { getGuild, listGuildIds, updateGuild, syncServersFromNitrado } = require('./storage');
const {
  isFeatureEnabled,
  isFeatureConfigured,
  ensureMapForums,
  getMapFeatureThread,
  countMapLogThreads,
} = require('./featureSetup');
const {
  collectPerMapLogs,
  buildMapChatEmbed,
  buildMapAdminEmbed,
} = require('./gameLogs');

const INTERVAL_MS = 5 * 60 * 1000;
let timer = null;

/** Warn once per guild/feature/service about missing threads (avoid 5m spam). */
const missingThreadWarned = new Set();
const skipConfiguredWarned = new Set();

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
  if (!entry?.threadId) {
    const warnKey = `${guildId}:${featureKey}:${serviceId}`;
    if (!missingThreadWarned.has(warnKey)) {
      missingThreadWarned.add(warnKey);
      console.warn(
        `[logBoards] ${featureKey} missing map thread guild=${guildId} serviceId=${serviceId} — run Feature Setup or Sync servers`
      );
    }
    return;
  }

  const thread = await discordGuild.channels.fetch(entry.threadId).catch(() => null);
  if (!thread) {
    const warnKey = `gone:${guildId}:${featureKey}:${serviceId}`;
    if (!missingThreadWarned.has(warnKey)) {
      missingThreadWarned.add(warnKey);
      console.warn(
        `[logBoards] ${featureKey} thread gone guild=${guildId} serviceId=${serviceId} threadId=${entry.threadId}`
      );
    }
    return;
  }

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
    console.warn(
      `[logBoards] ${featureKey}/${serviceId} refresh failed guild=${guildId}: ${error.message}`
    );
  }
}

async function syncMapForums(discordGuild, guildId) {
  const guild = getGuild(guildId);
  try {
    // Do not pass softMaps — empty discovery must throw (caught below) so we
    // never overwrite existing threads with an empty map.
    const ensured = await ensureMapForums(discordGuild, guild);
    if (ensured.discovered?.length) {
      syncServersFromNitrado(guildId, ensured.discovered);
    }
    return getGuild(guildId);
  } catch (error) {
    console.warn(`[logBoards] map forum sync skipped guild=${guildId}: ${error.message}`);
    return guild;
  }
}

/**
 * Feature enabled + (configured OR has forum) — sync first so migration can set ready/threads.
 */
function shouldRefreshMapLogs(guild, featureKey) {
  if (!isFeatureEnabled(guild, featureKey)) return false;
  if (isFeatureConfigured(guild, featureKey)) return true;
  const setup = guild.featureSetup?.[featureKey];
  // Soft-allow: forum exists or map threads already stored (pre-ready migration)
  return Boolean(setup?.forumId || countMapLogThreads(guild, featureKey));
}

/**
 * @param {import('discord.js').Client} client
 * @param {string} guildId
 * @param {{ byMap?: Record<string, any>, errors?: string[] } | null} [precollected]
 * @param {any} [guildFreshIn]
 */
async function refreshAdminBoard(client, guildId, precollected = null, guildFreshIn = null) {
  const guild = getGuild(guildId);
  if (!isFeatureEnabled(guild, 'adminLogging')) return;

  if (!shouldRefreshMapLogs(guild, 'adminLogging')) {
    const key = `${guildId}:adminLogging`;
    if (!skipConfiguredWarned.has(key)) {
      skipConfiguredWarned.add(key);
      console.warn(
        `[logBoards] adminLogging enabled but not set up guild=${guildId} — run Setup on Admin Logging`
      );
    }
    return;
  }

  const discordGuild = await client.guilds.fetch(guildId).catch(() => null);
  if (!discordGuild) return;

  const guildFresh = guildFreshIn || (await syncMapForums(discordGuild, guildId));
  if (!countMapLogThreads(guildFresh, 'adminLogging')) {
    const key = `${guildId}:adminLogging:nothreads`;
    if (!skipConfiguredWarned.has(key)) {
      skipConfiguredWarned.add(key);
      console.warn(
        `[logBoards] adminLogging has no map threads guild=${guildId} — Sync servers / Feature Setup`
      );
    }
    return;
  }

  const collected =
    precollected ||
    ((guildFresh.nitradoAccounts || []).length
      ? await collectPerMapLogs(guildFresh, guildId)
      : { byMap: {}, errors: ['Add Nitrado token first'] });

  if (!precollected && collected.errors?.length) {
    console.warn(
      `[logBoards] adminLogging pull errors guild=${guildId}: ${collected.errors
        .slice(0, 5)
        .join('; ')}`
    );
  }

  for (const server of guildFresh.servers || []) {
    const serviceId = String(server.serviceId);
    const mapData = collected.byMap[serviceId] || {
      name: server.name,
      admin: [],
      error: 'No data',
    };
    // Keep last Discord message when rate-limited with stale data.
    if (mapData.rateLimited && mapData.stale) continue;
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

/**
 * @param {import('discord.js').Client} client
 * @param {string} guildId
 * @param {{ byMap?: Record<string, any>, errors?: string[] } | null} [precollected]
 * @param {any} [guildFreshIn]
 */
async function refreshChatBoard(client, guildId, precollected = null, guildFreshIn = null) {
  const guild = getGuild(guildId);
  if (!isFeatureEnabled(guild, 'chatLogs')) return;

  if (!shouldRefreshMapLogs(guild, 'chatLogs')) {
    const key = `${guildId}:chatLogs`;
    if (!skipConfiguredWarned.has(key)) {
      skipConfiguredWarned.add(key);
      console.warn(
        `[logBoards] chatLogs enabled but not set up guild=${guildId} — run Setup on Chat Logs`
      );
    }
    return;
  }

  const discordGuild = await client.guilds.fetch(guildId).catch(() => null);
  if (!discordGuild) return;

  const guildFresh = guildFreshIn || (await syncMapForums(discordGuild, guildId));
  if (!countMapLogThreads(guildFresh, 'chatLogs')) {
    const key = `${guildId}:chatLogs:nothreads`;
    if (!skipConfiguredWarned.has(key)) {
      skipConfiguredWarned.add(key);
      console.warn(
        `[logBoards] chatLogs has no map threads guild=${guildId} — Sync servers / Feature Setup`
      );
    }
    return;
  }

  const collected =
    precollected ||
    ((guildFresh.nitradoAccounts || []).length
      ? await collectPerMapLogs(guildFresh, guildId)
      : { byMap: {}, errors: ['Add Nitrado token first'] });

  if (!precollected && collected.errors?.length) {
    console.warn(
      `[logBoards] chatLogs pull errors guild=${guildId}: ${collected.errors
        .slice(0, 5)
        .join('; ')}`
    );
  }

  for (const server of guildFresh.servers || []) {
    const serviceId = String(server.serviceId);
    const mapData = collected.byMap[serviceId] || {
      name: server.name,
      chat: [],
      error: 'No data',
    };
    if (mapData.rateLimited && mapData.stale) continue;
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
  // One forum sync + one Nitrado pull shared by admin + chat (halves list/seek traffic).
  const guild = getGuild(guildId);
  const wantAdmin =
    isFeatureEnabled(guild, 'adminLogging') && shouldRefreshMapLogs(guild, 'adminLogging');
  const wantChat =
    isFeatureEnabled(guild, 'chatLogs') && shouldRefreshMapLogs(guild, 'chatLogs');

  let guildFresh = null;
  let collected = null;

  if (wantAdmin || wantChat) {
    const discordGuild = await client.guilds.fetch(guildId).catch(() => null);
    if (discordGuild) {
      guildFresh = await syncMapForums(discordGuild, guildId);
      if ((guildFresh.nitradoAccounts || []).length) {
        try {
          collected = await collectPerMapLogs(guildFresh, guildId);
          if (collected.errors?.length) {
            console.warn(
              `[logBoards] pull errors guild=${guildId}: ${collected.errors
                .slice(0, 5)
                .join('; ')}`
            );
          }
        } catch (error) {
          console.warn(
            `[logBoards] collect failed guild=${guildId}: ${error.message}`
          );
        }
      } else {
        collected = { byMap: {}, errors: ['Add Nitrado token first'] };
      }
    }
  }

  await refreshAdminBoard(client, guildId, collected, guildFresh).catch((error) =>
    console.warn(`[logBoards] adminLogging error guild=${guildId}: ${error.message}`)
  );
  await refreshChatBoard(client, guildId, collected, guildFresh).catch((error) =>
    console.warn(`[logBoards] chatLogs error guild=${guildId}: ${error.message}`)
  );
}

async function refreshAllLogBoards(client) {
  for (const guildId of listGuildIds()) {
    try {
      await refreshGuildLogBoards(client, guildId);
    } catch (error) {
      console.warn(`[logBoards] error guild=${guildId}: ${error.message}`);
    }
  }
}

function startLogBoards(client) {
  if (timer) clearInterval(timer);
  setTimeout(() => {
    refreshAllLogBoards(client).catch((err) =>
      console.warn('[logBoards] startup refresh:', err.message)
    );
  }, 20_000);
  timer = setInterval(() => {
    refreshAllLogBoards(client).catch((err) =>
      console.warn('[logBoards] interval:', err.message)
    );
  }, INTERVAL_MS);
  console.log('[scheduler] logBoards started (5m)');
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
