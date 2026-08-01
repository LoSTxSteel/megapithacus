const {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  UserSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionFlagsBits,
} = require('discord.js');
const {
  getGuild,
  updateGuild,
  addToList,
  removeFromList,
  addNitradoAccount,
  removeNitradoAccount,
  syncServersFromNitrado,
  maskToken,
} = require('../services/storage');
const { testToken, listAllServicesForGuild } = require('../services/nitrado');
const {
  FEATURE_META,
  setupFeature,
  isFeatureEnabled,
  isFeatureConfigured,
} = require('../services/featureSetup');
const { refreshGuildPop } = require('../services/popManager');
const { refreshGuildLogBoards } = require('../services/logBoards');
const { baseEmbed, errorEmbed } = require('../utils/embeds');
const { brand } = require('../config');
const { customisePanel, handleCustomiseInteraction } = require('./customiseBot');
const { serverPanel, handleServerInteraction } = require('./serverManagement');

const MENU_ID = 'mgmt:menu';

function canUseManagement(interaction) {
  return interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
}

function categorySelect(selected) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(MENU_ID)
      .setPlaceholder('Choose a management area')
      .addOptions(
        {
          label: 'Admin Management',
          description: 'Authorised admins and event staff',
          value: 'admin',
          default: selected === 'admin',
        },
        {
          label: 'Server Setup',
          description: 'Add Nitrado tokens and read your servers',
          value: 'setup',
          default: selected === 'setup',
        },
        {
          label: 'Server Management',
          description: 'Ping roles and server tools',
          value: 'server',
          default: selected === 'server',
        },
        {
          label: 'Customise Bot',
          description: 'Nickname, colours, cluster name',
          value: 'customise',
          default: selected === 'customise',
        },
        {
          label: 'Feature Management',
          description: 'Toggle bot features for this Discord',
          value: 'features',
          default: selected === 'features',
        }
      )
  );
}

function mentionList(ids) {
  if (!ids?.length) return '_None_';
  return ids.map((id) => `<@${id}>`).join('\n');
}

function gamertagList(tags) {
  if (!tags?.length) return '_None_';
  return tags.map((tag) => `• \`${tag}\``).join('\n');
}

function homePayload() {
  const embed = baseEmbed('Megapithacus Management')
    .setColor(brand.accent)
    .setDescription(
      [
        'Admin hub for **Microsoft Store ASE** on **Nitrado**.',
        '',
        'Pick a category from the dropdown below.',
      ].join('\n')
    )
    .addFields(
      {
        name: 'Admin Management',
        value: 'Authorised admins (gamertag) and event staff',
      },
      {
        name: 'Server Setup',
        value: 'Add Nitrado tokens so the bot can read your servers',
      },
      {
        name: 'Server Management',
        value: 'Ping roles for bans, unbans, kicks, reminders',
      },
      {
        name: 'Customise Bot',
        value: 'Nickname, embed colour, cluster name, footer',
      },
      {
        name: 'Feature Management',
        value: 'Pop, Ban, Pay, Admin, Chat logging',
      }
    );

  return { embeds: [embed], components: [categorySelect()], ephemeral: true };
}

function adminActionSelect(guild) {
  const hasAdmins = (guild.authorisedAdmins || []).length > 0;
  const hasStaff = (guild.authorisedEventStaff || []).length > 0;

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('mgmt:admin:action')
      .setPlaceholder('Choose an admin action')
      .addOptions(
        {
          label: 'Add Authorised Admins',
          description: 'Enter an Xbox / Microsoft Store gamertag',
          value: 'add-admin',
        },
        {
          label: 'Remove Authorised Admins',
          description: hasAdmins
            ? 'Remove a saved gamertag'
            : 'No authorised admins yet',
          value: 'remove-admin',
        },
        {
          label: 'Add Authorised Event Staff',
          description: 'Pick Discord users as event staff',
          value: 'add-staff',
        },
        {
          label: 'Remove Authorised Event Staff',
          description: hasStaff
            ? 'Remove authorised event staff'
            : 'No event staff yet',
          value: 'remove-staff',
        }
      )
  );
}

function adminPanel(guild) {
  const embed = baseEmbed('Admin Management')
    .setDescription(
      'Authorised **admins use Xbox / Microsoft Store gamertags** (not Discord accounts).\n\nUse the dropdown below to add or remove people.'
    )
    .addFields(
      {
        name: 'Authorised Admins (Gamertag)',
        value: gamertagList(guild.authorisedAdmins),
        inline: true,
      },
      {
        name: 'Authorised Event Staff',
        value: mentionList(guild.authorisedEventStaff),
        inline: true,
      }
    );

  return {
    embeds: [embed],
    components: [categorySelect('admin'), adminActionSelect(guild)],
  };
}

function maintenancePanel(title, selected) {
  const embed = baseEmbed(title).setDescription(
    '🚧 **This section is still under maintenance.**\nCheck back in a later update.'
  );

  return {
    embeds: [embed],
    components: [categorySelect(selected)],
  };
}

function accountListText(guild) {
  const accounts = guild.nitradoAccounts || [];
  if (!accounts.length) return '_No Nitrado tokens saved yet._';
  return accounts
    .map(
      (a) =>
        `• **${a.label}** — \`${maskToken(a.token)}\` _(id: ${a.id})_`
    )
    .join('\n');
}

function setupActionSelect(guild) {
  const hasAccounts = (guild.nitradoAccounts || []).length > 0;

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('mgmt:setup:action')
      .setPlaceholder('Choose a server setup action')
      .addOptions(
        {
          label: 'Add Nitrado token',
          description: 'Save a long-life token for this Discord',
          value: 'add-token',
        },
        {
          label: 'Remove Nitrado token',
          description: hasAccounts
            ? 'Remove a saved token'
            : 'No tokens saved yet',
          value: 'remove-token',
        },
        {
          label: 'Read servers',
          description: hasAccounts
            ? 'List ASE servers from saved tokens'
            : 'Add a token first',
          value: 'read-servers',
        },
        {
          label: 'Sync servers to bot',
          description: hasAccounts
            ? 'Import Nitrado services for /pop'
            : 'Add a token first',
          value: 'sync-servers',
        }
      )
  );
}

function setupPanel(guild) {
  const accounts = guild.nitradoAccounts || [];
  const embed = baseEmbed('Server Setup')
    .setDescription(
      [
        'Connect your **Nitrado** account so Megapithacus can read your **Microsoft Store ASE** servers.',
        '',
        'Create a long-life token at server.nitrado.net → account → **Developer Portal**.',
        'Tokens are stored for this Discord only and shown masked below.',
      ].join('\n')
    )
    .addFields(
      {
        name: 'Saved tokens',
        value: accountListText(guild),
      },
      {
        name: 'Synced maps',
        value: String((guild.servers || []).length),
        inline: true,
      },
      {
        name: 'Accounts',
        value: String(accounts.length),
        inline: true,
      }
    );

  return {
    embeds: [embed],
    components: [categorySelect('setup'), setupActionSelect(guild)],
  };
}

function featureSetupText(guild, key) {
  const setup = guild.featureSetup || {};
  const configured = isFeatureConfigured(guild, key);
  const category = setup.categoryId ? `<#${setup.categoryId}>` : '_Not created_';
  const meta = FEATURE_META[key];
  const featureState = setup[key] || {};

  if (key === 'banLogging') {
    return [
      `Configured: **${configured ? 'Yes' : 'No'}**`,
      `Category: ${category}`,
      `Log forum: ${featureState.forumId ? `<#${featureState.forumId}>` : '_Not created_'}`,
      '',
      'Each bot ban/unban/kick posts a forum thread with:',
      '• Who banned / unbanned / kicked them',
      '• Who got banned / unbanned / kicked',
      '• Optional role pings from Server Management',
      '• Duration',
      '• How many servers',
      '• Reason',
      !configured
        ? '_Press **Setup** to create the Megapithacus category + ban-logging forum._'
        : '_Ready. Enable to start writing ban logs._',
    ].join('\n');
  }

  if (key === 'payLogging') {
    return [
      `Configured: **${configured ? 'Yes' : 'No'}**`,
      `Category: ${category}`,
      `Log forum: ${featureState.forumId ? `<#${featureState.forumId}>` : '_Not created_'}`,
      '',
      'Forum threads for managers to approve:',
      '• Completed events from `/adminpay board`',
      '• Pay (payout) requests from `/adminpay board`',
      '',
      'Also logs bonuses, credits, payouts, and roster changes.',
      '`/adminpay board` creates and enables this forum automatically.',
      '',
      'Use `/permissions` to control who can manage Admin Pay / approve.',
      !configured
        ? '_Press **Setup**, or run `/adminpay board` to create the forum._'
        : '_Ready for approvals and pay logs._',
    ].join('\n');
  }

  if (!meta) return '_No setup details._';

  const refresh = meta.refreshMinutes
    ? `When enabled, the live post embed refreshes every **${meta.refreshMinutes}** minutes.`
    : '';

  const extras = [];
  if (key === 'adminLogging') {
    extras.push('On **Setup**, finds every service on your Nitrado account and creates a thread each.');
    extras.push('Reads **in-game admin commands** from Nitrado ASE logs (not Discord).');
    extras.push(`Nitrado services / posts: **${Object.keys(featureState.mapThreads || {}).length}**`);
  }
  if (key === 'chatLogs') {
    extras.push('On **Setup**, finds every service on your Nitrado account and creates a thread each.');
    extras.push('Pulls **in-game chat** per map from Nitrado ASE logs.');
    extras.push(`Nitrado services / posts: **${Object.keys(featureState.mapThreads || {}).length}**`);
  }
  if (key === 'popManager') {
    extras.push(`Synced maps: **${(guild.servers || []).length}**`);
    extras.push(
      `Live post: ${featureState.threadId ? `<#${featureState.threadId}>` : '_Not created_'}`
    );
  }

  return [
    `Configured: **${configured ? 'Yes' : 'No'}**`,
    `Category: ${category}`,
    `Log forum: ${featureState.forumId ? `<#${featureState.forumId}>` : '_Not created_'}`,
    ...extras,
    '',
    refresh,
    !configured
      ? `_Press **Setup** to create the Megapithacus category + ${meta.forumName} forum._`
      : '_Ready. Enable to start this feature._',
  ]
    .filter(Boolean)
    .join('\n');
}

function featureSelectRow() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('mgmt:feat:select')
      .setPlaceholder('Choose a feature')
      .addOptions(
        Object.entries(FEATURE_META).map(([key, meta]) => ({
          label: meta.label,
          description: meta.short.slice(0, 100),
          value: key,
        }))
      )
  );
}

function featuresPanel(guild) {
  const lines = Object.keys(FEATURE_META).map((key) => {
    const enabled = isFeatureEnabled(guild, key);
    const configured = isFeatureConfigured(guild, key);
    return `${enabled ? '🟢' : '🔴'} **${FEATURE_META[key].label}**${
      configured ? '' : ' _(needs setup)_'
    }`;
  });

  const embed = baseEmbed('Feature Management')
    .setDescription(
      [
        'Select a feature from the dropdown for details and controls.',
        '**Setup** creates a category + log forum for that feature.',
        '',
        ...lines,
      ].join('\n')
    );

  return {
    embeds: [embed],
    components: [categorySelect('features'), featureSelectRow()],
  };
}

function featureDetailPanel(guild, key) {
  const meta = FEATURE_META[key];
  if (!meta) return featuresPanel(guild);

  const enabled = isFeatureEnabled(guild, key);
  const configured = isFeatureConfigured(guild, key);
  const embed = baseEmbed(meta.label)
    .setDescription(meta.short)
    .addFields(
      {
        name: 'Status',
        value: enabled ? '🟢 **Turned on**' : '🔴 **Turned off**',
        inline: true,
      },
      {
        name: 'What’s set up',
        value: featureSetupText(guild, key),
      }
    );

  const controls = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`mgmt:feat:setup:${key}`)
      .setLabel(configured ? 'Re-run Setup' : 'Setup')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`mgmt:feat:enable:${key}`)
      .setLabel('Enable')
      .setStyle(ButtonStyle.Success)
      .setDisabled(enabled || !configured),
    new ButtonBuilder()
      .setCustomId(`mgmt:feat:disable:${key}`)
      .setLabel('Disable')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(!enabled),
    new ButtonBuilder()
      .setCustomId('mgmt:back:features')
      .setLabel('Back')
      .setStyle(ButtonStyle.Secondary)
  );

  return {
    embeds: [embed],
    components: [categorySelect('features'), controls],
  };
}

function panelFor(value, guild, guildId) {
  switch (value) {
    case 'admin':
      return adminPanel(guild);
    case 'setup':
      return setupPanel(guild);
    case 'server':
      return serverPanel(guild, categorySelect);
    case 'customise':
      return customisePanel(guild, categorySelect);
    case 'features':
      return featuresPanel(guild);
    default:
      return homePayload();
  }
}

function userPicker(customId, placeholder) {
  return new ActionRowBuilder().addComponents(
    new UserSelectMenuBuilder()
      .setCustomId(customId)
      .setPlaceholder(placeholder)
      .setMinValues(1)
      .setMaxValues(10)
  );
}

function removePicker(customId, values, placeholder, { asGamertag = false, discordGuild } = {}) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(customId)
      .setPlaceholder(placeholder)
      .setMinValues(1)
      .setMaxValues(Math.min(values.length, 10))
      .addOptions(
        values.slice(0, 25).map((value) => {
          if (asGamertag) {
            return {
              label: String(value).slice(0, 100),
              description: 'Gamertag',
              value: String(value).slice(0, 100),
            };
          }

          const member = discordGuild?.members?.cache?.get(value);
          const label = (
            member?.displayName ||
            member?.user?.username ||
            `User ${value}`
          ).slice(0, 100);
          return {
            label,
            description: value,
            value,
          };
        })
      )
  );
}

function backRow(target) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`mgmt:back:${target}`)
      .setLabel('Back')
      .setStyle(ButtonStyle.Secondary)
  );
}

async function handleManagement(interaction) {
  const guildId = interaction.guildId;
  const id = interaction.customId;

  if (!canUseManagement(interaction)) {
    const payload = {
      embeds: [errorEmbed('You need **Manage Server** to use management.')],
      ephemeral: true,
    };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(payload);
    } else if (interaction.isRepliable()) {
      await interaction.reply(payload);
    }
    return;
  }

  if (interaction.isStringSelectMenu() && id === MENU_ID) {
    const value = interaction.values[0];
    await interaction.update({
      ...panelFor(value, getGuild(guildId), guildId),
      content: null,
    });
    return;
  }

  if (id?.startsWith('mgmt:back:')) {
    const target = id.split(':')[2];
    await interaction.update({
      ...panelFor(target, getGuild(guildId), guildId),
      content: null,
    });
    return;
  }

  if (
    await handleCustomiseInteraction(interaction, {
      categorySelect,
      panelFor,
    })
  ) {
    return;
  }

  if (
    await handleServerInteraction(interaction, {
      categorySelect,
    })
  ) {
    return;
  }

  // Admin action dropdown
  if (interaction.isStringSelectMenu() && id === 'mgmt:admin:action') {
    const action = interaction.values[0];
    const guild = getGuild(guildId);

    if (action === 'add-admin') {
      const modal = new ModalBuilder()
        .setCustomId('mgmt:modal:add-admin')
        .setTitle('Add Authorised Admin')
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('gamertag')
              .setLabel('Xbox / Microsoft Store gamertag')
              .setStyle(TextInputStyle.Short)
              .setPlaceholder('Exact in-game gamertag')
              .setRequired(true)
              .setMinLength(1)
              .setMaxLength(32)
          )
        );
      await interaction.showModal(modal);
      return;
    }

    if (action === 'remove-admin') {
      const tags = guild.authorisedAdmins || [];
      if (!tags.length) {
        await interaction.update({
          ...adminPanel(guild),
          content: 'No authorised admins to remove yet.',
        });
        return;
      }

      await interaction.update({
        embeds: [
          baseEmbed('Remove Authorised Admins').setDescription(
            'Select gamertags to remove from the authorised admin list.'
          ),
        ],
        components: [
          categorySelect('admin'),
          removePicker('mgmt:select:remove-admin', tags, 'Select gamertags to remove', {
            asGamertag: true,
          }),
          backRow('admin'),
        ],
        content: null,
      });
      return;
    }

    if (action === 'add-staff') {
      await interaction.update({
        embeds: [
          baseEmbed('Add Authorised Event Staff').setDescription(
            'Select one or more Discord users to mark as authorised event staff.'
          ),
        ],
        components: [
          categorySelect('admin'),
          userPicker('mgmt:select:add-staff', 'Select event staff to add'),
          backRow('admin'),
        ],
        content: null,
      });
      return;
    }

    if (action === 'remove-staff') {
      const ids = guild.authorisedEventStaff || [];
      if (!ids.length) {
        await interaction.update({
          ...adminPanel(guild),
          content: 'No authorised event staff to remove yet.',
        });
        return;
      }

      await interaction.update({
        embeds: [
          baseEmbed('Remove Authorised Event Staff').setDescription(
            'Select event staff to remove from the authorised list.'
          ),
        ],
        components: [
          categorySelect('admin'),
          removePicker('mgmt:select:remove-staff', ids, 'Select event staff to remove', {
            discordGuild: interaction.guild,
          }),
          backRow('admin'),
        ],
        content: null,
      });
      return;
    }
  }

  if (interaction.isModalSubmit() && id === 'mgmt:modal:add-admin') {
    const gamertag = interaction.fields.getTextInputValue('gamertag');
    const result = addToList(guildId, 'authorisedAdmins', gamertag, {
      caseInsensitive: true,
    });

    if (!result.added) {
      await interaction.reply({
        embeds: [
          errorEmbed(
            result.reason === 'duplicate'
              ? `\`${gamertag.trim()}\` is already an authorised admin.`
              : 'Enter a valid gamertag.'
          ),
        ],
        ephemeral: true,
      });
      return;
    }

    await interaction.reply({
      embeds: [
        baseEmbed('Authorised admin added').setDescription(
          `Added gamertag **\`${result.list[result.list.length - 1]}\`**.`
        ),
      ],
      ephemeral: true,
    });
    return;
  }

  if (interaction.isUserSelectMenu() && id === 'mgmt:select:add-staff') {
    const added = [];
    for (const userId of interaction.values) {
      const result = addToList(guildId, 'authorisedEventStaff', userId);
      if (result.added) added.push(userId);
    }
    await interaction.update({
      ...adminPanel(getGuild(guildId)),
      content:
        added.length > 0
          ? `Added event staff: ${added.map((u) => `<@${u}>`).join(', ')}`
          : 'No new event staff were added (already authorised).',
    });
    return;
  }

  if (interaction.isStringSelectMenu() && id === 'mgmt:select:remove-admin') {
    for (const tag of interaction.values) {
      removeFromList(guildId, 'authorisedAdmins', tag, { caseInsensitive: true });
    }
    await interaction.update({
      ...adminPanel(getGuild(guildId)),
      content: `Removed gamertag(s): ${interaction.values.map((t) => `\`${t}\``).join(', ')}`,
    });
    return;
  }

  if (interaction.isStringSelectMenu() && id === 'mgmt:select:remove-staff') {
    for (const userId of interaction.values) {
      removeFromList(guildId, 'authorisedEventStaff', userId);
    }
    await interaction.update({
      ...adminPanel(getGuild(guildId)),
      content: `Removed: ${interaction.values.map((u) => `<@${u}>`).join(', ')}`,
    });
    return;
  }

  // Server Setup actions
  if (interaction.isStringSelectMenu() && id === 'mgmt:setup:action') {
    const action = interaction.values[0];
    const guild = getGuild(guildId);

    if (action === 'add-token') {
      const modal = new ModalBuilder()
        .setCustomId('mgmt:modal:add-token')
        .setTitle('Add Nitrado token')
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('label')
              .setLabel('Label (e.g. Main cluster)')
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setMaxLength(64)
              .setPlaceholder('Main Nitrado account')
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('token')
              .setLabel('Nitrado long-life token')
              .setStyle(TextInputStyle.Paragraph)
              .setRequired(true)
              .setMinLength(20)
              .setMaxLength(4000)
              .setPlaceholder('Paste token from Nitrado Developer Portal')
          )
        );
      await interaction.showModal(modal);
      return;
    }

    if (action === 'remove-token') {
      const accounts = guild.nitradoAccounts || [];
      if (!accounts.length) {
        await interaction.update({
          ...setupPanel(guild),
          content: 'No Nitrado tokens saved yet.',
        });
        return;
      }

      await interaction.update({
        embeds: [
          baseEmbed('Remove Nitrado token').setDescription(
            'Select a saved token to remove. Linked synced servers for that account are also removed.'
          ),
        ],
        components: [
          categorySelect('setup'),
          new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId('mgmt:select:remove-token')
              .setPlaceholder('Select a token to remove')
              .addOptions(
                accounts.slice(0, 25).map((a) => ({
                  label: a.label.slice(0, 100),
                  description: maskToken(a.token),
                  value: a.id,
                }))
              )
          ),
          backRow('setup'),
        ],
        content: null,
      });
      return;
    }

    if (action === 'read-servers' || action === 'sync-servers') {
      if (!(guild.nitradoAccounts || []).length) {
        await interaction.update({
          ...setupPanel(guild),
          content: 'Add a Nitrado token first.',
        });
        return;
      }

      await interaction.deferUpdate();
      const discovered = await listAllServicesForGuild(getGuild(guildId));
      const okItems = discovered.filter((d) => d.service && !d.error);
      const errors = discovered.filter((d) => d.error);

      if (action === 'sync-servers') {
        const synced = syncServersFromNitrado(guildId, discovered);
        await interaction.editReply({
          ...setupPanel(getGuild(guildId)),
          content: `Synced **${synced.length}** server(s) from Nitrado.${
            errors.length ? ` ${errors.length} account(s) failed.` : ''
          }`,
        });
        return;
      }

      const lines = okItems.slice(0, 20).map((item) => {
        const s = item.service;
        const name =
          s.details?.name || s.type_human || s.game_human || s.type || 'Service';
        return `• **${name}** — \`${s.id}\` (${s.status || 'unknown'}) · ${item.accountLabel}`;
      });

      const embed = baseEmbed('Nitrado servers found')
        .setDescription(
          [
            `Found **${okItems.length}** service(s) across your saved tokens.`,
            errors.length
              ? `_ ${errors.length} account(s) failed: ${errors
                  .map((e) => `${e.accountLabel} (${e.error})`)
                  .join('; ')}_`
              : '',
            '',
            ...(lines.length ? lines : ['_No services returned._']),
            okItems.length > 20 ? `\n_…and ${okItems.length - 20} more_` : '',
            '',
            'Use **Sync servers to bot** to import these for `/pop`.',
          ]
            .filter(Boolean)
            .join('\n')
        )
        .setFooter({ text: 'Microsoft Store ASE · Nitrado' });

      await interaction.editReply({
        embeds: [embed],
        components: [categorySelect('setup'), setupActionSelect(getGuild(guildId))],
        content: null,
      });
      return;
    }
  }

  if (interaction.isModalSubmit() && id === 'mgmt:modal:add-token') {
    const label = interaction.fields.getTextInputValue('label');
    const token = interaction.fields.getTextInputValue('token');

    await interaction.deferReply({ ephemeral: true });

    try {
      const probe = await testToken(token.trim());
      const saved = addNitradoAccount(guildId, { label, token });

      if (!saved.ok) {
        await interaction.editReply({
          embeds: [
            errorEmbed(
              saved.reason === 'duplicate'
                ? 'That Nitrado token is already saved on this Discord.'
                : 'That token looks invalid. Paste the full long-life token.'
            ),
          ],
        });
        return;
      }

      await interaction.editReply({
        embeds: [
          baseEmbed('Nitrado token saved').setDescription(
            [
              `Label: **${saved.account.label}**`,
              `Token: \`${maskToken(saved.account.token)}\``,
              `Services visible: **${probe.serviceCount}**`,
              '',
              'Open **Server Setup** again and use **Sync servers to bot** to import maps for `/pop`.',
            ].join('\n')
          ),
        ],
      });
    } catch (error) {
      await interaction.editReply({
        embeds: [
          errorEmbed(
            `Could not validate that Nitrado token.\n${error.message}`
          ),
        ],
      });
    }
    return;
  }

  if (interaction.isStringSelectMenu() && id === 'mgmt:select:remove-token') {
    const accountId = interaction.values[0];
    removeNitradoAccount(guildId, accountId);
    await interaction.update({
      ...setupPanel(getGuild(guildId)),
      content: 'Nitrado token removed.',
    });
    return;
  }

  // Features — pick from dropdown
  if (interaction.isStringSelectMenu() && id === 'mgmt:feat:select') {
    const key = interaction.values[0];
    await interaction.update({
      ...featureDetailPanel(getGuild(guildId), key),
      content: null,
    });
    return;
  }

  // Features — setup (creates category + forum)
  if (id?.startsWith('mgmt:feat:setup:')) {
    const key = id.split(':')[3];
    if (!FEATURE_META[key]) {
      await interaction.update(featuresPanel(getGuild(guildId)));
      return;
    }

    await interaction.deferUpdate();
    try {
      const result = await setupFeature(interaction.guild, key);
      if (key === 'popManager') {
        await refreshGuildPop(interaction.client, guildId).catch(() => null);
      }
      if (['adminLogging', 'chatLogs'].includes(key)) {
        await refreshGuildLogBoards(interaction.client, guildId).catch(() => null);
      }
      const mapNote =
        typeof result.mapCount === 'number'
          ? `\nCreated/updated **${result.mapCount}** map thread(s) from your Nitrado account.`
          : '';
      const errNote =
        result.discoverErrors?.length
          ? `\n_Note: ${result.discoverErrors.slice(0, 2).join('; ')}_`
          : '';

      await interaction.editReply({
        ...featureDetailPanel(getGuild(guildId), key),
        content: `Setup complete for **${result.meta.label}** → ${result.forum}${mapNote}${errNote}`,
      });
    } catch (error) {
      await interaction.editReply({
        ...featureDetailPanel(getGuild(guildId), key),
        content: `Setup failed: ${error.message}`,
      });
    }
    return;
  }

  // Features — enable / disable
  if (id?.startsWith('mgmt:feat:enable:') || id?.startsWith('mgmt:feat:disable:')) {
    const [, , action, key] = id.split(':');
    if (!FEATURE_META[key]) {
      await interaction.update(featuresPanel(getGuild(guildId)));
      return;
    }

    const enabled = action === 'enable';
    const current = getGuild(guildId);

    if (enabled && !isFeatureConfigured(current, key)) {
      await interaction.update({
        ...featureDetailPanel(current, key),
        content: 'Run **Setup** first so the category and log forum exist.',
      });
      return;
    }

    updateGuild(guildId, { features: { [key]: enabled } });

    if (enabled && (key === 'popManager' || ['adminLogging', 'chatLogs'].includes(key))) {
      await interaction.deferUpdate();
      if (key === 'popManager') {
        await refreshGuildPop(interaction.client, guildId).catch(() => null);
      } else {
        await refreshGuildLogBoards(interaction.client, guildId).catch(() => null);
      }
      const mins = FEATURE_META[key].refreshMinutes;
      await interaction.editReply({
        ...featureDetailPanel(getGuild(guildId), key),
        content: `Enabled **${FEATURE_META[key].label}**.${
          mins ? ` Board refreshes every ${mins} minutes.` : ''
        }`,
      });
      return;
    }

    await interaction.update({
      ...featureDetailPanel(getGuild(guildId), key),
      content: enabled
        ? `Enabled **${FEATURE_META[key].label}**.`
        : `Disabled **${FEATURE_META[key].label}**.`,
    });
  }
}

module.exports = {
  homePayload,
  handleManagement,
  MENU_ID,
};
