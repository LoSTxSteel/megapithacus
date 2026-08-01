const { Events } = require('discord.js');
const { handleEventPhotoDm } = require('./payBoardInteractions');
const { scheduleDmDelete } = require('../utils/dmCleanup');
const {
  buildSubscribeEmbed,
  isSubscribeText,
} = require('../services/subscribeInfo');

module.exports = {
  name: Events.MessageCreate,
  async execute(message) {
    try {
      // Auto-delete every bot DM after 5 minutes
      if (
        message.author?.id &&
        message.client?.user?.id &&
        message.author.id === message.client.user.id &&
        !message.guildId
      ) {
        scheduleDmDelete(message);
        return;
      }

      if (message.author?.bot) return;

      // DM (or mention-free DM) "subscribe"
      if (!message.guildId && isSubscribeText(message.content)) {
        const sent = await message.channel.send({
          embeds: [buildSubscribeEmbed(null)],
        });
        scheduleDmDelete(sent);
        return;
      }

      await handleEventPhotoDm(message);
    } catch (error) {
      console.error('messageCreate handler failed:', error);
    }
  },
};
