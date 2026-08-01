const { SlashCommandBuilder } = require('discord.js');
const { baseEmbed } = require('../utils/embeds');
const { brand } = require('../config');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('How to use Megapithacus'),

  async execute(interaction) {
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
            '`/help` — this message',
            '`/notify` — opt in to announcement DMs (discounts, updates)',
            '`/unnotify` — opt out of announcement DMs',
            '`/subscribe` — subscribe info (currently under maintenance)',
          ].join('\n'),
        },
        {
          name: 'Admins',
          value: [
            '`/announce` — DM players who used `/notify` (discounts, updates, other)',
            '`/setup` — wipe & recreate logging channels + **Megapithacus** admin role (server power)',
            '`/management` — admin hub:',
            '• **Admin Management** — authorised admins & event staff',
            '• **Server Setup** — Nitrado tokens & sync',
            '• **Server Management** — ping roles for bans/unbans/kicks',
            '• **Customise Bot** — colour & footer (watermark always stays)',
            '• **Feature Management** — Pop, Ban, Pay, Donation, Admin, Chat logs',
            '',
            '`/adminpay manage` — Admin Pay Manager',
            '`/adminpay board` — staff board + Admin Pay forum',
            '`/donatemanage` — donation methods, links & PayPal sync',
            '`/donate` — post public donation embed',
            '`/player search` — find players (ban/unban/kick on profile)',
          ].join('\n'),
        },
        {
          name: 'Server owner',
          value:
            '`/permissions` — set which roles can use Admin Pay / Donations (owner only)',
        },
        {
          name: 'Feature setup',
          value:
            'Run `/setup` first for the category + admin role. Each feature **Setup** then creates its log forum under that category. Donation stats post daily totals + a trend chart, and a monthly review every 30 days. Admin/Chat use **one post per map**. Pop refreshes every 5m; Admin/Chat every 10m.',
        }
      );

    await interaction.reply({ embeds: [embed], ephemeral: true });
  },
};
