const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { executeSearch } = require('./player');

/**
 * `/playersearch` — live Nitrado online check + fresh profile data.
 */
module.exports = {
  data: new SlashCommandBuilder()
    .setName('playersearch')
    .setDescription('Search players (live online check + latest stored data)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((opt) =>
      opt
        .setName('query')
        .setDescription('Gamertag, character name, or Nitrado player id')
        .setRequired(true)
    ),

  async execute(interaction) {
    await executeSearch(interaction);
  },
};
