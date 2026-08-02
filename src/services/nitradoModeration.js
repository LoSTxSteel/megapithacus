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

function playerEntryNames(entry) {
  return [
    entry?.gamertag,
    entry?.gamer_tag,
    entry?.name,
    entry?.username,
    entry?.characterName,
    entry?.character_name,
    entry?.playerName,
    entry?.player_name,
  ]
    .filter(Boolean)
    .map((v) => String(v).trim().toLowerCase());
}

/**
 * Resolve a live online player for Player Management kick.
 * Prefer a fresh GET .../games/players match by gamertag over a cached id
 * (cached ids go stale if the player left during OpenXBL lookup).
 *
 * @returns {{ playerId: string|null, entry: object|null, source: string, online: boolean }}
 */
async function resolveOnlinePlayerForKick(serviceId, token, profile) {
  const cachedId = profile?.nitradoPlayerId
    ? String(profile.nitradoPlayerId).trim()
    : null;
  const names = [profile?.gamertag, profile?.characterName]
    .filter(Boolean)
    .map((n) => String(n).trim());
  const targets = names.map((n) => n.toLowerCase());

  let players = null;
  try {
    players = await listPlayers(serviceId, token);
  } catch {
    players = null;
  }

  if (Array.isArray(players)) {
    // Fresh name match against the live list (prefer over cached id)
    if (targets.length) {
      const exact = players.find((p) =>
        playerEntryNames(p).some((n) => targets.includes(n))
      );
      if (exact?.id != null && String(exact.id).trim()) {
        return {
          playerId: String(exact.id).trim(),
          entry: exact,
          source: 'live-name',
          online: true,
        };
      }
    }

    // 3) Cached id still present in the live list
    if (cachedId) {
      const byId = players.find((p) => String(p?.id || '').trim() === cachedId);
      if (byId) {
        return {
          playerId: cachedId,
          entry: byId,
          source: 'cached-verified',
          online: true,
        };
      }
      return {
        playerId: cachedId,
        entry: null,
        source: 'cached-offline',
        online: false,
      };
    }

    return { playerId: null, entry: null, source: 'not-found', online: false };
  }

  // Player list unavailable — fall back to cached id if any
  if (cachedId) {
    return {
      playerId: cachedId,
      entry: null,
      source: 'cached-unverified',
      online: true,
    };
  }
  return { playerId: null, entry: null, source: 'no-list', online: false };
}

/**
 * Resolve Nitrado online player `id` for Player Management kick.
 */
async function resolveNitradoPlayerId(serviceId, token, profile) {
  const resolved = await resolveOnlinePlayerForKick(serviceId, token, profile);
  return resolved.playerId;
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
 * Last-resort kick for Xbox ASE: add gamertag to banlist (forces disconnect)
 * then immediately remove. Not a permanent ban when remove succeeds.
 */
async function kickViaBanlistPulse(serviceId, token, gamertag) {
  const identifier = String(gamertag || '').trim();
  if (!identifier) {
    throw new Error('Banlist pulse kick needs a gamertag');
  }
  await addBanlist(serviceId, token, identifier);
  try {
    await removeBanlist(serviceId, token, identifier);
  } catch (error) {
    // Player was kicked, but may remain banned — surface that clearly.
    throw new Error(
      `Banlist pulse kicked ${identifier} but unban failed: ${error.message || error}. ` +
        'Remove them from the Nitrado banlist manually.'
    );
  }
  return { method: 'banlist-pulse', identifier };
}

/**
 * Kick a player on one service via Player Management (online `id`).
 * Console KickPlayer (`POST .../gameservers/command`) is optional and usually
 * 500s on ASE arkxb — keep it off for gamerscore / automated kicks.
 * When PM kick fails and a gamertag is available, try banlist add→remove
 * (forces disconnect on Xbox without leaving a ban when unban works).
 */
async function kickOnService(server, token, profile, options = {}) {
  const allowConsoleFallback = options.allowConsoleFallback === true;
  const allowBanlistPulse = options.allowBanlistPulse !== false;
  const reason = options.reason || 'Kicked';
  const resolved = await resolveOnlinePlayerForKick(
    server.serviceId,
    token,
    profile
  );
  const nitradoId = resolved.playerId;
  const displayName = profile?.gamertag || profile?.characterName || null;

  console.log(
    `[nitrado] kick resolve service=${server.serviceId} ` +
      `gt=${profile?.gamertag || '?'} playerId=${nitradoId || '(none)'} ` +
      `source=${resolved.source} online=${resolved.online}`
  );

  if (!resolved.online && resolved.source === 'cached-offline') {
    const msg =
      `Player ${displayName || nitradoId} is no longer on the online list for ` +
      `service ${server.serviceId} (cached nitradoPlayerId=${nitradoId}). ` +
      'They may have already left.';
    console.warn(`[nitrado] kick: ${msg}`);
    if (allowBanlistPulse && profile?.gamertag) {
      try {
        const pulsed = await kickViaBanlistPulse(
          server.serviceId,
          token,
          profile.gamertag
        );
        console.log(
          `[nitrado] kick via banlist-pulse (cached id offline) ` +
            `service=${server.serviceId} gt=${profile.gamertag}`
        );
        return { ...pulsed, note: msg };
      } catch (pulseErr) {
        throw new Error(
          `${msg} Banlist pulse also failed: ${pulseErr.message || pulseErr}`
        );
      }
    }
    throw new Error(msg);
  }

  if (!nitradoId) {
    const msg =
      `No Nitrado online player id for gt=${profile?.gamertag || '?'} ` +
      `service=${server.serviceId}`;
    console.warn(`[nitrado] kick: ${msg}`);
    if (allowBanlistPulse && profile?.gamertag) {
      try {
        const pulsed = await kickViaBanlistPulse(
          server.serviceId,
          token,
          profile.gamertag
        );
        console.log(
          `[nitrado] kick via banlist-pulse (no online id) service=${server.serviceId} ` +
            `gt=${profile.gamertag}`
        );
        return pulsed;
      } catch (pulseErr) {
        console.warn(
          `[nitrado] banlist-pulse failed service=${server.serviceId}: ` +
            `${pulseErr.message || pulseErr}`
        );
      }
    }
    if (!allowConsoleFallback) {
      throw new Error(
        `${msg}. Player Management kick requires the online-list id from join.`
      );
    }
  } else {
    try {
      const actions = resolved.entry?.actions;
      if (Array.isArray(actions) && actions.length && !actions.includes('kick')) {
        console.warn(
          `[nitrado] online entry has no kick action service=${server.serviceId} ` +
            `playerId=${nitradoId} actions=${actions.join(',')}`
        );
      }
      await kickOnlinePlayer(server.serviceId, token, nitradoId, reason, {
        name: displayName,
        entry: resolved.entry,
      });
      return {
        method: 'player-management',
        playerId: nitradoId,
        source: resolved.source,
      };
    } catch (error) {
      console.warn(
        `[nitrado] Player Management kick failed service=${server.serviceId} ` +
          `playerId=${nitradoId}: ${error.message || error}`
      );

      if (allowBanlistPulse && profile?.gamertag) {
        try {
          const pulsed = await kickViaBanlistPulse(
            server.serviceId,
            token,
            profile.gamertag
          );
          console.log(
            `[nitrado] kick via banlist-pulse after PM failure ` +
              `service=${server.serviceId} gt=${profile.gamertag}`
          );
          return { ...pulsed, priorError: error.message || String(error) };
        } catch (pulseErr) {
          console.warn(
            `[nitrado] banlist-pulse failed service=${server.serviceId}: ` +
              `${pulseErr.message || pulseErr}`
          );
          if (!allowConsoleFallback) {
            throw new Error(
              `${error.message || error} | Banlist pulse also failed: ` +
                `${pulseErr.message || pulseErr}`
            );
          }
        }
      } else if (!allowConsoleFallback) {
        throw error;
      }
      // Fall through to console only when explicitly allowed
    }
  }

  if (!allowConsoleFallback) {
    throw new Error(
      `Player Management kick failed on service ${server.serviceId} ` +
        `(console KickPlayer disabled — ASE usually returns 500 on /gameservers/command).`
    );
  }

  console.warn(
    `[nitrado] kick: falling back to console KickPlayer service=${server.serviceId} ` +
      `(often 500s on ASE)`
  );

  const online =
    resolved.entry ||
    (nitradoId
      ? { id: nitradoId, name: displayName }
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
  return { method: 'console', playerId: nitradoId || null };
}

/**
 * Kick via Player Management (preferred). Options:
 * - playerManagementOnly: never use console KickPlayer (default false)
 * - allowClusterFallback: if preferred serviceId fails, try other maps (default true)
 * - reason: passed to PM delete variants
 *
 * Prefers the player's current/last map serviceId when present.
 */
async function kickPlayerOnCluster(guild, profile, options = {}) {
  const playerManagementOnly = options.playerManagementOnly === true;
  // Gamerscore / automated: stay on join service + PM only.
  // Manual /player kicks: may try other maps + console as last resort.
  const allowClusterFallback = playerManagementOnly
    ? options.allowClusterFallback === true
    : options.allowClusterFallback !== false;
  const allowConsoleFallback = playerManagementOnly
    ? false
    : options.allowConsoleFallback !== false;
  const reason = options.reason || 'Kicked';

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

  const kickOpts = {
    allowConsoleFallback,
    reason,
  };

  let results = await forEachServer(
    guild,
    async (server, token) => {
      await kickOnService(server, token, profile, kickOpts);
    },
    preferred ? { onlyServiceId: preferred } : {}
  );

  let summary = summarizeResults(results, 'kick');

  // If preferred map failed / empty, optionally fall back to whole cluster
  if (
    preferred &&
    allowClusterFallback &&
    (summary.allFailed || summary.noRealServers)
  ) {
    results = await forEachServer(guild, async (server, token) => {
      await kickOnService(server, token, profile, kickOpts);
    });
    summary = summarizeResults(results, 'kick');
  }

  if (summary.allFailed) {
    const firstError = summary.results?.find((r) => !r.ok && r.error)?.error;
    return {
      ok: false,
      error:
        (firstError
          ? `Nitrado kick failed: ${firstError}`
          : `Nitrado kick failed on all servers.\n${summary.summary}`) +
        (playerManagementOnly
          ? '\n_Player Management / banlist-pulse only — console KickPlayer was not used (ASE /gameservers/command often 500s)._'
          : '\n_Note: the gameserver must be online for kicks to reach the application._'),
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
