const { Events } = require('discord.js');
const { handleEventPhotoDm } = require('./payBoardInteractions');

module.exports = {
  name: Events.MessageCreate,
  async execute(message) {
    try {
      await handleEventPhotoDm(message);
    } catch (error) {
      console.error('messageCreate handler failed:', error);
    }
  },
};
