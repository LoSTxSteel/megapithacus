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
      const result = await deploySlashCommands(client);
      if (result?.names?.length) {
        console.log('Slash deploy names:', result.names.join(', '));
      }
    } catch (error) {
      console.warn('Slash command deploy failed:', error.message);
      if (error.rawError) {
        console.warn('Slash deploy details:', JSON.stringify(error.rawError));
      }
    }
    startStatusRotation(client);
    startPopManager(client);
    startLogBoards(client);
    startPlayerTracker(client);
    startBanReminders(client);
    startDeployNotify(client);
  },
};
