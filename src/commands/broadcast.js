const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { EPHEMERAL } = require('../utils/ephemeral');
const { canManageServerPower, memberHasBotSetupRole } = require('../services/guildPermissions');
const { ADMIN_ROLE_NAME } = require('../services/botSetup');
const { errorEmbed, successEmbed } = require('../utils/embeds');
const { getGuild } = require('../services/storage');
const { MAX_LEN, broadcastOnCluster } = require('../services/gameBroadcast');

function canBroadcast(interaction) {
  return memberHasBotSetupRole(interaction) || canManageServerPower(interaction);
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('broadcast')
    .setDescription('Send an in-game broadcast to every synced Nitrado map')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((opt) =>
      opt
        .setName('message')
        .setDescription('Text shown to all players (cluster-wide)')
        .setRequired(true)
        .setMaxLength(MAX_LEN)
    ),

  async execute(interaction) {
    await interaction.deferReply({ ...EPHEMERAL });

    if (!canBroadcast(interaction)) {
      await interaction.editReply({
        embeds: [
          errorEmbed(
            `You do not have permission to broadcast.\n` +
              `Need **Manage Server**, the **${ADMIN_ROLE_NAME}** role, or a **Server power** role.`
          ),
        ],
      });
      return;
    }

    const message = interaction.options.getString('message', true);
    const guild = getGuild(interaction.guildId);
    const result = await broadcastOnCluster(guild, message);

    await interaction.editReply({
      embeds: [
        result.ok || result.results?.some((r) => r.ok)
          ? successEmbed('Broadcast', result.summary)
          : errorEmbed(result.summary || result.error || 'Broadcast failed.'),
      ],
    });
  },
};
