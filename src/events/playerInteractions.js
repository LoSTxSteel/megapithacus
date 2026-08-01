const {
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  PermissionFlagsBits,
} = require('discord.js');
const { getPlayerById } = require('../services/playerDb');
const { moderatePlayer } = require('../services/playerModeration');
const { profilePayload, moderationMenu, profileEmbed } = require('../commands/player');
const {
  getDraft,
  setDraft,
  clearDraft,
  durationReady,
  reasonReady,
  banWizardPayload,
  unbanWizardPayload,
} = require('../services/banWizard');
const {
  reasonLabel,
  unbanReasonLabel,
  parseCustomDuration,
  findActiveBanForPlayer,
} = require('../services/banStore');
const { errorEmbed, successEmbed } = require('../utils/embeds');
const { buildBanLogEmbed, buildUnbanLogEmbed } = require('../services/banLog');

function canModerate(interaction) {
  return interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
}

function customDurationModal(profileId) {
  return new ModalBuilder()
    .setCustomId(`player:modal:banduration:${profileId}`)
    .setTitle('Custom ban duration')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('duration')
          .setLabel('Duration (e.g. 45m, 12h, 2d, 1w)')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(32)
          .setPlaceholder('2d')
      )
    );
}

function customReasonModal(profileId, kind) {
  const isUnban = kind === 'unban';
  return new ModalBuilder()
    .setCustomId(
      isUnban
        ? `player:modal:unbanreason:${profileId}`
        : `player:modal:banreason:${profileId}`
    )
    .setTitle(isUnban ? 'Custom unban reason' : 'Custom ban reason')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('reason')
          .setLabel('Custom reason')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(500)
      )
    );
}

async function handlePlayerInteraction(interaction) {
  const id = interaction.customId;
  if (!id?.startsWith('player:')) return false;

  if (!canModerate(interaction)) {
    const payload = {
      embeds: [errorEmbed('You need **Manage Server** to moderate players.')],
      ephemeral: true,
    };
    if (interaction.replied || interaction.deferred) await interaction.followUp(payload);
    else await interaction.reply(payload);
    return true;
  }

  // Pick from search results
  if (interaction.isStringSelectMenu() && id === 'player:pick') {
    const profileId = interaction.values[0];
    const profile = getPlayerById(interaction.guildId, profileId);
    if (!profile) {
      await interaction.update({
        embeds: [errorEmbed('That player profile no longer exists.')],
        components: [],
      });
      return true;
    }
    await interaction.update(profilePayload(profile));
    return true;
  }

  // Ban / Unban / Kick dropdown on profile
  if (interaction.isStringSelectMenu() && id.startsWith('player:mod:')) {
    const profileId = id.slice('player:mod:'.length);
    const action = interaction.values[0];
    const profile = getPlayerById(interaction.guildId, profileId);
    if (!profile) {
      await interaction.reply({
        embeds: [errorEmbed('That player profile no longer exists.')],
        ephemeral: true,
      });
      return true;
    }

    if (action === 'ban') {
      const draft = setDraft(interaction.guildId, interaction.user.id, profileId, {
        duration: null,
        reason: null,
        reasonText: null,
        customDurationMs: null,
        customDurationLabel: null,
      });
      await interaction.update(banWizardPayload(profile, draft));
      return true;
    }

    if (action === 'unban') {
      const activeBan = findActiveBanForPlayer(interaction.guildId, profile);
      const draft = setDraft(
        interaction.guildId,
        interaction.user.id,
        profileId,
        { reason: null, reasonText: null },
        'unban'
      );
      await interaction.update(unbanWizardPayload(profile, activeBan, draft));
      return true;
    }

    if (action === 'kick') {
      const modal = new ModalBuilder()
        .setCustomId(`player:modal:kick:${profileId}`)
        .setTitle('Kick player')
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('reason')
              .setLabel('Reason')
              .setStyle(TextInputStyle.Paragraph)
              .setRequired(true)
              .setMaxLength(500)
          )
        );
      await interaction.showModal(modal);
      return true;
    }
  }

  // Ban wizard — duration
  if (interaction.isStringSelectMenu() && id.startsWith('player:ban:duration:')) {
    const profileId = id.slice('player:ban:duration:'.length);
    const profile = getPlayerById(interaction.guildId, profileId);
    if (!profile) {
      await interaction.update({
        embeds: [errorEmbed('That player profile no longer exists.')],
        components: [],
      });
      return true;
    }

    const durationValue = interaction.values[0];
    if (durationValue === 'custom') {
      setDraft(interaction.guildId, interaction.user.id, profileId, {
        duration: 'custom',
        customDurationMs: null,
        customDurationLabel: null,
      });
      await interaction.showModal(customDurationModal(profileId));
      return true;
    }

    const draft = setDraft(interaction.guildId, interaction.user.id, profileId, {
      duration: durationValue,
      customDurationMs: null,
      customDurationLabel: null,
    });
    await interaction.update(banWizardPayload(profile, draft));
    return true;
  }

  // Ban wizard — reason
  if (interaction.isStringSelectMenu() && id.startsWith('player:ban:reason:')) {
    const profileId = id.slice('player:ban:reason:'.length);
    const profile = getPlayerById(interaction.guildId, profileId);
    if (!profile) {
      await interaction.update({
        embeds: [errorEmbed('That player profile no longer exists.')],
        components: [],
      });
      return true;
    }

    const reasonValue = interaction.values[0];
    if (reasonValue === 'other') {
      setDraft(interaction.guildId, interaction.user.id, profileId, {
        reason: 'other',
        reasonText: null,
      });
      await interaction.showModal(customReasonModal(profileId, 'ban'));
      return true;
    }

    const draft = setDraft(interaction.guildId, interaction.user.id, profileId, {
      reason: reasonValue,
      reasonText: reasonLabel(reasonValue),
    });
    await interaction.update(banWizardPayload(profile, draft));
    return true;
  }

  // Ban wizard — cancel
  if (interaction.isButton() && id.startsWith('player:ban:cancel:')) {
    const profileId = id.slice('player:ban:cancel:'.length);
    clearDraft(interaction.guildId, interaction.user.id, profileId);
    const profile = getPlayerById(interaction.guildId, profileId);
    if (!profile) {
      await interaction.update({
        embeds: [errorEmbed('Cancelled. Profile no longer exists.')],
        components: [],
      });
      return true;
    }
    await interaction.update(profilePayload(profile));
    return true;
  }

  // Ban wizard — confirm
  if (interaction.isButton() && id.startsWith('player:ban:confirm:')) {
    const profileId = id.slice('player:ban:confirm:'.length);
    const draft = getDraft(interaction.guildId, interaction.user.id, profileId);
    const profile = getPlayerById(interaction.guildId, profileId);

    if (!profile) {
      await interaction.update({
        embeds: [errorEmbed('That player profile no longer exists.')],
        components: [],
      });
      return true;
    }

    if (!durationReady(draft) || !reasonReady(draft)) {
      await interaction.update({
        ...banWizardPayload(profile, draft),
        content: 'Select both a **duration** and a **reason** first.',
      });
      return true;
    }

    await interaction.deferUpdate();

    const result = await moderatePlayer(interaction.guild, {
      profileId,
      action: 'ban',
      moderator: interaction.user,
      reason: draft.reasonText,
      durationValue: draft.duration,
      durationMs: draft.customDurationMs,
      durationLabel: draft.customDurationLabel,
    });

    clearDraft(interaction.guildId, interaction.user.id, profileId);

    if (!result.ok) {
      await interaction.editReply({
        content: null,
        embeds: [errorEmbed(result.error)],
        components: [],
      });
      return true;
    }

    const embeds = [
      successEmbed('Ban issued', result.message),
      result.banLog?.embed || buildBanLogEmbed(result.ban),
    ];
    const updated = getPlayerById(interaction.guildId, profileId);
    if (updated) embeds.push(profileEmbed(updated));

    await interaction.editReply({
      content: null,
      embeds,
      components: updated ? [moderationMenu(updated.id)] : [],
    });
    return true;
  }

  // Unban wizard — reason
  if (interaction.isStringSelectMenu() && id.startsWith('player:unban:reason:')) {
    const profileId = id.slice('player:unban:reason:'.length);
    const profile = getPlayerById(interaction.guildId, profileId);
    if (!profile) {
      await interaction.update({
        embeds: [errorEmbed('That player profile no longer exists.')],
        components: [],
      });
      return true;
    }

    const reasonValue = interaction.values[0];
    const activeBan = findActiveBanForPlayer(interaction.guildId, profile);

    if (reasonValue === 'other') {
      setDraft(
        interaction.guildId,
        interaction.user.id,
        profileId,
        { reason: 'other', reasonText: null },
        'unban'
      );
      await interaction.showModal(customReasonModal(profileId, 'unban'));
      return true;
    }

    const draft = setDraft(
      interaction.guildId,
      interaction.user.id,
      profileId,
      { reason: reasonValue, reasonText: unbanReasonLabel(reasonValue) },
      'unban'
    );
    await interaction.update(unbanWizardPayload(profile, activeBan, draft));
    return true;
  }

  // Unban wizard — cancel
  if (interaction.isButton() && id.startsWith('player:unban:cancel:')) {
    const profileId = id.slice('player:unban:cancel:'.length);
    clearDraft(interaction.guildId, interaction.user.id, profileId, 'unban');
    const profile = getPlayerById(interaction.guildId, profileId);
    if (!profile) {
      await interaction.update({
        embeds: [errorEmbed('Cancelled. Profile no longer exists.')],
        components: [],
      });
      return true;
    }
    await interaction.update(profilePayload(profile));
    return true;
  }

  // Unban wizard — confirm
  if (interaction.isButton() && id.startsWith('player:unban:confirm:')) {
    const profileId = id.slice('player:unban:confirm:'.length);
    const draft = getDraft(interaction.guildId, interaction.user.id, profileId, 'unban');
    const profile = getPlayerById(interaction.guildId, profileId);
    const activeBan = profile
      ? findActiveBanForPlayer(interaction.guildId, profile)
      : null;

    if (!profile) {
      await interaction.update({
        embeds: [errorEmbed('That player profile no longer exists.')],
        components: [],
      });
      return true;
    }

    if (!reasonReady(draft)) {
      await interaction.update({
        ...unbanWizardPayload(profile, activeBan, draft),
        content: 'Select an **unban reason** first.',
      });
      return true;
    }

    await interaction.deferUpdate();

    const result = await moderatePlayer(interaction.guild, {
      profileId,
      action: 'unban',
      moderator: interaction.user,
      reason: draft.reasonText,
    });

    clearDraft(interaction.guildId, interaction.user.id, profileId, 'unban');

    if (!result.ok) {
      await interaction.editReply({
        content: null,
        embeds: [errorEmbed(result.error)],
        components: [],
      });
      return true;
    }

    const embeds = [
      successEmbed('Unban recorded', result.message),
      result.unbanLog?.embed || buildUnbanLogEmbed(result.ban, { reason: draft.reasonText }),
    ];
    const updated = getPlayerById(interaction.guildId, profileId);
    if (updated) embeds.push(profileEmbed(updated));

    await interaction.editReply({
      content: null,
      embeds,
      components: updated ? [moderationMenu(updated.id)] : [],
    });
    return true;
  }

  // Custom ban duration modal
  if (interaction.isModalSubmit() && id.startsWith('player:modal:banduration:')) {
    const profileId = id.slice('player:modal:banduration:'.length);
    const raw = interaction.fields.getTextInputValue('duration').trim();
    const parsed = parseCustomDuration(raw);
    const profile = getPlayerById(interaction.guildId, profileId);

    if (!profile) {
      await interaction.reply({
        embeds: [errorEmbed('That player profile no longer exists.')],
        ephemeral: true,
      });
      return true;
    }

    if (!parsed) {
      await interaction.reply({
        embeds: [
          errorEmbed(
            'Invalid duration. Use formats like `45m`, `12h`, `2d`, or `1w` (max 365 days).'
          ),
        ],
        ephemeral: true,
      });
      return true;
    }

    const draft = setDraft(interaction.guildId, interaction.user.id, profileId, {
      duration: 'custom',
      customDurationMs: parsed.ms,
      customDurationLabel: parsed.label,
    });

    await interaction.reply({
      content: `Custom duration set to **${parsed.label}**. Confirm the ban below.`,
      ...banWizardPayload(profile, draft),
      ephemeral: true,
    });
    return true;
  }

  // Custom ban reason modal
  if (interaction.isModalSubmit() && id.startsWith('player:modal:banreason:')) {
    const profileId = id.slice('player:modal:banreason:'.length);
    const reasonText = interaction.fields.getTextInputValue('reason').trim();
    const profile = getPlayerById(interaction.guildId, profileId);
    if (!profile) {
      await interaction.reply({
        embeds: [errorEmbed('That player profile no longer exists.')],
        ephemeral: true,
      });
      return true;
    }

    const draft = setDraft(interaction.guildId, interaction.user.id, profileId, {
      reason: 'other',
      reasonText,
    });

    await interaction.reply({
      content: 'Custom reason saved. Confirm the ban below.',
      ...banWizardPayload(profile, draft),
      ephemeral: true,
    });
    return true;
  }

  // Custom unban reason modal
  if (interaction.isModalSubmit() && id.startsWith('player:modal:unbanreason:')) {
    const profileId = id.slice('player:modal:unbanreason:'.length);
    const reasonText = interaction.fields.getTextInputValue('reason').trim();
    const profile = getPlayerById(interaction.guildId, profileId);
    if (!profile) {
      await interaction.reply({
        embeds: [errorEmbed('That player profile no longer exists.')],
        ephemeral: true,
      });
      return true;
    }

    const activeBan = findActiveBanForPlayer(interaction.guildId, profile);
    const draft = setDraft(
      interaction.guildId,
      interaction.user.id,
      profileId,
      { reason: 'other', reasonText },
      'unban'
    );

    await interaction.reply({
      content: 'Custom reason saved. Confirm the unban below.',
      ...unbanWizardPayload(profile, activeBan, draft),
      ephemeral: true,
    });
    return true;
  }

  // Kick modal submit
  if (interaction.isModalSubmit() && id.startsWith('player:modal:kick:')) {
    const profileId = id.slice('player:modal:kick:'.length);
    const reason = interaction.fields.getTextInputValue('reason').trim();

    await interaction.deferReply({ ephemeral: true });

    const result = await moderatePlayer(interaction.guild, {
      profileId,
      action: 'kick',
      moderator: interaction.user,
      reason,
    });

    if (!result.ok) {
      await interaction.editReply({ embeds: [errorEmbed(result.error)] });
      return true;
    }

    const profile = getPlayerById(interaction.guildId, profileId);
    await interaction.editReply({
      embeds: [
        successEmbed('Player kicked', result.message),
        ...(profile ? [profileEmbed(profile)] : []),
      ],
      components: profile ? [moderationMenu(profile.id)] : [],
    });
    return true;
  }

  return false;
}

module.exports = { handlePlayerInteraction };
