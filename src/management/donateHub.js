const {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const {
  getDonations,
  methodSummaryLines,
  listMethods,
  addMethod,
  updateMethod,
  removeMethod,
  getMethod,
  getPayPalConfig,
  updatePayPalConfig,
  paypalConfiguredSummary,
  getStripeConfig,
  updateStripeConfig,
  stripeConfiguredSummary,
} = require('../services/donations');
const { ensureDonationLogForum } = require('../services/donationLog');
const { testPayPalConnection } = require('../services/paypal');
const { syncGuildPayPal } = require('../services/paypalDonations');
const { testStripeConnection } = require('../services/stripe');
const { syncGuildStripe } = require('../services/stripeDonations');
const { canManageDonations } = require('../services/guildPermissions');
const { guildEmbed, errorEmbed } = require('../utils/embeds');
const { getGuild } = require('../services/storage');

function denyDonate(interaction) {
  const payload = {
    embeds: [
      errorEmbed(
        'You do not have permission to manage **Donations**.\n' +
          'Ask the server owner to grant your role with `/permissions set` → **Donations**.'
      ),
    ],
    ephemeral: true,
  };
  if (interaction.replied || interaction.deferred) {
    return interaction.followUp(payload);
  }
  return interaction.reply(payload);
}

function backDonate() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('donatehub:back')
      .setLabel('Back')
      .setStyle(ButtonStyle.Secondary)
  );
}

function buildDonateManagePanel(guildId) {
  const donations = getDonations(guildId);
  const guild = getGuild(guildId);
  const paypal = getPayPalConfig(guildId);
  const stripe = getStripeConfig(guildId);

  return {
    embeds: [
      guildEmbed(guild, 'Donation Manager').setDescription(
        [
          'Configure donation methods and links shown on `/donate`.',
          'PayPal and Stripe payments on the receiving accounts are detected via API and **auto-confirmed**.',
          'Use **Log money received** below for manual / non-API payments (admin roles only).',
          'Use **Mark as Delivered** on the log when the reward has been given.',
          '',
          paypalConfiguredSummary(guildId),
          paypal.clientId
            ? `PayPal Client ID: \`${paypal.clientId.slice(0, 8)}…\``
            : process.env.PAYPAL_CLIENT_ID
              ? 'PayPal: using Client ID from `.env`'
              : 'PayPal: no Client ID set',
          stripeConfiguredSummary(guildId),
          stripe.secretKey
            ? `Stripe key: \`${stripe.secretKey.slice(0, 10)}…\``
            : process.env.STRIPE_SECRET_KEY
              ? 'Stripe: using secret key from `.env`'
              : 'Stripe: no secret key set',
          '',
          '**Methods**',
          ...methodSummaryLines(donations),
        ].join('\n')
      ),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('donatehub:action')
          .setPlaceholder('Manage donations')
          .addOptions(
            {
              label: 'Add donation method',
              description: 'Name + donation link',
              value: 'add',
            },
            {
              label: 'Edit donation method',
              description: 'Change name, link, or description',
              value: 'edit',
            },
            {
              label: 'Remove donation method',
              description: 'Remove a method from /donate',
              value: 'remove',
            },
            {
              label: 'Configure PayPal',
              description: 'API credentials for the main receiving account',
              value: 'paypal',
            },
            {
              label: 'Configure Stripe',
              description: 'Secret key for the Stripe receiving account',
              value: 'stripe',
            },
            {
              label: 'Setup donation logs forum',
              description: 'Create the donation-logs forum',
              value: 'setup-logs',
            }
          )
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('donatehub:add')
          .setLabel('Add donation method')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId('donate:log-received')
          .setLabel('Log money received')
          .setStyle(ButtonStyle.Success)
      ),
    ],
    ephemeral: true,
  };
}

function addMethodModal() {
  return new ModalBuilder()
    .setCustomId('donatehub:modal:add')
    .setTitle('Add donation method')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('label')
          .setLabel('Method name')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(100)
          .setPlaceholder('e.g. PayPal, Patreon, Ko-fi')
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('link')
          .setLabel('Donation link')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(500)
          .setPlaceholder('https://...')
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('description')
          .setLabel('Short description (optional)')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setMaxLength(200)
      )
    );
}

function buildPayPalModal(guildId) {
  const paypal = getPayPalConfig(guildId);
  const clientIdInput = new TextInputBuilder()
    .setCustomId('clientId')
    .setLabel('PayPal Client ID')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(120)
    .setPlaceholder('From developer.paypal.com → Apps');
  if (paypal.clientId) clientIdInput.setValue(paypal.clientId.slice(0, 120));

  return new ModalBuilder()
    .setCustomId('donatehub:modal:paypal')
    .setTitle('PayPal main account API')
    .addComponents(
      new ActionRowBuilder().addComponents(clientIdInput),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('clientSecret')
          .setLabel('PayPal Client Secret')
          .setStyle(TextInputStyle.Short)
          .setRequired(!paypal.clientSecret)
          .setMaxLength(200)
          .setPlaceholder(
            paypal.clientSecret
              ? 'Leave blank to keep existing secret'
              : 'Secret from the same REST app'
          )
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('mode')
          .setLabel('Mode: live or sandbox')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(10)
          .setValue(paypal.mode === 'sandbox' ? 'sandbox' : 'live')
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('enabled')
          .setLabel('Enable sync? yes / no')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(3)
          .setValue(paypal.enabled ? 'yes' : 'no')
      )
    );
}

function buildStripeModal(guildId) {
  const stripe = getStripeConfig(guildId);
  return new ModalBuilder()
    .setCustomId('donatehub:modal:stripe')
    .setTitle('Stripe receiving account')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('secretKey')
          .setLabel('Stripe secret key')
          .setStyle(TextInputStyle.Short)
          .setRequired(!stripe.secretKey)
          .setMaxLength(200)
          .setPlaceholder(
            stripe.secretKey
              ? 'Leave blank to keep existing key'
              : 'sk_live_… or sk_test_…'
          )
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('enabled')
          .setLabel('Enable sync? yes / no')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(3)
          .setValue(stripe.enabled ? 'yes' : 'no')
      )
    );
}

function methodOptions(donations) {
  return listMethods(donations).slice(0, 25).map((m) => ({
    label: m.label.slice(0, 100),
    description: (m.link || '').slice(0, 100),
    value: m.id,
  }));
}

async function handleDonateHubInteraction(interaction) {
  const id = interaction.customId;
  if (!id?.startsWith('donatehub:')) return false;

  if (!canManageDonations(interaction)) {
    await denyDonate(interaction);
    return true;
  }

  const guildId = interaction.guildId;

  if (interaction.isButton() && id === 'donatehub:back') {
    await interaction.update(buildDonateManagePanel(guildId));
    return true;
  }

  if (interaction.isButton() && id === 'donatehub:add') {
    await interaction.showModal(addMethodModal());
    return true;
  }

  if (interaction.isStringSelectMenu() && id === 'donatehub:action') {
    const action = interaction.values[0];
    const donations = getDonations(guildId);

    if (action === 'add') {
      await interaction.showModal(addMethodModal());
      return true;
    }

    if (action === 'paypal') {
      await interaction.showModal(buildPayPalModal(guildId));
      return true;
    }

    if (action === 'stripe') {
      await interaction.showModal(buildStripeModal(guildId));
      return true;
    }

    if (action === 'setup-logs') {
      try {
        const forum = await ensureDonationLogForum(interaction.guild);
        await interaction.update({
          ...buildDonateManagePanel(guildId),
          content: `Donation logs forum ready: <#${forum.id}>`,
        });
      } catch (error) {
        await interaction.update({
          ...buildDonateManagePanel(guildId),
          content: `Could not create forum: ${error.message}`,
        });
      }
      return true;
    }

    const options = methodOptions(donations);
    if (!options.length) {
      await interaction.update({
        ...buildDonateManagePanel(guildId),
        content: 'No methods yet — add one first.',
      });
      return true;
    }

    if (action === 'edit') {
      await interaction.update({
        embeds: [
          guildEmbed(getGuild(guildId), 'Edit donation method').setDescription(
            'Select a method to edit.'
          ),
        ],
        components: [
          new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId('donatehub:select:edit')
              .setPlaceholder('Select method')
              .addOptions(options)
          ),
          backDonate(),
        ],
        content: null,
      });
      return true;
    }

    if (action === 'remove') {
      await interaction.update({
        embeds: [
          guildEmbed(getGuild(guildId), 'Remove donation method').setDescription(
            'Select a method to remove.'
          ),
        ],
        components: [
          new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId('donatehub:select:remove')
              .setPlaceholder('Select method')
              .addOptions(options)
          ),
          backDonate(),
        ],
        content: null,
      });
      return true;
    }
  }

  if (interaction.isStringSelectMenu() && id === 'donatehub:select:edit') {
    const methodId = interaction.values[0];
    const method = getMethod(getDonations(guildId), methodId);
    if (!method) {
      await interaction.update({
        ...buildDonateManagePanel(guildId),
        content: 'That method no longer exists.',
      });
      return true;
    }

    const modal = new ModalBuilder()
      .setCustomId(`donatehub:modal:edit:${methodId}`)
      .setTitle(`Edit · ${method.label.slice(0, 30)}`)
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('label')
            .setLabel('Method name')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(100)
            .setValue(method.label.slice(0, 100))
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('link')
            .setLabel('Donation link')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(500)
            .setValue(method.link.slice(0, 500))
        ),
        new ActionRowBuilder().addComponents(
          (() => {
            const input = new TextInputBuilder()
              .setCustomId('description')
              .setLabel('Short description (optional)')
              .setStyle(TextInputStyle.Paragraph)
              .setRequired(false)
              .setMaxLength(200);
            if (method.description) input.setValue(method.description.slice(0, 200));
            return input;
          })()
        )
      );
    await interaction.showModal(modal);
    return true;
  }

  if (interaction.isStringSelectMenu() && id === 'donatehub:select:remove') {
    const methodId = interaction.values[0];
    const result = removeMethod(guildId, methodId);
    await interaction.update({
      ...buildDonateManagePanel(guildId),
      content: result.ok ? 'Donation method removed.' : result.error,
    });
    return true;
  }

  if (interaction.isModalSubmit() && id === 'donatehub:modal:add') {
    const result = addMethod(guildId, {
      label: interaction.fields.getTextInputValue('label'),
      link: interaction.fields.getTextInputValue('link'),
      description: interaction.fields.getTextInputValue('description'),
    });
    if (!result.ok) {
      await interaction.reply({
        embeds: [errorEmbed(result.error)],
        ephemeral: true,
      });
      return true;
    }
    await interaction.reply({
      embeds: [
        guildEmbed(getGuild(guildId), 'Donation method added').setDescription(
          `**${result.method.label}**\n${result.method.link}`
        ),
      ],
      ephemeral: true,
    });
    return true;
  }

  if (interaction.isModalSubmit() && id === 'donatehub:modal:paypal') {
    const clientId = interaction.fields.getTextInputValue('clientId').trim();
    const secretInput = interaction.fields
      .getTextInputValue('clientSecret')
      .trim();
    const modeRaw = interaction.fields
      .getTextInputValue('mode')
      .trim()
      .toLowerCase();
    const enabledRaw = interaction.fields
      .getTextInputValue('enabled')
      .trim()
      .toLowerCase();

    const mode = modeRaw === 'sandbox' ? 'sandbox' : 'live';
    const enabled = ['yes', 'y', 'true', 'on', '1'].includes(enabledRaw);
    const existing = getPayPalConfig(guildId);
    const clientSecret = secretInput || existing.clientSecret;

    if (!clientId || !clientSecret) {
      await interaction.reply({
        embeds: [
          errorEmbed('Both PayPal Client ID and Client Secret are required.'),
        ],
        ephemeral: true,
      });
      return true;
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      await testPayPalConnection({ clientId, clientSecret, mode });
    } catch (error) {
      await interaction.editReply({
        embeds: [
          errorEmbed(
            `Could not connect to PayPal: ${error.message}\n\n` +
              'Create a REST app at developer.paypal.com for the **main receiving account**, ' +
              'and enable **Transaction Search** on that app.'
          ),
        ],
      });
      return true;
    }

    updatePayPalConfig(guildId, {
      clientId,
      clientSecret,
      mode,
      enabled,
    });

    let syncNote = '';
    if (enabled) {
      try {
        await ensureDonationLogForum(interaction.guild);
        const sync = await syncGuildPayPal(interaction.client, guildId);
        if (sync.ok) {
          syncNote = `\nInitial sync: scanned **${sync.scanned}** credit(s), logged **${sync.created}** new.`;
        } else {
          syncNote = `\nInitial sync note: ${sync.reason}`;
        }
      } catch (error) {
        syncNote = `\nInitial sync failed: ${error.message}`;
      }
    }

    await interaction.editReply({
      embeds: [
        guildEmbed(getGuild(guildId), 'PayPal configured').setDescription(
          [
            paypalConfiguredSummary(guildId),
            'The bot will poll the main account about every **5 minutes**.',
            'PayPal can take up to **~3 hours** before a payment appears in Transaction Search.',
            syncNote,
          ]
            .filter(Boolean)
            .join('\n')
        ),
      ],
    });
    return true;
  }

  if (interaction.isModalSubmit() && id === 'donatehub:modal:stripe') {
    const secretInput = interaction.fields
      .getTextInputValue('secretKey')
      .trim();
    const enabledRaw = interaction.fields
      .getTextInputValue('enabled')
      .trim()
      .toLowerCase();
    const enabled = ['yes', 'y', 'true', 'on', '1'].includes(enabledRaw);
    const existing = getStripeConfig(guildId);
    const secretKey = secretInput || existing.secretKey;

    if (!secretKey) {
      await interaction.reply({
        embeds: [errorEmbed('A Stripe secret key is required (`sk_live_…` or `sk_test_…`).')],
        ephemeral: true,
      });
      return true;
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      await testStripeConnection(secretKey);
    } catch (error) {
      await interaction.editReply({
        embeds: [
          errorEmbed(
            `Could not connect to Stripe: ${error.message}\n\n` +
              'Use the **secret key** from dashboard.stripe.com → Developers → API keys ' +
              'for the receiving account.'
          ),
        ],
      });
      return true;
    }

    updateStripeConfig(guildId, { secretKey, enabled });

    let syncNote = '';
    if (enabled) {
      try {
        await ensureDonationLogForum(interaction.guild);
        const sync = await syncGuildStripe(interaction.client, guildId);
        if (sync.ok) {
          syncNote = `\nInitial sync: scanned **${sync.scanned}** payment(s), logged **${sync.created}** new.`;
        } else {
          syncNote = `\nInitial sync note: ${sync.reason}`;
        }
      } catch (error) {
        syncNote = `\nInitial sync failed: ${error.message}`;
      }
    }

    await interaction.editReply({
      embeds: [
        guildEmbed(getGuild(guildId), 'Stripe configured').setDescription(
          [
            stripeConfiguredSummary(guildId),
            'The bot will poll succeeded PaymentIntents about every **5 minutes**.',
            'Put `discord_id` in PaymentIntent / Checkout metadata to auto-match donors.',
            syncNote,
          ]
            .filter(Boolean)
            .join('\n')
        ),
      ],
    });
    return true;
  }

  if (interaction.isModalSubmit() && id.startsWith('donatehub:modal:edit:')) {
    const methodId = id.slice('donatehub:modal:edit:'.length);
    const result = updateMethod(guildId, methodId, {
      label: interaction.fields.getTextInputValue('label'),
      link: interaction.fields.getTextInputValue('link'),
      description: interaction.fields.getTextInputValue('description'),
    });
    if (!result.ok) {
      await interaction.reply({
        embeds: [errorEmbed(result.error)],
        ephemeral: true,
      });
      return true;
    }
    await interaction.reply({
      embeds: [
        guildEmbed(getGuild(guildId), 'Donation method updated').setDescription(
          `**${result.method.label}**\n${result.method.link}`
        ),
      ],
      ephemeral: true,
    });
    return true;
  }

  return false;
}

module.exports = {
  buildDonateManagePanel,
  handleDonateHubInteraction,
};
