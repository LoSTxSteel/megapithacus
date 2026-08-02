const {
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
} = require('discord.js');
const { searchPlayersLive } = require('../services/playerLiveSearch');
const {
  listBansForPlayer,
  findActiveBanForPlayer,
  durationMeta,
} = require('../services/banStore');
const { errorEmbed, brandEmbed, guildEmbed } = require('../utils/embeds');
const { EPHEMERAL } = require('../utils/ephemeral');
const { getGuild } = require('../services/storage');

function kickLinesFromNotes(notes) {
  if (!notes || notes === 'FAKE_TEST_PROFILE') return [];
  return String(notes)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /\]\s*KICK\b/i.test(line));
}

function formatBanLine(ban) {
  const when = ban.startsAt || ban.createdAt;
  const ts = when
    ? `<t:${Math.floor(new Date(when).getTime() / 1000)}:d>`
    : '—';
  const meta = ban.durationValue ? durationMeta(ban.durationValue) : null;
  const duration =
    ban.duration || meta?.label || (ban.endsAt ? 'Timed' : 'Permanent');
  const status = ban.active
    ? '**Active**'
    : ban.unbannedAt
      ? 'Lifted'
      : 'Expired';
  const reason = (ban.reason || 'No reason').slice(0, 80);
  return `• ${ts} · Ban (${duration}) · ${status} · ${reason}`;
}

function formatKickLine(line) {
  // [ISO] KICK by tag: reason
  const match = line.match(
    /^\[([^\]]+)\]\s*KICK\s+by\s+([^:]+):\s*(.*)$/i
  );
  if (!match) return `• Kick · ${line.slice(0, 100)}`;
  const [, iso, by, reason] = match;
  const t = new Date(iso).getTime();
  const when = Number.isFinite(t)
    ? `<t:${Math.floor(t / 1000)}:d>`
    : iso.slice(0, 10);
  return `• ${when} · Kick · ${(reason || 'No reason').slice(0, 80)} · by ${by.trim()}`;
}

function punishmentHistoryLines(guildId, profile, limit = 8) {
  const bans = listBansForPlayer(guildId, profile);
  const kicks = kickLinesFromNotes(profile.notes);

  const items = [
    ...bans.map((ban) => ({
      at: new Date(ban.startsAt || ban.createdAt || 0).getTime() || 0,
      line: formatBanLine(ban),
    })),
    ...kicks.map((line) => {
      const match = line.match(/^\[([^\]]+)\]/);
      const at = match ? new Date(match[1]).getTime() : 0;
      return {
        at: Number.isFinite(at) ? at : 0,
        line: formatKickLine(line),
      };
    }),
  ]
    .sort((a, b) => b.at - a.at)
    .slice(0, limit);

  return items.map((i) => i.line);
}

function punishmentSummary(guildId, profile) {
  const bans = listBansForPlayer(guildId, profile);
  const kicks = kickLinesFromNotes(profile.notes);
  const active = findActiveBanForPlayer(guildId, profile);
  const total = bans.length + kicks.length;
  if (!total) return null;
  if (active) return `Banned · ${total} record${total === 1 ? '' : 's'}`;
  return `${total} past punishment${total === 1 ? '' : 's'}`;
}

function onlineStatusValue(profile) {
  if (profile.online) {
    const where = [profile.map, profile.serverName].filter(Boolean).join(' · ');
    return where ? `🟢 Online · ${where}` : '🟢 Online';
  }
  const last =
    profile.lastSeen || profile.lastLeave || profile.lastJoin || null;
  if (last) {
    const t = Math.floor(new Date(last).getTime() / 1000);
    if (Number.isFinite(t)) {
      return `⚫ Offline · last seen <t:${t}:R>`;
    }
  }
  return '⚫ Offline';
}

function profileEmbed(profile, guildId) {
  const guild = guildId ? getGuild(guildId) : null;
  const embed = brandEmbed(
    new EmbedBuilder()
      .setTitle(
        profile.characterName &&
          profile.gamertag &&
          profile.characterName.toLowerCase() !== profile.gamertag.toLowerCase()
          ? profile.characterName
          : profile.gamertag || profile.characterName || 'Unknown player'
      )
      .setDescription(
        profile.notes === 'FAKE_TEST_PROFILE'
          ? '_Fake test profile for Megapithacus development._'
          : 'Player profile — live Nitrado status + join logging.'
      )
      .addFields(
        { name: 'Xbox Gamertag', value: profile.gamertag || '—', inline: true },
        {
          name: 'In-game name',
          value:
            profile.characterName &&
            profile.gamertag &&
            profile.characterName.toLowerCase() === profile.gamertag.toLowerCase()
              ? '—'
              : profile.characterName || '—',
          inline: true,
        },
        {
          name: 'Specimen Implant',
          value: profile.specimenImplant ? `\`${profile.specimenImplant}\`` : '—',
          inline: true,
        },
        { name: 'Tribe', value: profile.tribeName || '—', inline: true },
        { name: 'Tribe ID', value: profile.tribeId ? `\`${profile.tribeId}\`` : '—', inline: true },
        { name: 'Map', value: profile.map || '—', inline: true },
        { name: 'Status', value: onlineStatusValue(profile), inline: true },
        {
          name: 'First seen',
          value: profile.firstSeen
            ? `<t:${Math.floor(new Date(profile.firstSeen).getTime() / 1000)}:f>`
            : '—',
          inline: true,
        },
        {
          name: 'Last join',
          value: profile.lastJoin
            ? `<t:${Math.floor(new Date(profile.lastJoin).getTime() / 1000)}:R>`
            : '—',
          inline: true,
        }
      ),
    guild,
    { context: 'Player DB' }
  );

  if (profile.nitradoPlayerId) {
    embed.addFields({
      name: 'Nitrado player id',
      value: `\`${profile.nitradoPlayerId}\``,
      inline: true,
    });
  }

  if (guildId) {
    const history = punishmentHistoryLines(guildId, profile);
    embed.addFields({
      name: 'Past punishments',
      value: history.length
        ? history.join('\n').slice(0, 1024)
        : '_No bans or kicks on record._',
    });
  }

  return embed;
}

function moderationMenu(profileId) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`player:mod:${profileId}`)
      .setPlaceholder('Ban, unban, or kick this player')
      .addOptions(
        {
          label: 'Ban',
          description: 'Ban this player from the cluster',
          value: 'ban',
        },
        {
          label: 'Unban',
          description: 'Lift a ban and create an unban log',
          value: 'unban',
        },
        {
          label: 'Kick',
          description: 'Kick this player from the game server',
          value: 'kick',
        }
      )
  );
}

function profilePayload(profile, guildId) {
  return {
    embeds: [profileEmbed(profile, guildId)],
    components: [moderationMenu(profile.id)],
    ...EPHEMERAL,
  };
}

function resultsPicker(results) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('player:pick')
      .setPlaceholder('Select a player to view')
      .addOptions(
        results.slice(0, 25).map((p) => {
          const gt = p.gamertag || '';
          const ign =
            p.characterName &&
            (!gt || p.characterName.toLowerCase() !== gt.toLowerCase())
              ? p.characterName
              : '';
          const title = ign || gt || 'Unknown';
          return {
            label: `${p.online ? '🟢' : '⚫'} ${title}`.slice(0, 100),
            description: `${gt || '—'} · ${
              p.online ? p.map || 'Online' : 'Offline'
            }`.slice(0, 100),
            value: p.id,
          };
        })
      )
  );
}

function statusBit(profile) {
  if (profile.online) {
    return ` · 🟢 ${profile.map || 'Online'}`;
  }
  return ' · ⚫ Offline';
}

/**
 * Handler for standalone `/playersearch`.
 * Queries live Nitrado player lists, then shows DB results with fresh status.
 */
async function executeSearch(interaction) {
  const query = interaction.options.getString('query', true);
  const guildId = interaction.guildId;
  const guild = getGuild(guildId);

  await interaction.deferReply({ ...EPHEMERAL });

  let results;
  let liveCount = 0;
  try {
    const live = await searchPlayersLive(guildId, guild, query);
    results = live.results;
    liveCount = live.liveCount;
  } catch (error) {
    await interaction.editReply({
      embeds: [
        errorEmbed(
          `Live Nitrado lookup failed: ${error.message || error}\n` +
            'Falling back was skipped — fix Nitrado tokens/servers in `/management`.'
        ),
      ],
    });
    return;
  }

  if (!results.length) {
    await interaction.editReply({
      embeds: [
        errorEmbed(
          `No players matched \`${query}\`.\n` +
            `_Live scan: ${liveCount} online across cluster._`
        ),
      ],
    });
    return;
  }

  if (results.length === 1) {
    const payload = profilePayload(results[0], guildId);
    await interaction.editReply({
      embeds: payload.embeds,
      components: payload.components,
    });
    return;
  }

  const list = results
    .map((p, i) => {
      const punish = punishmentSummary(guildId, p);
      const punishBit = punish ? ` · ⚠ ${punish}` : '';
      const ign =
        p.characterName &&
        (!p.gamertag ||
          p.characterName.toLowerCase() !== p.gamertag.toLowerCase())
          ? p.characterName
          : '—';
      return `**${i + 1}.** ${ign} · \`${p.gamertag || '—'}\` · implant \`${
        p.specimenImplant || '—'
      }\` · ${p.tribeName || 'No tribe'}${statusBit(p)}${punishBit}`;
    })
    .join('\n');

  await interaction.editReply({
    embeds: [
      guildEmbed(getGuild(guildId), `Player search — ${results.length} result(s)`, {
        accent: true,
        context: 'Live + Player DB',
      }).setDescription(
        `${list.slice(0, 3800)}\n\n_Live scan: ${liveCount} online · select a player below._`
      ),
    ],
    components: [resultsPicker(results)],
  });
}

// Helper module only — slash command is `/playersearch` (see playersearch.js).
module.exports = {
  profilePayload,
  profileEmbed,
  moderationMenu,
  executeSearch,
};
