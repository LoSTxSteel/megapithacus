const { Events } = require('discord.js');
const { errorEmbed } = require('../utils/embeds');
const { handleManagement } = require('../management/hub');
const { handleAdminPayInteraction } = require('../management/adminPayHub');
const { handlePlayerInteraction } = require('./playerInteractions');
const { handlePermissionsInteraction } = require('../commands/permissions');
const { handlePayBoardInteraction } = require('./payBoardInteractions');

function isManagementInteraction(interaction) {
  const id = interaction.customId;
  return typeof id === 'string' && id.startsWith('mgmt:');
}

module.exports = {
  name: Events.InteractionCreate,
  async execute(interaction) {
    try {
      if (interaction.isChatInputCommand()) {
        const command = interaction.client.commands.get(interaction.commandName);
        if (!command) {
          console.warn(`Unknown slash command: /${interaction.commandName}`);
          await interaction.reply({
            embeds: [
              errorEmbed(
                `Command \`/${interaction.commandName}\` is not loaded on this bot instance. Wait for a restart, or check the console.`
              ),
            ],
            ephemeral: true,
          });
          return;
        }
        await command.execute(interaction);
        return;
      }

      if (await handlePlayerInteraction(interaction)) {
        return;
      }

      if (await handlePermissionsInteraction(interaction)) {
        return;
      }

      if (await handlePayBoardInteraction(interaction)) {
        return;
      }

      if (await handleAdminPayInteraction(interaction)) {
        return;
      }

      if (
        isManagementInteraction(interaction) &&
        (interaction.isStringSelectMenu() ||
          interaction.isButton() ||
          interaction.isUserSelectMenu() ||
          interaction.isModalSubmit() ||
          interaction.isChannelSelectMenu() ||
          interaction.isRoleSelectMenu())
      ) {
        await handleManagement(interaction);
      }
    } catch (error) {
      console.error('Interaction failed:', error);
      const payload = {
        embeds: [errorEmbed('Something went wrong. Check the bot console for details.')],
        ephemeral: true,
      };

      try {
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp(payload);
        } else if (interaction.isRepliable()) {
          await interaction.reply(payload);
        }
      } catch {
        // ignore secondary reply failures
      }
    }
  },
};
