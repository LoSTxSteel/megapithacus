const { Events, EmbedBuilder } = require('discord.js');
const {
  getRewards,
  tryCreditBoost,
} = require('../services/credits');
const { getGuild } = require('../services/storage');
const { brandEmbed } = require('../utils/embeds');

const BOOST_PINK = 0xff69b4;

module.exports = {
  name: Events.GuildMemberUpdate,
  async execute(oldMember, newMember) {
    try {
      const newTs = newMember.premiumSinceTimestamp;
      if (!newTs) return;

      const oldTs = oldMember.premiumSinceTimestamp;
      // Unrelated member updates while already boosting keep the same timestamp
      if (oldTs === newTs) return;

      const guildId = newMember.guild.id;
      const rewards = getRewards(guildId);
      if (!rewards.boostEnabled || !rewards.boostChannelId) return;

      const result = tryCreditBoost(guildId, newMember.id, newTs);
      if (!result.ok) return;

      const channel = await newMember.guild.channels
        .fetch(rewards.boostChannelId)
        .catch(() => null);
      if (!channel || typeof channel.send !== 'function') return;

      const guild = getGuild(guildId);
      const creditType = result.type === 'permanent' ? 'permanent' : 'seasonal';
      const embed = brandEmbed(
        new EmbedBuilder()
          .setTitle('Thanks for the boost!')
          .setDescription(
            [
              `Thank you <@${newMember.id}> for boosting the server!`,
              `You've been granted +\`${result.amount}\` ${creditType} credit.`,
            ].join('\n')
          ),
        guild,
        { context: 'Boost rewards', thumbnail: true }
      ).setColor(BOOST_PINK);

      await channel.send({
        content: `<@${newMember.id}>`,
        embeds: [embed],
      });
    } catch (error) {
      console.error('guildMemberUpdate boost reward failed:', error);
    }
  },
};
