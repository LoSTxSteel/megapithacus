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
    console.log(
      `Ready: ${client.commands.size} command(s) in memory:`,
      [...client.commands.keys()].sort().join(', ')
    );
    try {
      const result = await deploySlashCommands(client);
      if (result?.refused) {
        console.error(
          'Slash deploy refused (incomplete command set). Credit/reward will not appear until host has new code.'
        );
      } else if (result?.ok) {
        console.log(
          `Slash deploy OK (${result.count}):`,
          (result.names || []).join(', ')
        );
      } else {
        console.warn('Slash deploy did not complete:', result);
      }
    } catch (error) {
      console.error('Slash command deploy failed:', error.message);
      if (error.rawError) {
        console.error('Slash deploy details:', JSON.stringify(error.rawError));
      }
      if (error.stack) console.error(error.stack);
    }
    startStatusRotation(client);
    startPopManager(client);
    startLogBoards(client);
    startPlayerTracker(client);
    startBanReminders(client);
    startDeployNotify(client);
  },
};
