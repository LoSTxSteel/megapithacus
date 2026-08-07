const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { EPHEMERAL } = require('../utils/ephemeral');
const { searchPlayers, upsertPlayer } = require('../services/playerDb');
const { moderatePlayer } = require('../services/playerModeration');
const { parseBanDurationInput } = require('../services/banStore');
const { canModeratePlayers } = require('../services/guildPermissions');
const { ADMIN_ROLE_NAME } = require('../services/botSetup');
const { errorEmbed, successEmbed } = require('../utils/embeds');
const { getGuild } = require('../services/storage');

function namesEqual(a, b) {
  if (a == null || b == null) return false;
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

/**
 * Resolve gamertag / player id / specimen to a player profile (creates stub if needed).
 */
function resolveBanTarget(guildId, identifier) {
  const raw = String(identifier || '').trim();
  if (!raw) return { ok: false, error: 'Identifier is required.' };

  const results = searchPlayers(guildId, raw);
  const exact = results.find(
    (p) =>
      namesEqual(p.gamertag, raw) ||
      namesEqual(p.characterName, raw) ||
      namesEqual(p.specimenImplant, raw) ||
      namesEqual(p.nitradoPlayerId, raw) ||
      namesEqual(p.platformId, raw)
  );
  if (exact) return { ok: true, profile: exact };

  if (results.length === 1) return { ok: true, profile: results[0] };
  if (results.length > 1) {
    const sample = results
      .slice(0, 5)
      .map((p) => p.gamertag || p.characterName || p.id)
      .join(', ');
    return {
      ok: false,
      error:
        `Multiple players match \`${raw}\` (${results.length}). ` +
        `Be more specific (e.g. full gamertag). Matches include: ${sample}`,
    };
  }

  // No stored profile — still ban by gamertag via Nitrado banlist
  const profile = upsertPlayer(guildId, { gamertag: raw });
  return { ok: true, profile, stub: true };
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ban')
    .setDescription('Ban a player on the Nitrado cluster (banlist + logs)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((opt) =>
      opt
        .setName('identifier')
        .setDescription('Gamertag, character name, specimen, or player id')
        .setRequired(true)
    )
    .addStringOption((opt) =>
      opt
        .setName('duration')
        .setDescription('e.g. 1h, 1d, 7d, permanent, or 0 for permanent')
        .setRequired(true)
    )
    .addStringOption((opt) =>
      opt
        .setName('reason')
        .setDescription('Ban reason')
        .setRequired(true)
        .setMaxLength(500)
    ),

  resolveBanTarget,

  async execute(interaction) {
    await interaction.deferReply({ ...EPHEMERAL });

    if (!canModeratePlayers(interaction)) {
      await interaction.editReply({
        embeds: [
          errorEmbed(
            `You need **Manage Server**, the **${ADMIN_ROLE_NAME}** role, or **Ban Members** to use \`/ban\`.`
          ),
        ],
      });
      return;
    }

    const identifier = interaction.options.getString('identifier', true);
    const durationRaw = interaction.options.getString('duration', true);
    const reason = interaction.options.getString('reason', true).trim();

    const duration = parseBanDurationInput(durationRaw);
    if (!duration) {
      await interaction.editReply({
        embeds: [
          errorEmbed(
            `Invalid duration \`${durationRaw}\`.\n` +
              'Use formats like `1h`, `6h`, `1d`, `7d`, `30d`, `permanent`, or `0`.'
          ),
        ],
      });
      return;
    }

    if (!reason) {
      await interaction.editReply({
        embeds: [errorEmbed('A ban reason is required.')],
      });
      return;
    }

    const resolved = resolveBanTarget(interaction.guildId, identifier);
    if (!resolved.ok) {
      await interaction.editReply({
        embeds: [errorEmbed(resolved.error)],
      });
      return;
    }

    const result = await moderatePlayer(interaction.guild, {
      profileId: resolved.profile.id,
      action: 'ban',
      moderator: interaction.user,
      reason,
      durationValue: duration.durationValue,
      durationLabel: duration.durationLabel,
      durationMs: duration.durationMs,
    });

    if (!result.ok) {
      await interaction.editReply({
        embeds: [errorEmbed(result.error || 'Ban failed.')],
      });
      return;
    }

    const guild = getGuild(interaction.guildId);
    const embed = successEmbed('Ban issued', result.message, guild);
    if (resolved.stub) {
      embed.addFields({
        name: 'Note',
        value:
          'No stored player profile matched — banned using the identifier as gamertag.',
      });
    }

    await interaction.editReply({ embeds: [embed] });
  },
};
