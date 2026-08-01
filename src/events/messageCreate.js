const { Events } = require('discord.js');
const { handleEventPhotoDm } = require('./payBoardInteractions');
const { scheduleDmDelete, isDmPersistent } = require('../utils/dmCleanup');
const {
  buildSubscribeEmbed,
  isSubscribeText,
} = require('../services/subscribeInfo');
const {
  addSubscriber,
  removeSubscriber,
} = require('../services/announceSubscribers');
const { brandEmbed } = require('../utils/embeds');
const { EmbedBuilder } = require('discord.js');

function normalizeDmCommand(content) {
  return String(content || '')
    .trim()
    .toLowerCase()
    .replace(/^[!./]/, '');
}

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

      if (!message.guildId) {
        const cmd = normalizeDmCommand(message.content);

        if (cmd === 'notify') {
          addSubscriber(message.author.id, null);
          const sent = await message.channel.send({
            embeds: [
              brandEmbed(
                new EmbedBuilder()
                  .setTitle('Notifications enabled')
                  .setDescription(
                    'You will receive announcement DMs.\nReply `unnotify` or use `/unnotify` to stop.'
                  ),
                null,
                { context: 'Help', thumbnail: true }
              ),
            ],
          });
          scheduleDmDelete(sent);
          return;
        }

        if (cmd === 'unnotify') {
          removeSubscriber(message.author.id);
          const sent = await message.channel.send({
            embeds: [
              brandEmbed(
                new EmbedBuilder()
                  .setTitle('Notifications disabled')
                  .setDescription(
                    'You will no longer receive announcement DMs.\nReply `notify` or use `/notify` to opt back in.'
                  ),
                null,
                { context: 'Help', thumbnail: true }
              ),
            ],
          });
          scheduleDmDelete(sent);
          return;
        }

        if (isSubscribeText(message.content)) {
          addSubscriber(message.author.id, null);
          const sent = await message.channel.send({
            embeds: [buildSubscribeEmbed(null)],
          });
          scheduleDmDelete(sent);
          return;
        }
      }

      await handleEventPhotoDm(message);
    } catch (error) {
      console.error('messageCreate handler failed:', error);
    }
  },
};
