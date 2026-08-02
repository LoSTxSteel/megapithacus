const { EmbedBuilder } = require('discord.js');
const { getGuild } = require('./storage');
const {
  isFeatureEnabled,
  isFeatureConfigured,
  getMapFeatureThread,
} = require('./featureSetup');
const { brandEmbed } = require('../utils/embeds');
const { brand } = require('../config');
const { formatMapName } = require('../utils/mapNames');

const JOIN_COLOR = 0x2ecc71;
const LEAVE_COLOR = 0xe74c3c;

function playerName(profile) {
  const gt = String(profile?.gamertag || '')
    .replace(/`/g, '')
    .trim();
  const char = String(profile?.characterName || '')
    .replace(/`/g, '')
    .trim();
  const distinctChar =
    char && (!gt || char.toLowerCase() !== gt.toLowerCase()) ? char : '';
  // Prefer "IGN (gamertag)" when we have a real character name; never pretend
  // the gamertag is the in-game name when they are the same field.
  if (distinctChar && gt) {
    return `${distinctChar.slice(0, 40)} (${gt.slice(0, 32)})`.slice(0, 64);
  }
  if (distinctChar) return distinctChar.slice(0, 64);
  if (gt) return gt.slice(0, 64);
  return 'Unknown';
}

function formatFooterStamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function buildJoinLeaveFooter(serverName, serviceId) {
  const name = String(serverName || 'Server').slice(0, 180);
  const id = String(serviceId || '—');
  return `Server: ${name}\nID: ${id} - ${brand.name} - ${formatFooterStamp()}`;
}

/**
 * Overseer-style Join/Leave Logs embed (one event per message).
 * Green accent = joined, red accent = left.
 */
function buildJoinLeaveEmbed(guild, { type, profile, serverName, serviceId, at = Date.now() }) {
  const verb = type === 'leave' ? 'left' : 'joined';
  const unix = Math.floor(Number(at) / 1000) || Math.floor(Date.now() / 1000);
  const line = `<t:${unix}:R> - \`${playerName(profile)}\` ${verb}`;

  return brandEmbed(
    new EmbedBuilder().setTitle('Join/Leave Logs').setDescription(line),
    guild,
    {
      color: type === 'leave' ? LEAVE_COLOR : JOIN_COLOR,
      author: false,
      timestamp: false,
      footer: buildJoinLeaveFooter(serverName, serviceId),
      context: 'Join / Leave',
    }
  );
}

function buildJoinEmbed(guild, profile, serverName, serviceId) {
  return buildJoinLeaveEmbed(guild, {
    type: 'join',
    profile,
    serverName,
    serviceId,
  });
}

function buildLeaveEmbed(guild, profile, serverName, serviceId) {
  return buildJoinLeaveEmbed(guild, {
    type: 'leave',
    profile,
    serverName,
    serviceId,
  });
}

async function postJoinLeave(
  discordGuild,
  guildId,
  serviceId,
  { type, profile, mapName, serverName }
) {
  const guild = getGuild(guildId);
  if (!isFeatureEnabled(guild, 'joinLeaveLogs') || !isFeatureConfigured(guild, 'joinLeaveLogs')) {
    return { ok: false, reason: 'disabled' };
  }

  const entry = getMapFeatureThread(guild, serviceId, 'joinLeaveLogs');
  if (!entry?.threadId) return { ok: false, reason: 'no_thread' };

  const thread = await discordGuild.channels.fetch(entry.threadId).catch(() => null);
  if (!thread) return { ok: false, reason: 'missing_thread' };

  const footerServer =
    serverName || formatMapName(mapName, mapName || 'Server') || 'Server';
  const embed = buildJoinLeaveEmbed(guild, {
    type,
    profile,
    serverName: footerServer,
    serviceId,
  });

  await thread.send({ embeds: [embed] });
  return { ok: true };
}

module.exports = {
  postJoinLeave,
  buildJoinLeaveEmbed,
  buildJoinEmbed,
  buildLeaveEmbed,
  JOIN_COLOR,
  LEAVE_COLOR,
};
