const {
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const {
  DURATIONS,
  REASONS,
  UNBAN_REASONS,
  durationMeta,
  reasonLabel,
  unbanReasonLabel,
} = require('./banStore');
const { brandEmbed } = require('../utils/embeds');

/** In-memory draft state: key = guildId:userId:profileId:kind */
const drafts = new Map();

function draftKey(guildId, userId, profileId, kind = 'ban') {
  return `${kind}:${guildId}:${userId}:${profileId}`;
}

function getDraft(guildId, userId, profileId, kind = 'ban') {
  return drafts.get(draftKey(guildId, userId, profileId, kind)) || null;
}

function setDraft(guildId, userId, profileId, patch, kind = 'ban') {
  const key = draftKey(guildId, userId, profileId, kind);
  const current =
    drafts.get(key) ||
    (kind === 'unban'
      ? { profileId, reason: null, reasonText: null }
      : {
          profileId,
          duration: null,
          reason: null,
          reasonText: null,
          customDurationMs: null,
          customDurationLabel: null,
        });
  const next = { ...current, ...patch, profileId };
  drafts.set(key, next);
  return next;
}

function clearDraft(guildId, userId, profileId, kind = 'ban') {
  drafts.delete(draftKey(guildId, userId, profileId, kind));
}

function durationReady(draft) {
  if (!draft?.duration) return false;
  if (draft.duration === 'custom') return Boolean(draft.customDurationMs);
  return true;
}

function reasonReady(draft) {
  return Boolean(draft?.reasonText);
}

function banDurationText(draft) {
  if (!draft?.duration) return '_Not selected_';
  if (draft.duration === 'custom') {
    return draft.customDurationLabel || '_Enter custom duration_';
  }
  return durationMeta(draft.duration)?.label || draft.duration;
}

function banWizardEmbed(profile, draft) {
  const target = profile.gamertag || profile.characterName || 'Unknown';
  const reasonText = draft?.reasonText
    ? draft.reasonText
    : draft?.reason
      ? reasonLabel(draft.reason)
      : '_Not selected_';

  return brandEmbed(
    new EmbedBuilder()
      .setTitle('Issue ban')
      .setDescription(
        `Configure the ban for **${target}**, then press **Confirm ban**.\nBoth **duration** and **reason** are required.`
      )
      .addFields(
        { name: 'Player', value: `\`${target}\``, inline: true },
        { name: 'In-game name', value: profile.characterName || '—', inline: true },
        { name: 'Map', value: profile.map || '—', inline: true },
        { name: 'Duration', value: banDurationText(draft), inline: true },
        { name: 'Reason', value: reasonText, inline: true }
      ),
    null,
    { color: 0xe74c3c, context: 'Ban wizard' }
  );
}

function banWizardComponents(profileId, draft) {
  const ready = durationReady(draft) && reasonReady(draft);

  const durationRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`player:ban:duration:${profileId}`)
      .setPlaceholder('Select ban duration')
      .addOptions(
        DURATIONS.map((d) => ({
          label: d.label,
          value: d.value,
          default: draft?.duration === d.value,
        }))
      )
  );

  const reasonRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`player:ban:reason:${profileId}`)
      .setPlaceholder('Select ban reason')
      .addOptions(
        REASONS.map((r) => ({
          label: r.label,
          value: r.value,
          default: draft?.reason === r.value,
        }))
      )
  );

  const buttonRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`player:ban:confirm:${profileId}`)
      .setLabel('Confirm ban')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(!ready),
    new ButtonBuilder()
      .setCustomId(`player:ban:cancel:${profileId}`)
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary)
  );

  return [durationRow, reasonRow, buttonRow];
}

function banWizardPayload(profile, draft) {
  return {
    embeds: [banWizardEmbed(profile, draft)],
    components: banWizardComponents(profile.id, draft),
  };
}

function unbanWizardEmbed(profile, activeBan, draft) {
  const target = profile.gamertag || profile.characterName || 'Unknown';
  const reasonText = draft?.reasonText
    ? draft.reasonText
    : draft?.reason
      ? unbanReasonLabel(draft.reason)
      : '_Not selected_';

  const endsValue = activeBan?.endsAt
    ? `<t:${Math.floor(new Date(activeBan.endsAt).getTime() / 1000)}:R>`
    : activeBan
      ? 'Permanent / unknown'
      : '—';

  return brandEmbed(
    new EmbedBuilder()
      .setTitle('Issue unban')
      .setDescription(
        `Configure the unban for **${target}**, then press **Confirm unban**.\nA **reason** is required.`
      )
      .addFields(
        { name: 'Player', value: `\`${target}\``, inline: true },
        { name: 'In-game name', value: profile.characterName || '—', inline: true },
        {
          name: 'Active ban',
          value: activeBan
            ? `${activeBan.duration || 'Unknown'} · ${activeBan.reason || 'No reason'}`
            : '_No active ban in bot records — unban log will still be created._',
        },
        { name: 'Ban ends', value: endsValue, inline: true },
        { name: 'Unban reason', value: reasonText, inline: true }
      ),
    null,
    { color: 0x2ecc71, context: 'Unban wizard' }
  );
}

function unbanWizardComponents(profileId, draft) {
  const ready = reasonReady(draft);

  const reasonRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`player:unban:reason:${profileId}`)
      .setPlaceholder('Select unban reason')
      .addOptions(
        UNBAN_REASONS.map((r) => ({
          label: r.label,
          value: r.value,
          default: draft?.reason === r.value,
        }))
      )
  );

  const buttonRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`player:unban:confirm:${profileId}`)
      .setLabel('Confirm unban')
      .setStyle(ButtonStyle.Success)
      .setDisabled(!ready),
    new ButtonBuilder()
      .setCustomId(`player:unban:cancel:${profileId}`)
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary)
  );

  return [reasonRow, buttonRow];
}

function unbanWizardPayload(profile, activeBan, draft) {
  return {
    embeds: [unbanWizardEmbed(profile, activeBan, draft)],
    components: unbanWizardComponents(profile.id, draft),
  };
}

module.exports = {
  getDraft,
  setDraft,
  clearDraft,
  durationReady,
  reasonReady,
  banWizardPayload,
  banWizardEmbed,
  banWizardComponents,
  unbanWizardPayload,
  unbanWizardEmbed,
  unbanWizardComponents,
};
