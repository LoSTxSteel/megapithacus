const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { homePayload } = require('../management/hub');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('management')
    .setDescription('Admin management hub (Nitrado, features, subscription)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    await interaction.reply(homePayload());
  },
};
