const { Events } = require('discord.js');
const { EPHEMERAL } = require('../utils/ephemeral');
const { errorEmbed } = require('../utils/embeds');
const { handleManagement } = require('../management/hub');
const { handlePlayerInteraction } = require('./playerInteractions');
const { handlePermissionsInteraction } = require('../commands/permissions');

function isManagementInteraction(interaction) {
  const id = interaction.customId;
  return typeof id === 'string' && id.startsWith('mgmt:');
}

function tryDonateInteraction(interaction) {
  try {
    const { handleDonateInteraction } = require('./donateInteractions');
    return handleDonateInteraction(interaction);
  } catch (error) {
    console.warn('Donate interactions unavailable:', error.message);
    return false;
  }
}

function tryDonateHubInteraction(interaction) {
  try {
    const { handleDonateHubInteraction } = require('../management/donateHub');
    return handleDonateHubInteraction(interaction);
  } catch (error) {
    console.warn('Donate hub unavailable:', error.message);
    return false;
  }
}

function tryCreditHubInteraction(interaction) {
  try {
    const { handleCreditManagerInteraction } = require('../management/creditHub');
    return handleCreditManagerInteraction(interaction);
  } catch (error) {
    console.warn('Credit hub unavailable:', error.message);
    return false;
  }
}

function tryRewardHubInteraction(interaction) {
  try {
    const { handleRewardManagerInteraction } = require('../management/rewardHub');
    return handleRewardManagerInteraction(interaction);
  } catch (error) {
    console.warn('Reward hub unavailable:', error.message);
    return false;
  }
}

function tryServerManagerHubInteraction(interaction) {
  try {
    const { handleServerManagerInteraction } = require('../management/serverManagerHub');
    return handleServerManagerInteraction(interaction);
  } catch (error) {
    console.warn('Server manager hub unavailable:', error.message);
    return false;
  }
}

function tryGamerscoreHubInteraction(interaction) {
  try {
    const {
      handleGamerscoreManagerInteraction,
    } = require('../management/gamerscoreHub');
    return handleGamerscoreManagerInteraction(interaction);
  } catch (error) {
    console.warn('Gamerscore hub unavailable:', error.message);
    return false;
  }
}

function trySaveHubInteraction(interaction) {
  try {
    const { handleSaveHubInteraction } = require('../management/saveHub');
    return handleSaveHubInteraction(interaction);
  } catch (error) {
    console.warn('Save hub unavailable:', error.message);
    return false;
  }
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
            ...EPHEMERAL,
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

      if (await tryDonateInteraction(interaction)) {
        return;
      }

      if (await tryDonateHubInteraction(interaction)) {
        return;
      }

      if (await tryCreditHubInteraction(interaction)) {
        return;
      }

      if (await tryRewardHubInteraction(interaction)) {
        return;
      }

      if (await tryServerManagerHubInteraction(interaction)) {
        return;
      }

      if (await trySaveHubInteraction(interaction)) {
        return;
      }

      if (await tryGamerscoreHubInteraction(interaction)) {
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
        ...EPHEMERAL,
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
