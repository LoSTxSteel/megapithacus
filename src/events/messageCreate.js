const { Events } = require('discord.js');
const { handleEventPhotoDm } = require('./payBoardInteractions');
const { scheduleDmDelete, isDmPersistent } = require('../utils/dmCleanup');
const {
  buildSubscribeEmbed,
  isSubscribeText,
} = require('../services/subscribeInfo');
const { addSubscriber } = require('../services/announceSubscribers');

module.exports = {
  name: Events.MessageCreate,
  async execute(message) {
    try {
      // Auto-delete bot DMs after 5 minutes (except announcements)
      if (
        message.author?.id &&
        message.client?.user?.id &&
        message.author.id === message.client.user.id &&
        !message.guildId
      ) {
        if (!isDmPersistent(message)) {
          scheduleDmDelete(message);
        }
        return;
      }

      if (message.author?.bot) return;

      if (!message.guildId && isSubscribeText(message.content)) {
        addSubscriber(message.author.id, null);
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
