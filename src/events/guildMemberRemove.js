const { Events } = require('discord.js');
const { getRewards, recordInviteLeave } = require('../services/credits');

module.exports = {
  name: Events.GuildMemberRemove,
  async execute(member) {
    try {
      if (!member?.guild || member.user?.bot) return;

      const guildId = member.guild.id;
      const rewards = getRewards(guildId);
      // Always reverse tracked attributions so counts stay accurate even if disabled later
      if (!rewards.inviteAttributions?.[String(member.id)]) return;

      const result = recordInviteLeave(guildId, member.id);
      if (!result.ok) return;

      if (result.clawedBack > 0) {
        console.log(
          `invite rewards: clawed back ${result.clawedBack}×${result.amount} ${result.type} from ${result.inviterId} after ${member.id} left ${guildId}`
        );
      }
    } catch (error) {
      console.error('guildMemberRemove invite reward failed:', error);
    }
  },
};
