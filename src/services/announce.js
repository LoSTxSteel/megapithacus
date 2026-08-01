const { EmbedBuilder } = require('discord.js');
const { getGuild } = require('./storage');
const { brandEmbed } = require('../utils/embeds');
const { listSubscriberIds } = require('./announceSubscribers');
const { markDmPersistent } = require('../utils/dmCleanup');

const ANNOUNCE_TYPES = {
  discount: { label: 'Discount', title: 'Announcement: Discount' },
  update: { label: 'Update', title: 'Announcement: Update' },
  other: { label: 'Other', title: 'Announcement' },
};

function buildAnnounceEmbed(guildId, { type, title, message }) {
  const meta = ANNOUNCE_TYPES[type] || ANNOUNCE_TYPES.other;
  const guild = guildId ? getGuild(guildId) : null;
  const heading = title?.trim() || meta.title;

  return brandEmbed(
    new EmbedBuilder()
      .setTitle(heading.slice(0, 256))
      .setDescription(String(message).slice(0, 4096))
      .addFields({
        name: 'Type',
        value: meta.label,
        inline: true,
      }),
    guild,
    { context: 'Announce', thumbnail: true }
  );
}

/**
 * DM all announce subscribers. Announcement DMs are not auto-deleted.
 */
async function broadcastAnnounce(client, guildId, payload) {
  const embed = buildAnnounceEmbed(guildId, payload);
  const userIds = listSubscriberIds();
  let sent = 0;
  let failed = 0;

  for (const userId of userIds) {
    try {
      const user = await client.users.fetch(userId);
      const msg = await user.send({ embeds: [embed] });
      markDmPersistent(msg);
      sent += 1;
    } catch {
      failed += 1;
    }
  }

  return { sent, failed, total: userIds.length, embed };
}

module.exports = {
  ANNOUNCE_TYPES,
  buildAnnounceEmbed,
  broadcastAnnounce,
};
