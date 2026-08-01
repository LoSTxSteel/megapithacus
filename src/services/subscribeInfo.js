const { brand } = require('../config');
const { getGuild, listGuildIds } = require('./storage');
const { brandEmbed } = require('../utils/embeds');
const { EmbedBuilder } = require('discord.js');

function clusterForContext(guildId) {
  if (guildId) return getGuild(guildId);
  const ids = listGuildIds();
  if (ids.length === 1) return getGuild(ids[0]);
  return null;
}

/**
 * Public subscribe reply — currently under maintenance.
 */
function buildSubscribeEmbed(guildId = null) {
  const guild = clusterForContext(guildId);

  return brandEmbed(
    new EmbedBuilder()
      .setTitle('Subscribe')
      .setDescription(
        [
          '**Under maintenance.**',
          '',
          'Subscribe info is temporarily unavailable. Please try again later.',
          '',
          `_— ${brand.name}_`,
        ].join('\n')
      ),
    guild,
    { context: 'Help', thumbnail: true }
  );
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
