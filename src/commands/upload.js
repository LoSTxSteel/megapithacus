const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { EPHEMERAL } = require('../utils/ephemeral');
const { openUploadHub } = require('../management/saveHub');
const { canManageServerPower } = require('../services/guildPermissions');
const { errorEmbed } = require('../utils/embeds');
const { ADMIN_ROLE_NAME } = require('../services/botSetup');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('upload')
    .setDescription('Upload a custom ASE .ark save to a Nitrado server')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addAttachmentOption((opt) =>
      opt
        .setName('save')
        .setDescription('ASE map save (.ark / .arktribe / .bak) — Discord size limits apply')
        .setRequired(true)
    ),

  async execute(interaction) {
    if (!canManageServerPower(interaction)) {
      await interaction.reply({
        embeds: [
          errorEmbed(
            `You do not have permission to manage servers.\n` +
              `Need **Manage Server**, the **${ADMIN_ROLE_NAME}** role, or a role granted under **Server power**.`
          ),
        ],
        ...EPHEMERAL,
      });
      return;
    }

    const attachment = interaction.options.getAttachment('save', true);
    await interaction.deferReply({ ...EPHEMERAL });
    await interaction.editReply(await openUploadHub(interaction, attachment));
  },
};
