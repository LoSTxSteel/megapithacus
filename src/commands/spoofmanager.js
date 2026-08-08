const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { EPHEMERAL } = require('../utils/ephemeral');
const { buildSpoofManagerMessage } = require('../management/spoofHub');
const { canManageSpoof } = require('../services/guildPermissions');
const { errorEmbed } = require('../utils/embeds');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('spoofmanager')
    .setDescription('Configure Xbox gamertag spoof / name mismatch detection')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    if (!canManageSpoof(interaction)) {
      await interaction.reply({
        embeds: [
          errorEmbed(
            'You do not have permission to manage spoof detection.\n' +
              'Ask the server owner to grant your role with `/permissions` → **Spoof manager**.'
          ),
        ],
        ...EPHEMERAL,
      });
      return;
    }

    await interaction.reply(buildSpoofManagerMessage(interaction.guildId));
  },
};
