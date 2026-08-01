const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { buildPayPanel } = require('../management/adminPayHub');
const { payBoardPayload } = require('../services/payBoard');
const { canManageAdminPay } = require('../services/guildPermissions');
const { ensurePayApprovalForum } = require('../services/payLog');
const { errorEmbed, successEmbed } = require('../utils/embeds');
const { listEnabledActivities, getAdminPay } = require('../services/adminPay');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('adminpay')
    .setDescription('Admin Pay — roster, board, rates, and payouts')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) =>
      sub
        .setName('manage')
        .setDescription('Open Admin Pay management (roster, rates, credits, payouts)')
    )
    .addSubcommand((sub) =>
      sub
        .setName('board')
        .setDescription('Post the staff pay board and create the approval forum')
    ),

  async execute(interaction) {
    if (!canManageAdminPay(interaction)) {
      await interaction.reply({
        embeds: [
          errorEmbed(
            'You do not have permission to use **Admin Pay**.\n' +
              'Ask the server owner to grant your role with `/permissions set` → **Admin Pay**.'
          ),
        ],
        ephemeral: true,
      });
      return;
    }

    const sub = interaction.options.getSubcommand();

    if (sub === 'manage') {
      await interaction.reply({
        ...buildPayPanel(interaction.guildId),
        ephemeral: true,
      });
      return;
    }

    if (sub === 'board') {
      const pay = getAdminPay(interaction.guildId);
      if (!listEnabledActivities(pay).length) {
        await interaction.reply({
          embeds: [
            errorEmbed(
              'No event types are configured. Run `/adminpay manage` and set activity payouts first.'
            ),
          ],
          ephemeral: true,
        });
        return;
      }

      await interaction.deferReply({ ephemeral: true });

      let forumMention = '_Could not create forum_';
      try {
        const forum = await ensurePayApprovalForum(interaction.guild);
        forumMention = `<#${forum.id}>`;
      } catch (error) {
        await interaction.editReply({
          embeds: [
            errorEmbed(
              `Could not create the pay-logging forum: ${error.message}\n` +
                'Give the bot **Manage Channels**, then try again.'
            ),
          ],
        });
        return;
      }

      await interaction.channel.send(payBoardPayload(interaction.guildId));
      await interaction.editReply({
        embeds: [
          successEmbed(
            'Pay board posted',
            [
              'Staff can **Log complete event** or **Request pay** from the board.',
              `Managers approve both in ${forumMention}.`,
            ].join('\n')
          ),
        ],
      });
    }
  },
};
