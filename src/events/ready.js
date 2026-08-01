const { Events } = require('discord.js');
const { brand } = require('../config');
const { startPopManager } = require('../services/popManager');
const { startLogBoards } = require('../services/logBoards');
const { startPlayerTracker } = require('../services/playerTracker');
const { startBanReminders } = require('../services/banReminders');
const { startStatusRotation } = require('../services/statusRotation');
const { startDeployNotify } = require('../services/deployNotify');
const { deploySlashCommands } = require('../services/deploySlashCommands');

module.exports = {
  name: Events.ClientReady,
  once: true,
  async execute(client) {
    console.log(`${brand.name} online as ${client.user.tag}`);
    try {
      await deploySlashCommands(client);
    } catch (error) {
      console.warn('Slash command deploy failed:', error.message);
    }
    startStatusRotation(client);
    startPopManager(client);
    startLogBoards(client);
    startPlayerTracker();
    startBanReminders(client);
    startDeployNotify(client);
  },
};
