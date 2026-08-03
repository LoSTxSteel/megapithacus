const { Events } = require('discord.js');
const { rememberInvite } = require('../services/inviteCache');

module.exports = {
  name: Events.InviteCreate,
  async execute(invite) {
    try {
      if (!invite?.guild?.id) return;
      rememberInvite(invite.guild.id, invite);
    } catch (error) {
      console.error('inviteCreate cache update failed:', error);
    }
  },
};
