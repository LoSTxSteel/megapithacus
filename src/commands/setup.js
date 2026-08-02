const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { getGuild } = require('../services/storage');
const { runFullSetup } = require('../services/botSetup');
const { guildEmbed, errorEmbed } = require('../utils/embeds');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('setup')
    .setDescription(
      'Scan Discord, wipe & recreate Megapithacus logging channels, and set the admin role'
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction) {
    // Defer immediately — Discord requires a response within ~3s
    await interaction.deferReply({ ephemeral: true });

    try {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
        await interaction.editReply({
          embeds: [
            errorEmbed('You need the **Administrator** permission to run `/setup`.'),
          ],
        });
        return;
      }

      const me = interaction.guild.members.me;
      const missing = [];
      if (!me?.permissions.has(PermissionFlagsBits.ManageChannels)) {
        missing.push('Manage Channels');
      }
      if (!me?.permissions.has(PermissionFlagsBits.ManageRoles)) {
        missing.push('Manage Roles');
      }
      if (missing.length) {
        await interaction.editReply({
          embeds: [
            errorEmbed(
              `I need **${missing.join('** and **')}** to finish setup.\n` +
                'Give those to the bot role, then run `/setup` again.'
            ),
          ],
        });
        return;
      }

      await interaction.editReply({
        embeds: [
          guildEmbed(getGuild(interaction.guildId), 'Running setup…', {
            context: 'Hub',
          }).setDescription(
            'Scanning and rebuilding Megapithacus channels. This can take a minute.'
          ),
        ],
      });

      await runFullSetup(interaction.guild);

      await interaction.editReply({
        content: 'Setup successful.',
        embeds: [],
      });
    } catch (error) {
      console.error('/setup failed:', error);
      try {
        await interaction.editReply({
          embeds: [errorEmbed(`Setup failed: ${error.message}`)],
        });
      } catch {
        // ignore
      }
    }
  },
};
