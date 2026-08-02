const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} = require('discord.js');
const {
  getDonations,
  listEnabledMethods,
  methodSummaryLines,
  paypalConfiguredSummary,
  stripeConfiguredSummary,
} = require('../services/donations');
const { ensureDonationLogForum } = require('../services/donationLog');
const { canManageDonations } = require('../services/guildPermissions');
const { errorEmbed, successEmbed, brandEmbed } = require('../utils/embeds');
const { getGuild } = require('../services/storage');

function donateBoardPayload(guildId) {
  const guild = getGuild(guildId);
  const donations = getDonations(guildId);
  const methods = listEnabledMethods(donations);
  const paypalOn = donations.paypal?.enabled;
  const stripeOn = donations.stripe?.enabled;
  const autoBits = [];
  if (paypalOn) autoBits.push('PayPal');
  if (stripeOn) autoBits.push('Stripe');

  const embed = brandEmbed(
    new EmbedBuilder()
      .setTitle('Support the cluster')
      .setDescription(
        [
          'Pick a method below to donate.',
          autoBits.length
            ? `${autoBits.join(' and ')} payments are detected automatically when money arrives.`
            : 'Staff confirm donations when money is received.',
          '',
          'Include your **Discord username or ID** in the payment note / Stripe metadata (`discord_id`) so we can match your reward.',
          '',
          '**Methods**',
          ...methodSummaryLines(donations),
        ].join('\n')
      ),
    guild,
    { context: 'Donations' }
  );

  const components = [];

  const linkButtons = methods.slice(0, 25).map((m) =>
    new ButtonBuilder()
      .setStyle(ButtonStyle.Link)
      .setLabel(m.label.slice(0, 80))
      .setURL(m.link)
  );
  for (let i = 0; i < linkButtons.length; i += 5) {
    components.push(
      new ActionRowBuilder().addComponents(...linkButtons.slice(i, i + 5))
    );
  }

  return { embeds: [embed], components };
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('donate')
    .setDescription('Post the public donation embed with payment methods')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  donateBoardPayload,

  async execute(interaction) {
    if (!canManageDonations(interaction)) {
      await interaction.reply({
        embeds: [
          errorEmbed(
            'You do not have permission to post the donation board.\n' +
              'Ask the server owner to grant your role with `/permissions set` → **Donations**.'
          ),
        ],
        ephemeral: true,
      });
      return;
    }

    const methods = listEnabledMethods(getDonations(interaction.guildId));
    if (!methods.length) {
      await interaction.reply({
        embeds: [
          errorEmbed(
            'No donation methods configured.\nAdd some with `/donatemanage` first.'
          ),
        ],
        ephemeral: true,
      });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      await ensureDonationLogForum(interaction.guild);
    } catch (error) {
      await interaction.editReply({
        embeds: [
          errorEmbed(
            `Could not create the donation-logs forum: ${error.message}\n` +
              'Give the bot **Manage Channels**, then try again.'
          ),
        ],
      });
      return;
    }

    await interaction.channel.send(donateBoardPayload(interaction.guildId));
    await interaction.editReply({
      embeds: [
        successEmbed(
          'Donation board posted',
          [
            paypalConfiguredSummary(interaction.guildId),
            stripeConfiguredSummary(interaction.guildId),
            'Matching payments are auto-confirmed and logged.',
            'Manual **Log money received** is in `/donatemanage` (admin roles only).',
            'Staff use **Mark as Delivered** in donation-logs when the reward is given.',
          ].join('\n')
        ),
      ],
    });
  },
};
