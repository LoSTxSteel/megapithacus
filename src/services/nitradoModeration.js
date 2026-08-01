const {
  addBanlist,
  removeBanlist,
  sendCommand,
  tokenForServer,
} = require('./nitrado');

function isFakeService(serviceId) {
  return !serviceId || String(serviceId).startsWith('fake');
}

/**
 * Xbox / MS Store ASE identifier for banlist + console commands.
 */
function playerIdentifier(profile) {
  const id = profile?.gamertag || profile?.characterName || null;
  return id ? String(id).trim() : null;
}

function quoteArg(value) {
  const s = String(value).trim();
  if (!s) return s;
  if (/[\s"]/.test(s)) return `"${s.replace(/"/g, '')}"`;
  return s;
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
 * Ban on every synced Nitrado service:
 * 1) banlist add (persistent)
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
    try {
      await sendCommand(
        server.serviceId,
        token,
        `BanPlayer ${quoteArg(identifier)}`
      );
    } catch {
      // Banlist is the durable action; still try a kick if BanPlayer fails
      await sendCommand(
        server.serviceId,
        token,
        `KickPlayer ${quoteArg(identifier)}`
      ).catch(() => {});
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
    await sendCommand(
      server.serviceId,
      token,
      `UnBanPlayer ${quoteArg(identifier)}`
    ).catch(() => {});
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
 * Kick via console command. Prefers the player's current/last map service,
 * otherwise tries the whole cluster.
 */
async function kickPlayerOnCluster(guild, profile) {
  const identifier = playerIdentifier(profile);
  if (!identifier) {
    return {
      ok: false,
      error: 'Player has no gamertag/IGN to send to Nitrado.',
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
      await sendCommand(
        server.serviceId,
        token,
        `KickPlayer ${quoteArg(identifier)}`
      );
    },
    preferred ? { onlyServiceId: preferred } : {}
  );

  let summary = summarizeResults(results, 'kick');

  // If preferred map failed / empty, fall back to whole cluster
  if (preferred && (summary.allFailed || summary.noRealServers)) {
    results = await forEachServer(guild, async (server, token) => {
      await sendCommand(
        server.serviceId,
        token,
        `KickPlayer ${quoteArg(identifier)}`
      );
    });
    summary = summarizeResults(results, 'kick');
  }

  if (summary.allFailed) {
    return {
      ok: false,
      error: `Nitrado kick failed on all servers.\n${summary.summary}`,
      identifier,
      ...summary,
    };
  }

  return { ok: true, identifier, ...summary };
}

module.exports = {
  playerIdentifier,
  banPlayerOnCluster,
  unbanPlayerOnCluster,
  kickPlayerOnCluster,
};
