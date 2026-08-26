const { sendCommand, tokenForServer } = require('./nitrado');

const MAX_LEN = 200;

function sanitizeBroadcast(text) {
  const cleaned = String(text || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/["'`\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.slice(0, MAX_LEN);
}

function broadcastCommands(message) {
  return [
    `broadcast ${message}`,
    `cheat broadcast ${message}`,
    `admincheat broadcast ${message}`,
  ];
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

async function broadcastOnServer(server, guild, message) {
  const text = sanitizeBroadcast(message);
  if (!text) {
    return { ok: false, skipped: false, error: 'Message is empty.' };
  }

  const token = tokenForServer(server, guild);
  const name = server?.name || server?.label || server?.serviceId || 'Server';
  if (!token) {
    return { ok: false, skipped: false, name, error: 'No Nitrado token' };
  }
  if (!server?.serviceId || String(server.serviceId).startsWith('fake')) {
    return { ok: false, skipped: true, name, error: 'Skipped fake/test server' };
  }

  try {
    const sent = await sendFirstWorkingCommand(
      server.serviceId,
      token,
      broadcastCommands(text)
    );
    return { ok: true, name, command: sent.command };
  } catch (error) {
    return { ok: false, skipped: false, name, error: error.message || String(error) };
  }
}

async function broadcastOnServers(guild, servers, message) {
  const text = sanitizeBroadcast(message);
  if (!text) {
    return { ok: false, error: 'Message is empty.', summary: 'Message is empty.' };
  }

  const list = Array.isArray(servers) ? servers : [];
  const results = [];
  for (const server of list) {
    results.push(await broadcastOnServer(server, guild, text));
  }

  const real = results.filter((r) => !r.skipped);
  const ok = real.filter((r) => r.ok);
  const failed = real.filter((r) => !r.ok);
  const skipped = results.filter((r) => r.skipped);

  const lines = [];
  if (ok.length) {
    lines.push(
      `Broadcast sent on **${ok.length}/${real.length || results.length}** server(s)` +
        (ok.length <= 10 ? `: ${ok.map((r) => r.name).join(', ')}` : '')
    );
  }
  if (failed.length) {
    lines.push(
      `Failed: ${failed
        .slice(0, 8)
        .map((r) => `${r.name} (${r.error})`)
        .join('; ')}${failed.length > 8 ? '…' : ''}`
    );
  }
  if (skipped.length) {
    lines.push(`Skipped ${skipped.length} test server(s).`);
  }
  if (!lines.length) {
    lines.push('No synced Nitrado servers to broadcast to.');
  }

  return {
    ok: ok.length > 0 && failed.length === 0,
    text,
    results,
    summary: lines.join('\n').slice(0, 1800),
  };
}

async function broadcastOnCluster(guild, message) {
  const servers = Array.isArray(guild?.servers) ? guild.servers : [];
  return broadcastOnServers(guild, servers, message);
}

module.exports = {
  MAX_LEN,
  sanitizeBroadcast,
  broadcastOnServer,
  broadcastOnServers,
  broadcastOnCluster,
};
