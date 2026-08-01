const { Events, ActivityType } = require('discord.js');
const { brand } = require('../config');
const { startPopManager } = require('../services/popManager');
const { startLogBoards } = require('../services/logBoards');
const { startPlayerTracker } = require('../services/playerTracker');
const { startBanReminders } = require('../services/banReminders');

module.exports = {
  name: Events.ClientReady,
  once: true,
  execute(client) {
    console.log(`${brand.name} online as ${client.user.tag}`);
    client.user.setActivity('MS Store ASE | /help', {
      type: ActivityType.Watching,
    });
    startPopManager(client);
    startLogBoards(client);
    startPlayerTracker();
    startBanReminders(client);
  },
};
