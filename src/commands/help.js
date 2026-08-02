const { SlashCommandBuilder } = require('discord.js');
const { baseEmbed } = require('../utils/embeds');
const { EPHEMERAL } = require('../utils/ephemeral');
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
            '`/credit` — view your seasonal & permanent credit',
          ].join('\n'),
        },
        {
          name: 'Admins',
          value: [
            '`/setup` — wipe & recreate logging channels + **Megapithacus** admin role (server power)',
            '`/management` — admin hub:',
            '• **Admin Management** — authorised admins & event staff',
            '• **Server Setup** — Nitrado tokens & sync',
            '• **Server Management** — ping roles for bans/unbans/kicks',
            '• **Customise Bot** — colour & footer (watermark always stays)',
            '• **Feature Management** — Server Status, Ban, Donation, Admin, Chat, Join/Leave, Gamerscore',
            '',
            '`/rewardmanager` — boost rewards hub (enable, channel, amount, type)',
            '`/creditmanager` — credit hub (add, remove, wipe seasonal/permanent)',
            "`/creditview` — view another user's credit balance",
            '`/servermanager` — Nitrado hub (start/stop/restart, password, name)',
            '`/gamerscoremanager` — Xbox gamerscore join checks (min score, kick/ban)',
            '`/donatemanage` — donation methods, links & PayPal sync',
            '`/donate` — post public donation embed',
            '`/playersearch` — live online check + player profile (ban/unban/kick)',
          ].join('\n'),
        },
        {
          name: 'Server owner',
          value:
            '`/permissions` — set which roles can use Donations / Rewards / Credits / Gamerscore / Server power (owner only)',
        },
        {
          name: 'Feature setup',
          value:
            'Run `/setup` first for the category + admin role. Admin, Chat, and Join/Leave each use a shared forum with **one thread per map**. Donation logs use their own forum. **Gamerscore Detection** uses `#gamerscore-detection`. **Server Status** refreshes every 10m; Admin/Chat every 15m; joins/leaves every 3m.',
        }
      );

    await interaction.reply({ embeds: [embed], ...EPHEMERAL });
  },
};
