const {
  addBanlist,
  removeBanlist,
  sendCommand,
  kickOnlinePlayer,
  findOnlinePlayer,
  listPlayers,
  tokenForServer,
} = require('./nitrado');

function isFakeService(serviceId) {
  return !serviceId || String(serviceId).startsWith('fake');
}

/**
 * Xbox / MS Store ASE identifier for banlist (gamertag).
 */
function playerIdentifier(profile) {
  const id = profile?.gamertag || profile?.characterName || null;
  return id ? String(id).trim() : null;
}

/**
 * Quote a console argument for ARK ASE via Nitrado.
 * Names with spaces need a single pair of double quotes (no nested escapes).
 * Numeric IDs stay unquoted.
 */
function quoteArg(value) {
  const s = String(value).trim();
  if (!s) return s;
  if (/^\d+$/.test(s)) return s;
  const cleaned = s.replace(/"/g, '').trim();
  if (!cleaned) return cleaned;
  if (/\s/.test(cleaned)) return `"${cleaned}"`;
  return cleaned;
}

/**
 * Build KickPlayer / BanPlayer console variants for arkxb.
 * Prefer numeric platform / network id (NOT specimen / UE4 PlayerDataID).
 * Gamertag with spaces is a last resort (quoted once).
 */
function buildPlayerConsoleCommands(verb, profile, onlineEntry = null) {
  const cmds = [];
  const seen = new Set();
  const push = (cmd) => {
    const c = String(cmd || '').trim();
    if (!c || seen.has(c)) return;
    seen.add(c);
    cmds.push(c);
  };

  const idType = String(onlineEntry?.id_type || onlineEntry?.idType || '').toLowerCase();
  const numericIds = [
    profile?.platformId,
    // Numeric Nitrado `id` only when it is not the opaque "internal" kick handle
    idType !== 'internal' && /^\d+$/.test(String(onlineEntry?.id || ''))
      ? onlineEntry.id
      : null,
  ];
  for (const id of numericIds) {
    if (id == null) continue;
    const n = String(id).trim();
    if (!/^\d+$/.test(n)) continue;
    push(`${verb} ${n}`);
  }

  const name =
    profile?.gamertag ||
    profile?.characterName ||
    onlineEntry?.name ||
    null;
  if (name) {
    const quoted = quoteArg(name);
    // ASE / Nitrado: one pair of quotes when the gamertag has spaces
    push(`${verb} ${quoted}`);
    if (quoted.startsWith('"')) {
      // Some hosts reject quotes — try raw name as a last console attempt
      push(`${verb} ${String(name).trim().replace(/"/g, '')}`);
    }
  }

  return cmds;
}

async function sendFirstWorkingCommand(serviceId, token, commands) {
  let lastError = null;
  for (const command of commands) {
    try {
      await sendCommand(serviceId, token, command);
      return { ok: true, command };
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  throw new Error('No console command variants to try.');
}

function summarizeResults(results, actionLabel) {
  const real = results.filter((r) => !r.skipped);
  const ok = real.filter((r) => r.ok);
  const failed = real.filter((r) => !r.ok);
  const skipped = results.filter((r) => r.skipped);

  const lines = [];
  if (ok.length) {
    lines.push(
      `Nitrado ${actionLabel}: **${ok.length}/${real.length || results.length}** server(s) ok` +
        (ok.length <= 8
          ? ` (${ok.map((r) => r.name).join(', ')})`
          : '')
    );
  }
  if (failed.length) {
    lines.push(
      `Failed on: ${failed
        .slice(0, 6)
        .map((r) => `${r.name} (${r.error})`)
        .join('; ')}${failed.length > 6 ? '…' : ''}`
    );
  }
  if (!real.length && skipped.length) {
    lines.push('No live Nitrado services to update (test/fake services skipped).');
  }

  return {
    okCount: ok.length,
    failCount: failed.length,
    skippedCount: skipped.length,
    realCount: real.length,
    results,
    summary: lines.join('\n') || `No servers available for Nitrado ${actionLabel}.`,
    anyOk: ok.length > 0,
    allFailed: real.length > 0 && ok.length === 0,
    noRealServers: real.length === 0,
  };
}

async function forEachServer(guild, handler, { onlyServiceId = null } = {}) {
  const servers = guild.servers || [];
  const targets = onlyServiceId
    ? servers.filter((s) => String(s.serviceId) === String(onlyServiceId))
    : servers;

  // If a specific service was requested but not in the list, still try it
  const list =
    onlyServiceId && !targets.length
      ? [{ serviceId: onlyServiceId, name: `Service ${onlyServiceId}` }]
      : targets;

  const results = [];

  for (const server of list) {
    const name = server.name || server.map || String(server.serviceId);
    const token = tokenForServer(server, guild);

    if (isFakeService(server.serviceId)) {
      results.push({
        name,
        serviceId: server.serviceId,
        ok: false,
        skipped: true,
        error: 'Fake/test service',
      });
      continue;
    }

    if (!token) {
      results.push({
        name,
        serviceId: server.serviceId,
        ok: false,
        error: 'No Nitrado token for this server',
      });
      continue;
    }

    try {
      await handler(server, token);
      results.push({ name, serviceId: server.serviceId, ok: true });
    } catch (error) {
      results.push({
        name,
        serviceId: server.serviceId,
        ok: false,
        error: error.message || String(error),
      });
    }
  }

  return results;
}

/**
 * Resolve Nitrado online player `id` for Player Management kick.
 */
async function resolveNitradoPlayerId(serviceId, token, profile) {
  if (profile?.nitradoPlayerId) return String(profile.nitradoPlayerId).trim();

  const names = [profile?.gamertag, profile?.characterName].filter(Boolean);
  for (const name of names) {
    const entry = await findOnlinePlayer(serviceId, token, name);
    if (entry?.id != null && String(entry.id).trim()) {
      return String(entry.id).trim();
    }
  }

  // Broader scan: partial match when exact name differs slightly
  const players = await listPlayers(serviceId, token);
  if (!Array.isArray(players)) return null;
  const targets = names.map((n) => String(n).trim().toLowerCase());
  const match = players.find((p) => {
    const n = String(p?.name || '')
      .trim()
      .toLowerCase();
    return n && targets.includes(n);
  });
  return match?.id != null ? String(match.id).trim() : null;
}

/**
 * Ban on every synced Nitrado service:
 * 1) banlist add (persistent — gamertag for Xbox)
 * 2) BanPlayer console command (immediate kick + in-game ban)
 */
async function banPlayerOnCluster(guild, profile) {
  const identifier = playerIdentifier(profile);
  if (!identifier) {
    return {
      ok: false,
      error: 'Player has no gamertag/IGN to send to Nitrado.',
      ...summarizeResults([], 'ban'),
    };
  }

  const results = await forEachServer(guild, async (server, token) => {
    await addBanlist(server.serviceId, token, identifier);
    const online = await findOnlinePlayer(server.serviceId, token, identifier).catch(
      () => null
    );
    const commands = buildPlayerConsoleCommands('BanPlayer', profile, online);
    try {
      await sendFirstWorkingCommand(server.serviceId, token, commands);
    } catch {
      // Banlist is the durable action; still try KickPlayer variants
      const kickCmds = buildPlayerConsoleCommands('KickPlayer', profile, online);
      await sendFirstWorkingCommand(server.serviceId, token, kickCmds).catch(() => {});
    }
  });

  const summary = summarizeResults(results, 'ban');
  if (summary.allFailed) {
    return {
      ok: false,
      error: `Nitrado ban failed on all servers.\n${summary.summary}`,
      identifier,
      ...summary,
    };
  }

  return { ok: true, identifier, ...summary };
}

/**
 * Remove ban from every synced Nitrado service.
 */
async function unbanPlayerOnCluster(guild, profile) {
  const identifier = playerIdentifier(profile);
  if (!identifier) {
    return {
      ok: false,
      error: 'Player has no gamertag/IGN to send to Nitrado.',
      ...summarizeResults([], 'unban'),
    };
  }

  const results = await forEachServer(guild, async (server, token) => {
    await removeBanlist(server.serviceId, token, identifier);
    const commands = buildPlayerConsoleCommands('UnBanPlayer', profile, null);
    await sendFirstWorkingCommand(server.serviceId, token, commands).catch(() => {});
  });

  const summary = summarizeResults(results, 'unban');
  if (summary.allFailed) {
    return {
      ok: false,
      error: `Nitrado unban failed on all servers.\n${summary.summary}`,
      identifier,
      ...summary,
    };
  }

  return { ok: true, identifier, ...summary };
}

/**
 * Kick a player on one service:
 * 1) Nitrado Player Management kick (online `id`) — most reliable for arkxb
 * 2) Console KickPlayer variants (numeric id, then quoted gamertag)
 *
 * Requires the gameserver process to be online; Nitrado returns 500
 * "could not be sent to the application server" when it is offline.
 */
async function kickOnService(server, token, profile) {
  const nitradoId = await resolveNitradoPlayerId(server.serviceId, token, profile);
  if (nitradoId) {
    try {
      await kickOnlinePlayer(server.serviceId, token, nitradoId);
      console.log(
        `[nitrado] Player Management kick ok service=${server.serviceId} playerId=${nitradoId}`
      );
      return;
    } catch (error) {
      console.warn(
        `[nitrado] Player Management kick failed service=${server.serviceId} ` +
          `playerId=${nitradoId}: ${error.message || error}`
      );
      // Fall through to console commands
    }
  } else {
    console.warn(
      `[nitrado] kick: no nitradoPlayerId for gt=${profile?.gamertag || '?'} ` +
        `service=${server.serviceId} — trying console KickPlayer`
    );
  }

  const online =
    (nitradoId
      ? { id: nitradoId, name: profile.gamertag || profile.characterName }
      : null) ||
    (await findOnlinePlayer(
      server.serviceId,
      token,
      profile.gamertag || profile.characterName
    ).catch(() => null));

  const commands = buildPlayerConsoleCommands('KickPlayer', profile, online);
  if (!commands.length) {
    throw new Error('No kick target (need online Nitrado player id, platform id, or gamertag).');
  }
  await sendFirstWorkingCommand(server.serviceId, token, commands);
}

/**
 * Kick via Player Management + console. Prefers the player's current/last map,
 * otherwise tries the whole cluster.
 */
async function kickPlayerOnCluster(guild, profile) {
  const identifier = playerIdentifier(profile);
  const hasKickTarget =
    identifier ||
    profile?.nitradoPlayerId ||
    profile?.platformId ||
    profile?.specimenImplant;
  if (!hasKickTarget) {
    return {
      ok: false,
      error: 'Player has no gamertag/IGN/Nitrado id to kick.',
      ...summarizeResults([], 'kick'),
    };
  }

  const preferred =
    profile.serviceId && !isFakeService(profile.serviceId)
      ? String(profile.serviceId)
      : null;

  let results = await forEachServer(
    guild,
    async (server, token) => {
      await kickOnService(server, token, profile);
    },
    preferred ? { onlyServiceId: preferred } : {}
  );

  let summary = summarizeResults(results, 'kick');

  // If preferred map failed / empty, fall back to whole cluster
  if (preferred && (summary.allFailed || summary.noRealServers)) {
    results = await forEachServer(guild, async (server, token) => {
      await kickOnService(server, token, profile);
    });
    summary = summarizeResults(results, 'kick');
  }

  if (summary.allFailed) {
    return {
      ok: false,
      error:
        `Nitrado kick failed on all servers.\n${summary.summary}` +
        '\n_Note: the gameserver must be online for kicks to reach the application._',
      identifier,
      ...summary,
    };
  }

  if (summary.noRealServers || !summary.anyOk) {
    return {
      ok: false,
      error:
        summary.summary ||
        'Nitrado kick did not reach any live gameserver (check tokens / server sync).',
      identifier,
      ...summary,
    };
  }

  return { ok: true, identifier, ...summary };
}

module.exports = {
  playerIdentifier,
  quoteArg,
  banPlayerOnCluster,
  unbanPlayerOnCluster,
  kickPlayerOnCluster,
};
