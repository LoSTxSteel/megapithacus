const { brand, platform } = require('../config');
const { getGuild, listGuildIds } = require('./storage');
const { brandEmbed } = require('../utils/embeds');
const { EmbedBuilder } = require('discord.js');

function clusterForContext(guildId) {
  if (guildId) return getGuild(guildId);
  const ids = listGuildIds();
  if (ids.length === 1) return getGuild(ids[0]);
  return null;
}

function mapLines(guild) {
  const servers = guild?.servers || [];
  if (!servers.length) return null;
  return servers
    .slice(0, 15)
    .map((s) => `• **${s.name || s.map || s.serviceId}**`)
    .join('\n');
}

/**
 * Public “how to subscribe / join” embed.
 */
function buildSubscribeEmbed(guildId = null) {
  const guild = clusterForContext(guildId);
  const clusterName = guild?.clusterName || 'our ASE cluster';
  const maps = mapLines(guild);

  const embed = brandEmbed(
    new EmbedBuilder()
      .setTitle('How to subscribe / join')
      .setDescription(
        [
          `Play on **${clusterName}** — **${platform.game}** (${platform.store}) hosted on **${platform.host}**.`,
          '',
          '**1. Get the game**',
          '• Install **ARK: Survival Evolved** from the **Microsoft Store** / Xbox app',
          '• Xbox Game Pass / PC Game Pass works for Microsoft Store ASE',
          '',
          '**2. Join the cluster**',
          '• Open ARK → **Join Ark** / server browser',
          '• Filter for **Unofficial** / dedicated sessions',
          `• Search for **${clusterName}** (or the map name your admins share)`,
          '• Join any map in the cluster — transfers work between linked maps',
          '',
          '**3. Stay in the loop on Discord**',
          '• Unmute announcement / event channels if you want pings',
          '• Ask staff for roles if your server uses ping roles for raids / events',
          '• Use `/help` for bot commands',
          '',
          `_This message is from **${brand.name}**. Bot DMs auto-delete after 5 minutes._`,
        ].join('\n')
      ),
    guild,
    { context: 'Help', thumbnail: true }
  );

  if (maps) {
    embed.addFields({
      name: 'Synced maps',
      value: maps.slice(0, 1024),
    });
  }

  return embed;
}

function isSubscribeText(content) {
  const t = String(content || '')
    .trim()
    .toLowerCase()
    .replace(/^[!./]/, '');
  return t === 'subscribe' || t === 'sub';
}

module.exports = {
  buildSubscribeEmbed,
  isSubscribeText,
};
