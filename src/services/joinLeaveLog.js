const { EmbedBuilder } = require('discord.js');
const { getGuild } = require('./storage');
const {
  isFeatureEnabled,
  isFeatureConfigured,
  getMapFeatureThread,
} = require('./featureSetup');
const { brandEmbed } = require('../utils/embeds');

function playerLabel(profile) {
  const ign = profile.characterName || profile.gamertag || 'Unknown';
  const tag = profile.gamertag && profile.gamertag !== ign ? ` (\`${profile.gamertag}\`)` : '';
  return `**${ign}**${tag}`;
}

function buildJoinEmbed(guild, profile, mapName) {
  return brandEmbed(
    new EmbedBuilder()
      .setTitle('Player joined')
      .setDescription(`${playerLabel(profile)} joined **${mapName}**.`)
      .addFields(
        { name: 'Gamertag', value: profile.gamertag || '—', inline: true },
        { name: 'In-game name', value: profile.characterName || '—', inline: true },
        {
          name: 'Specimen Implant',
          value: profile.specimenImplant ? `\`${profile.specimenImplant}\`` : '—',
          inline: true,
        },
        { name: 'Tribe', value: profile.tribeName || '—', inline: true },
        { name: 'Map', value: mapName || '—', inline: true }
      ),
    guild,
    { context: 'Join / Leave' }
  );
}

function buildLeaveEmbed(guild, profile, mapName) {
  return brandEmbed(
    new EmbedBuilder()
      .setTitle('Player left')
      .setDescription(`${playerLabel(profile)} left **${mapName}**.`)
      .addFields(
        { name: 'Gamertag', value: profile.gamertag || '—', inline: true },
        { name: 'In-game name', value: profile.characterName || '—', inline: true },
        {
          name: 'Specimen Implant',
          value: profile.specimenImplant ? `\`${profile.specimenImplant}\`` : '—',
          inline: true,
        },
        { name: 'Tribe', value: profile.tribeName || '—', inline: true },
        { name: 'Map', value: mapName || '—', inline: true }
      ),
    guild,
    { context: 'Join / Leave' }
  );
}

async function postJoinLeave(discordGuild, guildId, serviceId, { type, profile, mapName }) {
  const guild = getGuild(guildId);
  if (!isFeatureEnabled(guild, 'joinLeaveLogs') || !isFeatureConfigured(guild, 'joinLeaveLogs')) {
    return { ok: false, reason: 'disabled' };
  }

  const entry = getMapFeatureThread(guild, serviceId, 'joinLeaveLogs');
  if (!entry?.threadId) return { ok: false, reason: 'no_thread' };

  const thread = await discordGuild.channels.fetch(entry.threadId).catch(() => null);
  if (!thread) return { ok: false, reason: 'missing_thread' };

  const embed =
    type === 'leave'
      ? buildLeaveEmbed(guild, profile, mapName)
      : buildJoinEmbed(guild, profile, mapName);

  await thread.send({ embeds: [embed] });
  return { ok: true };
}

module.exports = {
  postJoinLeave,
  buildJoinEmbed,
  buildLeaveEmbed,
};
