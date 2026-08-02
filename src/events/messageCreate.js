const { Events } = require('discord.js');
const { scheduleDmDelete, isDmPersistent } = require('../utils/dmCleanup');

module.exports = {
  name: Events.MessageCreate,
  async execute(message) {
    try {
      // Auto-delete bot DMs after 5 minutes (except marked persistent)
      if (
        message.author?.id &&
        message.client?.user?.id &&
        message.author.id === message.client.user.id &&
        !message.guildId
      ) {
        if (!isDmPersistent(message)) {
          scheduleDmDelete(message);
        }
      }
    } catch (error) {
      console.error('messageCreate handler failed:', error);
    }
  },
};
