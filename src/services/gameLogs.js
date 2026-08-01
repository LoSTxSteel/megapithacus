const { EmbedBuilder } = require('discord.js');
const { fetchGameLogText, tokenForServer, extractMapName } = require('./nitrado');
const { brandEmbed } = require('../utils/embeds');

function classifyLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length < 4) return null;

  const lower = trimmed.toLowerCase();

  if (
    /admincmd|admin command|cheat\s|used cheat|godmode|fly\b|ghost\b|enablespectator|forceplayer|destroyall|setadmin/i.test(
      lower
    )
  ) {
    return { type: 'admin', text: trimmed };
  }

  if (
    /serverchat|global\)|tribe chat|alliance chat|\(global\)|\(local\)/i.test(lower) ||
    /\bChat[:\s]/i.test(trimmed)
  ) {
    return { type: 'chat', text: trimmed };
  }

  // Gamertag: message style (avoid tribe ID system lines)
  if (/^\s*[^:]{2,32}:\s+.+$/.test(trimmed) && !/tribe\s+.+,?\s*id\s*\d+/i.test(trimmed)) {
    return { type: 'chat', text: trimmed };
  }

  return null;
}

function parseLogText(text, mapName, serviceId) {
  const chat = [];
  const admin = [];
  if (!text) return { chat, admin };

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\u0000/g, '').trim();
    const classified = classifyLine(line);
    if (!classified) continue;
    const entry = {
      map: mapName,
      serviceId,
      text: classified.text.slice(0, 300),
      at: new Date().toISOString(),
    };
    if (classified.type === 'chat') chat.push(entry);
    if (classified.type === 'admin') admin.push(entry);
  }

  return { chat, admin };
}

/**
 * Collect per-map chat + in-game admin lines from Nitrado.
 * @returns {{ byMap: Record<string, { name, chat, admin, error? }>, errors: string[] }}
 */
async function collectPerMapLogs(guild) {
  const byMap = {};
  const errors = [];

  for (const server of guild.servers || []) {
    const serviceId = String(server.serviceId);
    const token = tokenForServer(server, guild);
    if (!token) {
      byMap[serviceId] = {
        name: server.name,
        chat: [],
        admin: [],
        error: 'No Nitrado token',
      };
      errors.push(`${server.name}: no token`);
      continue;
    }

    try {
      const { gameserver, text } = await fetchGameLogText(serviceId, token);
      const mapName =
        extractMapName(gameserver, server.name) || server.name || serviceId;
      const parsed = parseLogText(text, mapName, serviceId);
      byMap[serviceId] = {
        name: mapName,
        chat: parsed.chat.slice(-40),
        admin: parsed.admin.slice(-40),
      };
    } catch (error) {
      byMap[serviceId] = {
        name: server.name,
        chat: [],
        admin: [],
        error: error.message,
      };
      errors.push(`${server.name}: ${error.message}`);
    }
  }

  return { byMap, errors };
}

function formatLines(entries, emptyMessage) {
  if (!entries.length) return emptyMessage;
  return entries
    .slice(-30)
    .map((e) => `• ${e.text}`)
    .join('\n')
    .slice(0, 3900);
}

function buildMapChatEmbed(clusterName, mapName, entries, note, guild = null) {
  return brandEmbed(
    new EmbedBuilder()
      .setTitle(`${mapName} — Chat`)
      .setDescription(
        formatLines(entries, '_No in-game chat lines found for this map in the latest pull._')
      )
      .addFields(
        { name: 'Cluster', value: clusterName, inline: true },
        { name: 'Map', value: mapName, inline: true },
        { name: 'Notes', value: note || 'OK', inline: true }
      ),
    guild,
    { accent: true, context: 'Chat · every 10m' }
  );
}

function buildMapAdminEmbed(clusterName, mapName, gameAdminEntries, note, guild = null) {
  const gameLines = gameAdminEntries.slice(-30).map((e) => `• ${e.text}`);

  return brandEmbed(
    new EmbedBuilder()
      .setTitle(`${mapName} — Admin Log`)
      .setDescription(
        gameLines.length
          ? gameLines.join('\n').slice(0, 3900)
          : '_No in-game admin commands found for this map in the latest Nitrado log pull._'
      )
      .addFields(
        { name: 'Cluster', value: clusterName, inline: true },
        { name: 'Map', value: mapName, inline: true },
        { name: 'Source', value: 'Nitrado API / game logs', inline: true },
        { name: 'Notes', value: note || 'OK', inline: true }
      ),
    guild,
    { accent: true, context: 'Admin log · every 10m' }
  );
}

module.exports = {
  collectPerMapLogs,
  buildMapChatEmbed,
  buildMapAdminEmbed,
  parseLogText,
};
