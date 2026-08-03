const { Events, EmbedBuilder } = require('discord.js');
const { getRewards, recordInviteJoin } = require('../services/credits');
const { resolveInviter } = require('../services/inviteCache');
const { getGuild } = require('../services/storage');
const { brandEmbed } = require('../utils/embeds');

const INVITE_PINK = 0xff69b4;

module.exports = {
  name: Events.GuildMemberAdd,
  async execute(member) {
    try {
      if (!member?.guild || member.user?.bot) return;

      const guildId = member.guild.id;
      const rewards = getRewards(guildId);
      if (!rewards.inviteEnabled || !rewards.inviteChannelId) return;

      const resolved = await resolveInviter(member);
      if (!resolved.inviterId || resolved.vanity) return;

      const result = recordInviteJoin(guildId, member.id, resolved.inviterId);
      if (!result.ok) return;

      const channel = await member.guild.channels
        .fetch(rewards.inviteChannelId)
        .catch(() => null);
      if (!channel || typeof channel.send !== 'function') return;

      const guild = getGuild(guildId);
      const lines = [
        `Thanks for joining, <@${member.id}>!`,
        `Invited by <@${resolved.inviterId}>.`,
      ];

      if (result.granted > 0) {
        const creditType = result.type === 'permanent' ? 'permanent' : 'seasonal';
        lines.push(
          `<@${resolved.inviterId}> earned +\`${result.amount}\` ${creditType} credit` +
            (result.granted > 1 ? ` (×${result.granted})` : '') +
            ` · \`${result.invites}\` invite(s).`
        );
      } else if (result.required > 1) {
        lines.push(
          `Invite progress for <@${resolved.inviterId}>: \`${result.progressInCycle}/${result.required}\` toward the next reward.`
        );
      } else {
        lines.push(
          `<@${resolved.inviterId}> now has \`${result.invites}\` tracked invite(s).`
        );
      }

      const embed = brandEmbed(
        new EmbedBuilder()
          .setTitle('Thanks for joining!')
          .setDescription(lines.join('\n')),
        guild,
        { context: 'Invite rewards', thumbnail: true }
      ).setColor(INVITE_PINK);

      await channel.send({
        content: `<@${member.id}>`,
        embeds: [embed],
      });
    } catch (error) {
      console.error('guildMemberAdd invite reward failed:', error);
    }
  },
};
