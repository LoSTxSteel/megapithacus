const {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const { EPHEMERAL } = require('../utils/ephemeral');
const { getGuild, updateGuild } = require('../services/storage');
const {
  guildEmbed,
  errorEmbed,
  parseEmbedColor,
  footerForGuild,
} = require('../utils/embeds');
const { brand } = require('../config');

function customiseActionSelect() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('mgmt:custom:action')
      .setPlaceholder('Choose what to customise')
      .addOptions(
        {
          label: 'Cluster name',
          description: 'Display name for this ASE cluster',
          value: 'cluster-name',
        },
        {
          label: 'Bot nickname',
          description: 'Nickname Megapithacus uses in this Discord',
          value: 'nickname',
        },
        {
          label: 'Embed colour',
          description: 'Hex colour for bot embeds (e.g. #e74c3c)',
          value: 'embed-color',
        },
        {
          label: 'Footer text',
          description: 'Custom footer line (bot name watermark stays)',
          value: 'footer',
        },
        {
          label: 'Reset customisation',
          description: 'Clear nickname/colour/footer overrides',
          value: 'reset',
        }
      )
  );
}

function customisePanel(guild, categorySelect) {
  const custom = guild.botCustom || {};
  const color = custom.embedColor
    ? `#${Number(custom.embedColor).toString(16).padStart(6, '0')}`
    : `_Default (#${brand.color.toString(16).padStart(6, '0')})_`;

  const footerPreview = footerForGuild(guild, 'Preview');

  const embed = guildEmbed(guild, 'Customise Bot', { context: 'Customise' })
    .setDescription(
      [
        'Personalise how Megapithacus looks in **this Discord**.',
        '',
        `Every embed keeps **${brand.name}** as a watermark (author + footer).`,
        'Colour and footer text below are what you can change.',
      ].join('\n')
    )
    .addFields(
      {
        name: 'Cluster name',
        value: guild.clusterName || 'My ASE Cluster',
        inline: true,
      },
      {
        name: 'Bot nickname',
        value: custom.nickname || '_Discord default_',
        inline: true,
      },
      {
        name: 'Embed colour',
        value: typeof color === 'string' && color.startsWith('#')
          ? `\`${color}\``
          : color,
        inline: true,
      },
      {
        name: 'Custom footer',
        value: custom.footerText || '_None — feature label only_',
        inline: true,
      },
      {
        name: 'Footer preview',
        value: `\`${footerPreview}\``,
        inline: false,
      }
    );

  return {
    embeds: [embed],
    components: [categorySelect('customise'), customiseActionSelect()],
  };
}

async function applyNickname(discordGuild, nickname) {
  const me = discordGuild.members.me;
  if (!me) return { ok: false, error: 'Bot member not available.' };
  try {
    await me.setNickname(nickname || null);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error:
        error.message ||
        'Could not change nickname (need Manage Nicknames / role hierarchy).',
    };
  }
}

/**
 * @returns {Promise<boolean>} true if handled
 */
async function handleCustomiseInteraction(interaction, { categorySelect }) {
  const id = interaction.customId;
  const isCustom =
    id?.startsWith('mgmt:custom:') ||
    id?.startsWith('mgmt:modal:custom-');
  if (!isCustom) return false;

  const guildId = interaction.guildId;

  if (interaction.isStringSelectMenu() && id === 'mgmt:custom:action') {
    const action = interaction.values[0];
    const guild = getGuild(guildId);

    if (action === 'cluster-name') {
      const modal = new ModalBuilder()
        .setCustomId('mgmt:modal:custom-cluster')
        .setTitle('Cluster name')
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('value')
              .setLabel('Cluster display name')
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setMaxLength(64)
              .setValue(String(guild.clusterName || 'My ASE Cluster').slice(0, 64))
          )
        );
      await interaction.showModal(modal);
      return true;
    }

    if (action === 'nickname') {
      const modal = new ModalBuilder()
        .setCustomId('mgmt:modal:custom-nickname')
        .setTitle('Bot nickname')
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('value')
              .setLabel('Nickname (leave blank to reset)')
              .setStyle(TextInputStyle.Short)
              .setRequired(false)
              .setMaxLength(32)
              .setValue(String(guild.botCustom?.nickname || '').slice(0, 32))
          )
        );
      await interaction.showModal(modal);
      return true;
    }

    if (action === 'embed-color') {
      const current = guild.botCustom?.embedColor;
      const hex = current
        ? `#${Number(current).toString(16).padStart(6, '0')}`
        : '';
      const modal = new ModalBuilder()
        .setCustomId('mgmt:modal:custom-color')
        .setTitle('Embed colour')
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('value')
              .setLabel('Hex colour (e.g. #9b59b6)')
              .setStyle(TextInputStyle.Short)
              .setRequired(false)
              .setMaxLength(7)
              .setPlaceholder('#9b59b6')
              .setValue(hex)
          )
        );
      await interaction.showModal(modal);
      return true;
    }

    if (action === 'footer') {
      const modal = new ModalBuilder()
        .setCustomId('mgmt:modal:custom-footer')
        .setTitle('Footer text')
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('value')
              .setLabel('Custom footer (blank = default)')
              .setStyle(TextInputStyle.Short)
              .setRequired(false)
              .setMaxLength(48)
              .setPlaceholder('Your cluster tag — Megapithacus stays')
              .setValue(String(guild.botCustom?.footerText || '').slice(0, 48))
          )
        );
      await interaction.showModal(modal);
      return true;
    }

    if (action === 'reset') {
      updateGuild(guildId, {
        botCustom: { nickname: null, embedColor: null, footerText: null },
      });
      await applyNickname(interaction.guild, null);
      await interaction.update({
        ...customisePanel(getGuild(guildId), categorySelect),
        content: 'Customisation reset to defaults.',
      });
      return true;
    }
  }

  if (interaction.isModalSubmit() && id === 'mgmt:modal:custom-cluster') {
    const value = interaction.fields.getTextInputValue('value').trim();
    if (!value) {
      await interaction.reply({
        embeds: [errorEmbed('Cluster name cannot be empty.')],
        ...EPHEMERAL,
      });
      return true;
    }
    updateGuild(guildId, { clusterName: value });
    await interaction.reply({
      embeds: [
        guildEmbed(getGuild(guildId), 'Cluster name updated', {
          context: 'Customise',
        }).setDescription(`Cluster name is now **${value}**.`),
      ],
      ...EPHEMERAL,
    });
    return true;
  }

  if (interaction.isModalSubmit() && id === 'mgmt:modal:custom-nickname') {
    const value = interaction.fields.getTextInputValue('value').trim() || null;
    const nickResult = await applyNickname(interaction.guild, value);
    updateGuild(guildId, { botCustom: { nickname: value } });

    if (!nickResult.ok) {
      await interaction.reply({
        embeds: [
          errorEmbed(
            `Saved nickname setting, but Discord rejected the change:\n${nickResult.error}`
          ),
        ],
        ...EPHEMERAL,
      });
      return true;
    }

    await interaction.reply({
      embeds: [
        guildEmbed(getGuild(guildId), 'Nickname updated', {
          context: 'Customise',
        }).setDescription(
          value
            ? `Bot nickname set to **${value}**.`
            : 'Bot nickname reset to the Discord default.'
        ),
      ],
      ...EPHEMERAL,
    });
    return true;
  }

  if (interaction.isModalSubmit() && id === 'mgmt:modal:custom-color') {
    const raw = interaction.fields.getTextInputValue('value').trim();
    if (!raw) {
      updateGuild(guildId, { botCustom: { embedColor: null } });
      await interaction.reply({
        embeds: [
          guildEmbed(getGuild(guildId), 'Embed colour reset', {
            context: 'Customise',
          }).setDescription(
            'Embeds will use the default Megapithacus colour.'
          ),
        ],
        ...EPHEMERAL,
      });
      return true;
    }

    const parsed = parseEmbedColor(raw);
    if (parsed == null) {
      await interaction.reply({
        embeds: [errorEmbed('Enter a valid hex colour like `#e74c3c`.')],
        ...EPHEMERAL,
      });
      return true;
    }

    updateGuild(guildId, { botCustom: { embedColor: parsed } });
    await interaction.reply({
      embeds: [
        guildEmbed(getGuild(guildId), 'Embed colour updated', {
          context: 'Customise',
        }).setDescription(
          `Embed colour set to \`#${parsed.toString(16).padStart(6, '0')}\`.`
        ),
      ],
      ...EPHEMERAL,
    });
    return true;
  }

  if (interaction.isModalSubmit() && id === 'mgmt:modal:custom-footer') {
    const value = interaction.fields.getTextInputValue('value').trim() || null;
    updateGuild(guildId, { botCustom: { footerText: value } });
    const guild = getGuild(guildId);
    await interaction.reply({
      embeds: [
        guildEmbed(guild, 'Footer updated', { context: 'Customise' }).setDescription(
          value
            ? `Custom footer set to **${value}**.\nPreview: \`${footerForGuild(guild, 'Example')}\``
            : `Footer reset. Watermark stays: \`${footerForGuild(guild, 'Example')}\``
        ),
      ],
      ...EPHEMERAL,
    });
    return true;
  }

  return false;
}

module.exports = {
  customisePanel,
  handleCustomiseInteraction,
  customiseActionSelect,
};
