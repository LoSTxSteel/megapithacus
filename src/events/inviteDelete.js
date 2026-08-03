const { Events } = require('discord.js');
const { forgetInvite } = require('../services/inviteCache');

module.exports = {
  name: Events.InviteDelete,
  async execute(invite) {
    try {
      if (!invite?.guild?.id || !invite.code) return;
      forgetInvite(invite.guild.id, invite.code);
    } catch (error) {
      console.error('inviteDelete cache update failed:', error);
    }
  },
};
