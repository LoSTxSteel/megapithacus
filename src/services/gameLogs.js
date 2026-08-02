const { EmbedBuilder } = require('discord.js');
const { fetchGameLogText, tokenForServer, extractMapName } = require('./nitrado');
const { brandEmbed } = require('../utils/embeds');
const { brand } = require('../config');

const ADMIN_LOG_COLOR = 0x9b59b6;
const ADMIN_GROUP_WINDOW_MS = 60_000;
const DESC_MAX = 3900;

function isChatBody(body) {
  const text = String(body || '').trim();
  if (!text || text.length < 4) return false;
  if (/tribe\s+.+,?\s*id\s*\d+/i.test(text)) return false;
  if (
    /was killed|joined this ark|left this ark|tamed a|destroyed|tribelog/i.test(
      text
    )
  ) {
    return false;
  }
  // PlayerName (TribeOrChar): message  OR  PlayerName: message
  return /^[^:]{2,64}(?:\s+\([^)]{1,64}\))?\s*:\s+\S/.test(text);
}

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

  // Timestamp-prefixed chat (common in ShooterGame.log)
  const stripped = stripChatChannelPrefix(stripLogPrefixes(trimmed));
  if (stripped && stripped !== trimmed && isChatBody(stripped)) {
    return { type: 'chat', text: trimmed };
  }

  return null;
}

/** Parse ARK / ShooterGame log timestamps into a Date (treated as UTC). */
function parseArkTimestamp(line) {
  let m = String(line).match(
    /\[(\d{4})\.(\d{2})\.(\d{2})-(\d{2})\.(\d{2})\.(\d{2})(?::\d+)?\]/
  );
  if (m) {
    return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
  }

  m = String(line).match(/(\d{4})\.(\d{2})\.(\d{2})_(\d{2})\.(\d{2})\.(\d{2})/);
  if (m) {
    return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
  }

  return null;
}

function stripLogPrefixes(line) {
  return String(line)
    .replace(/^\[[^\]]+\]\s*(?:\[[^\]]+\]\s*)?/, '')
    .replace(/^\d{4}\.\d{2}\.\d{2}_\d{2}\.\d{2}\.\d{2}:\s*/, '')
    .trim();
}

function parseAdminFields(line) {
  const atDate = parseArkTimestamp(line) || new Date();
  let adminName = 'Unknown';
  let command = stripLogPrefixes(line);

  const adminCmd = line.match(
    /AdminCmd:\s*(.+?)\s*\(\s*PlayerName:\s*([^,)]+)/i
  );
  if (adminCmd) {
    command = adminCmd[1].trim();
    adminName = adminCmd[2].trim();
  } else {
    const playerName = line.match(/PlayerName:\s*([^,)]+)/i);
    if (playerName) adminName = playerName[1].trim();

    const cheat = line.match(/(?:used\s+)?cheat\s+(.+)$/i);
    if (cheat) command = cheat[1].trim();
  }

  return {
    adminName: adminName.slice(0, 64) || 'Unknown',
    command: command.slice(0, 400) || line.slice(0, 400),
    at: atDate.toISOString(),
  };
}

function stripChatChannelPrefix(body) {
  return String(body || '')
    .replace(/^(?:serverchat|tribe chat|alliance chat)\s*:\s*/i, '')
    .replace(/^\((?:global|local|tribe|alliance)\)\s*/i, '')
    .replace(/^Chat\s*:\s*/i, '')
    .replace(/^Day\s+\d+,\s+\d{1,2}:\d{2}:\d{2}:\s*/i, '')
    .trim();
}

function parseChatFields(line) {
  const atDate = parseArkTimestamp(line) || new Date();
  let body = stripChatChannelPrefix(stripLogPrefixes(line));

  let playerName = 'Unknown';
  let tribeOrChar = null;
  let message = body;

  // PlayerName (TribeOrChar): message
  let m = body.match(/^(.{1,64}?)\s+\(([^)]{1,64})\)\s*:\s*(.+)$/);
  if (m) {
    playerName = m[1].trim();
    tribeOrChar = m[2].trim();
    message = m[3].trim();
  } else {
    m = body.match(/^([^:]{1,64}?):\s*(.+)$/);
    if (m) {
      playerName = m[1].trim();
      message = m[2].trim();
    }
  }

  return {
    playerName: playerName.slice(0, 64) || 'Unknown',
    tribeOrChar: tribeOrChar ? tribeOrChar.slice(0, 64) : null,
    message: (message || body).replace(/\r?\n/g, ' ').slice(0, 300),
    at: atDate.toISOString(),
  };
}

function parseLogText(text, mapName, serviceId) {
  const chat = [];
  const admin = [];
  if (!text) return { chat, admin };

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\u0000/g, '').trim();
    const classified = classifyLine(line);
    if (!classified) continue;

    if (classified.type === 'chat') {
      const fields = parseChatFields(classified.text);
      chat.push({
        map: mapName,
        serviceId,
        text: classified.text.slice(0, 300),
        playerName: fields.playerName,
        tribeOrChar: fields.tribeOrChar,
        message: fields.message,
        at: fields.at,
      });
      continue;
    }

    if (classified.type === 'admin') {
      const fields = parseAdminFields(classified.text);
      admin.push({
        map: mapName,
        serviceId,
        text: classified.text.slice(0, 500),
        adminName: fields.adminName,
        command: fields.command,
        at: fields.at,
      });
    }
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

function escapeMdBold(name) {
  return String(name || 'Unknown').replace(/[*_`~|\\]/g, '\\$&');
}

function sanitizeInlineCode(value) {
  return String(value || '')
    .replace(/`/g, "'")
    .replace(/\r?\n/g, ' ')
    .trim();
}

function unixFromIso(at) {
  const ms = Date.parse(at);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : Math.floor(Date.now() / 1000);
}

function formatChatLine(entry) {
  const unix = unixFromIso(entry.at);
  const player = escapeMdBold(entry.playerName || 'Unknown');
  const message = String(entry.message || entry.text || '')
    .replace(/\r?\n/g, ' ')
    .trim();

  if (entry.tribeOrChar) {
    const tribe = sanitizeInlineCode(entry.tribeOrChar);
    return `<t:${unix}:R> - **${player}** \`(${tribe})\` : ${message}`;
  }

  return `<t:${unix}:R> - **${player}** : ${message}`;
}

function formatChatDescription(entries, emptyMessage) {
  if (!entries.length) return emptyMessage;

  const recent = entries.slice(-40);
  const lines = [];

  for (let i = recent.length - 1; i >= 0; i--) {
    const line = formatChatLine(recent[i]);
    const next = lines.length ? `${line}\n${lines.join('\n')}` : line;
    if (next.length > DESC_MAX) break;
    lines.unshift(line);
  }

  if (!lines.length) {
    return formatChatLine(recent[recent.length - 1]).slice(0, DESC_MAX);
  }

  return lines.join('\n').slice(0, DESC_MAX);
}

function sanitizeCodeLine(cmd) {
  return String(cmd || '')
    .replace(/```/g, "'''")
    .replace(/\r?\n/g, ' ')
    .trim();
}

function groupAdminEntries(entries) {
  const groups = [];
  for (const entry of entries) {
    const adminName = entry.adminName || 'Unknown';
    const command = entry.command || entry.text || '';
    const at = entry.at || new Date().toISOString();
    const entryTs = Date.parse(at) || 0;
    const last = groups[groups.length - 1];
    const lastTs = last ? Date.parse(last.at) || 0 : 0;

    if (
      last &&
      last.adminName === adminName &&
      Math.abs(entryTs - lastTs) <= ADMIN_GROUP_WINDOW_MS
    ) {
      last.commands.push(command);
      continue;
    }

    groups.push({
      adminName,
      at,
      commands: [command],
    });
  }
  return groups;
}

function formatAdminGroup(group) {
  const ms = Date.parse(group.at);
  const unix = Number.isFinite(ms) ? Math.floor(ms / 1000) : Math.floor(Date.now() / 1000);
  const cmds = group.commands.map(sanitizeCodeLine).filter(Boolean);
  if (!cmds.length) cmds.push('(empty)');

  const fence = cmds.length > 1 ? '```py' : '```';
  return [
    `🕒 <t:${unix}:R>`,
    `🛡️ **${escapeMdBold(group.adminName)}**`,
    `${fence}\n${cmds.join('\n')}\n\`\`\``,
  ].join('\n');
}

function formatAdminDescription(entries, emptyMessage) {
  if (!entries.length) return emptyMessage;

  const groups = groupAdminEntries(entries.slice(-30));
  const blocks = [];

  for (let i = groups.length - 1; i >= 0; i--) {
    const block = formatAdminGroup(groups[i]);
    const next = blocks.length ? `${block}\n\n${blocks.join('\n\n')}` : block;
    if (next.length > DESC_MAX) break;
    blocks.unshift(block);
  }

  if (!blocks.length) {
    // Single oversized group — hard truncate
    return formatAdminGroup(groups[groups.length - 1]).slice(0, DESC_MAX);
  }

  return blocks.join('\n\n').slice(0, DESC_MAX);
}

function formatFooterStamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function buildMapLogFooter(serverName, serviceId) {
  const name = String(serverName || 'Server').slice(0, 180);
  const id = String(serviceId || '—');
  return `Server: ${name}\nID: ${id} - ${brand.name} - ${formatFooterStamp()}`;
}

/**
 * Overseer-style Chat Logs embed for a map thread.
 */
function buildMapChatEmbed(serverName, serviceId, chatEntries, note, guild = null) {
  const empty =
    note && note !== 'OK'
      ? `_${String(note).slice(0, 200)}_`
      : '_No in-game chat lines found for this map in the latest Nitrado log pull._';

  return brandEmbed(
    new EmbedBuilder()
      .setTitle('Chat Logs')
      .setDescription(formatChatDescription(chatEntries || [], empty)),
    guild,
    {
      color: ADMIN_LOG_COLOR,
      author: false,
      timestamp: false,
      footer: buildMapLogFooter(serverName, serviceId),
      context: 'Chat log · every 10m',
    }
  );
}

/**
 * Overseer-style Admin Logs embed for a map thread.
 */
function buildMapAdminEmbed(serverName, serviceId, gameAdminEntries, note, guild = null) {
  const empty =
    note && note !== 'OK'
      ? `_${String(note).slice(0, 200)}_`
      : '_No in-game admin commands found for this map in the latest Nitrado log pull._';

  return brandEmbed(
    new EmbedBuilder()
      .setTitle('Admin Logs')
      .setDescription(formatAdminDescription(gameAdminEntries || [], empty)),
    guild,
    {
      color: ADMIN_LOG_COLOR,
      author: false,
      timestamp: false,
      footer: buildMapLogFooter(serverName, serviceId),
      context: 'Admin log · every 10m',
    }
  );
}

module.exports = {
  collectPerMapLogs,
  buildMapChatEmbed,
  buildMapAdminEmbed,
  parseLogText,
  parseAdminFields,
  parseChatFields,
  groupAdminEntries,
  ADMIN_LOG_COLOR,
};
