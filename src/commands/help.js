const { SlashCommandBuilder } = require('discord.js');
const { baseEmbed } = require('../utils/embeds');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('How to use Megapithacus'),

  async execute(interaction) {
    const embed = baseEmbed('Megapithacus — ASE (Microsoft Store)')
      .setDescription(
        'Discord tools for **ARK: Survival Evolved** on the **Microsoft Store**, hosted on **Nitrado**.'
      )
      .addFields(
        {
          name: 'Everyone',
          value: '`/help` — this message',
        },
        {
          name: 'Admins',
          value: [
            '`/management` — admin hub:',
            '• **Admin Management** — authorised admins & event staff',
            '• **Server Setup** — Nitrado tokens & sync',
            '• **Server Management** — ping roles for bans/unbans/kicks',
            '• **Customise Bot** — nickname, colours, cluster name',
            '• **Feature Management** — Pop, Ban, Pay, Admin, Chat logs',
            '',
            '`/adminpay manage` — Admin Pay roster, rates, credits, payouts',
            '`/adminpay board` — staff board + manager approval forum',
            '`/player search` — find players (ban/unban/kick on profile)',
          ].join('\n'),
        },
        {
          name: 'Server owner',
          value:
            '`/permissions` — set which roles can use Admin Pay (owner only)',
        },
        {
          name: 'Feature setup',
          value:
            'Each feature **Setup** creates a **Megapithacus** category + log forum. Admin/Chat use **one post per map**. Pop refreshes every 5m; Admin/Chat every 10m.',
        }
      );

    await interaction.reply({ embeds: [embed], ephemeral: true });
  },
};
