const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { CATEGORY_NAME } = require('../services/featureSetup');
const { getGuild } = require('../services/storage');
const { runFullSetup, ADMIN_ROLE_NAME } = require('../services/botSetup');
const { guildEmbed, errorEmbed, successEmbed } = require('../utils/embeds');

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

      const result = await runFullSetup(interaction.guild);
      const { wipe, rebuild, roleResult, areas } = result;
      const deletedNames = wipe.deleted
        .slice(0, 12)
        .map((d) => `\`${d.name}\``)
        .join(', ');
      const createdNames = rebuild.created
        .map((c) => `\`${c.name}\``)
        .join(', ');

      await interaction.editReply({
        embeds: [
          successEmbed(
            'Megapithacus setup complete',
            [
              `Scanned **${wipe.scanned}** bot-related channel(s).`,
              `Deleted **${wipe.deleted.length}** (logging + category).${
                deletedNames ? ` ${deletedNames}` : ''
              }${wipe.failed.length ? ` · **${wipe.failed.length}** failed` : ''}`,
              `Recreated under **${CATEGORY_NAME}**: ${createdNames || '_none_'}`,
              '',
              `Admin role: ${roleResult.role} — ${
                roleResult.created ? 'created' : 'already existed'
              }`,
              `Granted: **${areas.join('**, **')}**`,
              '',
              `**${ADMIN_ROLE_NAME}** is required (with Manage Server / owner) for **start / stop / restart** via Server Management → Server power.`,
              'Assign that role to staff who should control servers and the bot.',
            ].join('\n')
          ),
          guildEmbed(getGuild(interaction.guildId), 'Next steps', {
            context: 'Hub',
          }).setDescription(
            [
              '1. `/management` → **Server Setup** — add Nitrado tokens & sync maps',
              '2. `/management` → **Server Management** → **Server power** — start / stop / restart',
              '3. `/permissions` — tweak which roles can use Admin Pay, Donations, Server power',
            ].join('\n')
          ),
        ],
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
