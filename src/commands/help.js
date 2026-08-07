const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { baseEmbed } = require('../utils/embeds');
const { EPHEMERAL } = require('../utils/ephemeral');
const { brand } = require('../config');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('How to use Megapithacus')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    const canManage = interaction.memberPermissions?.has(
      PermissionFlagsBits.ManageGuild
    );
    if (!canManage) {
      await interaction.reply({
        embeds: [
          baseEmbed('Help', { context: 'Help' }).setDescription(
            'Only members with **Manage Server** can view `/help`.'
          ),
        ],
        ...EPHEMERAL,
      });
      return;
    }

    const embed = baseEmbed('ASE Manager', { context: 'Help' })
      .setDescription(
        [
          `**${brand.name}** — Discord tools for **ARK: Survival Evolved**`,
          '**Microsoft Store** · hosted on **Nitrado**',
        ].join('\n')
      )
      .addFields(
        {
          name: 'Everyone',
          value: [
            '`/credit` — view your seasonal & permanent credit',
            '`/pay` — admin pay balance, log events/tickets, request payouts (configured roles only)',
          ].join('\n'),
        },
        {
          name: 'Admins',
          value: [
            '`/help` — this message (Manage Server)',
            '`/setup` — wipe & recreate logging channels + **Megapithacus** admin role (server power)',
            '`/management` — admin hub:',
            '• **Admin Management** — authorised admins & event staff',
            '• **Server Setup** — Nitrado tokens & sync',
            '• **Server Management** — ping roles for bans/unbans/kicks',
            '• **Customise Bot** — colour & footer (watermark always stays)',
            '• **Feature Management** — Server Status, Ban, Donation, Admin, Chat, Join/Leave, Gamerscore',
            '',
            '`/rewardmanager` — boost & invite rewards hub',
            '`/creditmanager` — credit hub (add, remove, wipe seasonal/permanent)',
            "`/creditview` — view another user's credit balance",
            '`/adminpay` — configure admin pay rates, /pay roles & review payouts',
            '`/servermanager` — Nitrado hub (start/stop/restart, password, name)',
            '`/rollback` — restore Nitrado backup or dated SavedArks `.ark`',
            '`/upload` — upload a custom `.ark` save (Discord size limits apply)',
            '`/gamerscoremanager` — Xbox gamerscore join checks (min score, kick/ban)',
            '`/donatemanage` — donation methods, links & PayPal sync',
            '`/donate` — post public donation embed',
            '`/playersearch` — live online check + player profile (ban/unban/kick)',
            '`/ban` — ban by gamertag / id (`identifier`, `duration`, `reason`)',
            '`/unban` — lift a ban by gamertag / id (`identifier`)',
          ].join('\n'),
        },
        {
          name: 'Server owner',
          value:
            '`/permissions` — hub to set which roles can use Donations / Rewards / Credits / Gamerscore / Server power / Admin Pay (owner only)',
        },
        {
          name: 'Feature setup',
          value:
            'Run `/setup` first for the category + admin role. Admin, Chat, and Join/Leave each use a shared forum with **one thread per map**. Donation logs use their own forum. **Gamerscore Detection** uses `#gamerscore-detection`. **Server Status** refreshes every 10m; Admin/Chat every 15m; joins/leaves every 5m.',
        }
      );

    await interaction.reply({ embeds: [embed], ...EPHEMERAL });
  },
};
