const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { EPHEMERAL } = require('../utils/ephemeral');
const { getGuild } = require('../services/storage');
const { runFullSetup } = require('../services/botSetup');
const { guildEmbed, errorEmbed } = require('../utils/embeds');

/** Discord: max 10 embeds / message, 25 fields / embed, ~6000 chars / embed */
const MAX_EMBEDS_PER_MESSAGE = 10;
const MAX_FIELDS_PER_EMBED = 25;
const MAX_EMBED_CHARS = 5500;

/**
 * Build purple brand embeds listing every loaded slash command (name + description).
 */
function buildCommandOverviewEmbeds(client, guild) {
  const commands = [...(client?.commands?.values?.() || [])]
    .filter((c) => c?.data?.name)
    .map((c) => ({
      name: String(c.data.name),
      description: String(c.data.description || 'No description').slice(0, 1024),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (!commands.length) {
    return [
      guildEmbed(guild, 'Slash commands', {
        context: 'Setup',
        description: '_No slash commands are loaded on this bot instance._',
      }),
    ];
  }

  const embeds = [];
  let fields = [];
  let charCount = 0;

  const flush = () => {
    if (!fields.length) return;
    const page = embeds.length + 1;
    const title =
      page === 1 ? 'Slash commands' : `Slash commands (${page})`;
    const embed = guildEmbed(guild, title, {
      context: 'Setup',
      description:
        page === 1
          ? `Every slash command currently loaded (**${commands.length}**):`
          : undefined,
    }).addFields(fields);
    embeds.push(embed);
    fields = [];
    charCount = 0;
  };

  for (const cmd of commands) {
    const name = `/${cmd.name}`;
    const value = cmd.description;
    const add = name.length + value.length + 8;
    if (
      fields.length >= MAX_FIELDS_PER_EMBED ||
      (fields.length && charCount + add > MAX_EMBED_CHARS)
    ) {
      flush();
    }
    fields.push({ name, value, inline: false });
    charCount += add;
  }
  flush();
  return embeds;
}

async function sendCommandOverview(interaction, guild) {
  const embeds = buildCommandOverviewEmbeds(interaction.client, guild);
  for (let i = 0; i < embeds.length; i += MAX_EMBEDS_PER_MESSAGE) {
    const chunk = embeds.slice(i, i + MAX_EMBEDS_PER_MESSAGE);
    await interaction.followUp({
      embeds: chunk,
      ...EPHEMERAL,
    });
  }
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('setup')
    .setDescription(
      'Scan Discord, wipe & recreate Megapithacus logging channels, and set the admin role'
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  buildCommandOverviewEmbeds,
  sendCommandOverview,

  async execute(interaction) {
    // Defer immediately — Discord requires a response within ~3s
    await interaction.deferReply({ ...EPHEMERAL });

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

      await sendCommandOverview(
        interaction,
        getGuild(interaction.guildId)
      ).catch((err) => {
        console.warn('/setup command overview follow-up failed:', err.message);
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
