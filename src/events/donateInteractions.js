const {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  UserSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
} = require('discord.js');
const {
  getDonations,
  getDonationCurrency,
  listEnabledMethods,
  createDonation,
  updateDonation,
  markDonationReceived,
  markDonationDelivered,
  money,
} = require('../services/donations');
const {
  postDonationLog,
  refreshDonationLogMessage,
  buildDonationLogEmbed,
  donationLogComponents,
} = require('../services/donationLog');
const { canManageDonations } = require('../services/guildPermissions');
const { errorEmbed, guildEmbed } = require('../utils/embeds');
const { getGuild } = require('../services/storage');

/** userId -> draft while logging a received donation */
const logDrafts = new Map();

function draftKey(guildId, userId) {
  return `${guildId}:${userId}`;
}

function symbolFor(guildId) {
  return getDonationCurrency(guildId).currencySymbol;
}

async function handleDonateInteraction(interaction) {
  const id = interaction.customId;
  if (!id?.startsWith('donate:')) return false;

  const guildId = interaction.guildId;

  // Legacy "I've donated" button on older embeds
  if (
    (interaction.isButton() && id === 'donate:claim') ||
    (interaction.isStringSelectMenu() && id === 'donate:claim:method') ||
    (interaction.isModalSubmit() && id.startsWith('donate:claim:modal:'))
  ) {
    await interaction.reply({
      embeds: [
        guildEmbed(getGuild(guildId), 'Automatic PayPal confirm').setDescription(
          'This button is no longer used.\n' +
            'PayPal donations are confirmed automatically when money arrives on the main account.\n' +
            'Include your Discord username or ID in the PayPal note so staff can match your reward.'
        ),
      ],
      ephemeral: true,
    });
    return true;
  }

  // —— Link Discord donor on a PayPal log ——
  if (interaction.isButton() && id.startsWith('donate:link:')) {
    if (!canManageDonations(interaction)) {
      await interaction.reply({
        embeds: [errorEmbed('Only donation managers can link donors.')],
        ephemeral: true,
      });
      return true;
    }
    const donationId = id.slice('donate:link:'.length);
    await interaction.reply({
      embeds: [
        guildEmbed(getGuild(guildId), 'Link Discord donor').setDescription(
          'Select the Discord user this donation belongs to.'
        ),
      ],
      components: [
        new ActionRowBuilder().addComponents(
          new UserSelectMenuBuilder()
            .setCustomId(`donate:link-user:${donationId}`)
            .setPlaceholder('Select donor')
            .setMinValues(1)
            .setMaxValues(1)
        ),
      ],
      ephemeral: true,
    });
    return true;
  }

  if (interaction.isUserSelectMenu() && id.startsWith('donate:link-user:')) {
    if (!canManageDonations(interaction)) {
      await interaction.reply({
        embeds: [errorEmbed('Only donation managers can link donors.')],
        ephemeral: true,
      });
      return true;
    }
    const donationId = id.slice('donate:link-user:'.length);
    const donorId = interaction.values[0];
    const donor = await interaction.client.users.fetch(donorId).catch(() => null);
    const result = updateDonation(guildId, donationId, {
      donorId,
      donorTag: donor ? `${donor}` : `<@${donorId}>`,
    });
    if (!result.ok) {
      await interaction.update({
        embeds: [errorEmbed(result.error)],
        components: [],
      });
      return true;
    }
    await refreshDonationLogMessage(interaction.guild, result.record);
    await interaction.update({
      embeds: [
        guildEmbed(getGuild(guildId), 'Donor linked').setDescription(
          `Donation linked to <@${donorId}>.`
        ),
      ],
      components: [],
    });
    return true;
  }

  // —— Admins: log money received (manual / non-API) ——
  if (interaction.isButton() && id === 'donate:log-received') {
    if (!canManageDonations(interaction)) {
      await interaction.reply({
        embeds: [
          errorEmbed(
            'Only **admin roles** with Donations access can log money received.\n' +
              'Ask the server owner to grant your role with `/permissions set` → **Donations**.'
          ),
        ],
        ephemeral: true,
      });
      return true;
    }

    const methods = listEnabledMethods(getDonations(guildId));
    if (!methods.length) {
      await interaction.reply({
        embeds: [errorEmbed('No donation methods configured.')],
        ephemeral: true,
      });
      return true;
    }

    await interaction.reply({
      embeds: [
        guildEmbed(getGuild(guildId), 'Log money received').setDescription(
          'Select the donor, then the method and amount.\nThis **auto-confirms** the donation and writes a donation log.'
        ),
      ],
      components: [
        new ActionRowBuilder().addComponents(
          new UserSelectMenuBuilder()
            .setCustomId('donate:log:donor')
            .setPlaceholder('Select donor')
            .setMinValues(1)
            .setMaxValues(1)
        ),
      ],
      ephemeral: true,
    });
    return true;
  }

  if (interaction.isUserSelectMenu() && id === 'donate:log:donor') {
    if (!canManageDonations(interaction)) {
      await interaction.reply({
        embeds: [
          errorEmbed(
            'Only **admin roles** with Donations access can do this.\n' +
              'Ask the server owner to grant your role with `/permissions set` → **Donations**.'
          ),
        ],
        ephemeral: true,
      });
      return true;
    }

    const donorId = interaction.values[0];
    logDrafts.set(draftKey(guildId, interaction.user.id), { donorId });

    const methods = listEnabledMethods(getDonations(guildId));
    await interaction.update({
      embeds: [
        guildEmbed(getGuild(guildId), 'Log money received').setDescription(
          `Donor: <@${donorId}>\nSelect the donation method.`
        ),
      ],
      components: [
        new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId('donate:log:method')
            .setPlaceholder('Select method')
            .addOptions(
              methods.slice(0, 25).map((m) => ({
                label: m.label.slice(0, 100),
                description: (m.description || 'Donation').slice(0, 100),
                value: m.id,
              }))
            )
        ),
      ],
    });
    return true;
  }

  if (interaction.isStringSelectMenu() && id === 'donate:log:method') {
    if (!canManageDonations(interaction)) {
      await interaction.reply({
        embeds: [
          errorEmbed(
            'Only **admin roles** with Donations access can do this.\n' +
              'Ask the server owner to grant your role with `/permissions set` → **Donations**.'
          ),
        ],
        ephemeral: true,
      });
      return true;
    }

    const draft = logDrafts.get(draftKey(guildId, interaction.user.id));
    if (!draft?.donorId) {
      await interaction.reply({
        embeds: [errorEmbed('Start again with **Log money received**.')],
        ephemeral: true,
      });
      return true;
    }

    const methodId = interaction.values[0];
    draft.methodId = methodId;
    logDrafts.set(draftKey(guildId, interaction.user.id), draft);

    const modal = new ModalBuilder()
      .setCustomId(`donate:log:modal:${methodId}`)
      .setTitle('Received donation details')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('amount')
            .setLabel(`Amount received (${symbolFor(guildId)})`)
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(12)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('note')
            .setLabel('Optional note')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(false)
            .setMaxLength(200)
        )
      );
    await interaction.showModal(modal);
    return true;
  }

  if (interaction.isModalSubmit() && id.startsWith('donate:log:modal:')) {
    if (!canManageDonations(interaction)) {
      await interaction.reply({
        embeds: [
          errorEmbed(
            'Only **admin roles** with Donations access can do this.\n' +
              'Ask the server owner to grant your role with `/permissions set` → **Donations**.'
          ),
        ],
        ephemeral: true,
      });
      return true;
    }

    const methodId = id.slice('donate:log:modal:'.length);
    const draft = logDrafts.get(draftKey(guildId, interaction.user.id));
    if (!draft?.donorId) {
      await interaction.reply({
        embeds: [errorEmbed('Start again with **Log money received**.')],
        ephemeral: true,
      });
      return true;
    }

    const donor = await interaction.client.users.fetch(draft.donorId).catch(() => null);
    const result = createDonation(guildId, {
      donorId: draft.donorId,
      donorTag: donor ? `${donor}` : `<@${draft.donorId}>`,
      methodId,
      amount: interaction.fields.getTextInputValue('amount'),
      note: interaction.fields.getTextInputValue('note'),
      byId: interaction.user.id,
      byTag: `${interaction.user}`,
      alreadyReceived: true,
    });
    logDrafts.delete(draftKey(guildId, interaction.user.id));

    if (!result.ok) {
      await interaction.reply({
        embeds: [errorEmbed(result.error)],
        ephemeral: true,
      });
      return true;
    }

    const posted = await postDonationLog(interaction.guild, result.record);
    await interaction.reply({
      embeds: [
        guildEmbed(getGuild(guildId), 'Donation received · confirmed').setDescription(
          [
            `**${money(result.record.amount, symbolFor(guildId))}** from <@${result.record.donorId}> via **${result.record.methodLabel}**.`,
            'Auto-confirmed as received.',
            posted.ok
              ? 'Logged in **donation-logs**. Use **Mark as Delivered** when the reward is given.'
              : 'Saved, but the log forum could not be updated.',
          ].join('\n')
        ),
      ],
      ephemeral: true,
    });
    return true;
  }

  // —— Log thread buttons: received / delivered ——
  if (
    interaction.isButton() &&
    (id.startsWith('donate:received:') || id.startsWith('donate:delivered:'))
  ) {
    if (!canManageDonations(interaction)) {
      await interaction.reply({
        embeds: [
          errorEmbed('Only donation managers can update donation status.'),
        ],
        ephemeral: true,
      });
      return true;
    }

    const [, action, donationId] = id.split(':');
    let result;
    if (action === 'received') {
      result = markDonationReceived(guildId, donationId, {
        byId: interaction.user.id,
        byTag: `${interaction.user}`,
      });
    } else {
      result = markDonationDelivered(guildId, donationId, {
        byId: interaction.user.id,
        byTag: `${interaction.user}`,
      });
    }

    if (!result.ok) {
      await interaction.reply({
        embeds: [errorEmbed(result.error)],
        ephemeral: true,
      });
      return true;
    }

    const onLogMessage =
      interaction.message &&
      !interaction.message.flags?.has?.(MessageFlags.Ephemeral);

    if (onLogMessage) {
      await interaction.update({
        embeds: [buildDonationLogEmbed(result.record, getGuild(guildId))],
        components: donationLogComponents(result.record),
      });
      return true;
    }

    await refreshDonationLogMessage(interaction.guild, result.record);
    await interaction.reply({
      embeds: [
        guildEmbed(
          getGuild(guildId),
          action === 'received'
            ? 'Donation received · confirmed'
            : 'Donation marked delivered'
        ).setDescription(
          action === 'received'
            ? `**${money(result.record.amount, symbolFor(guildId))}** from <@${result.record.donorId}> is confirmed received.`
            : `Reward for <@${result.record.donorId}> marked as delivered.`
        ),
      ],
      ephemeral: true,
    });
    return true;
  }

  return false;
}

module.exports = { handleDonateInteraction };
