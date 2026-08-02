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
            '`/credit` — view your seasonal & permanent credit',
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
            '• **Feature Management** — Server Status, Ban, Donation, Admin, Chat logs',
            '',
            '`/rewardmanager` — boost rewards hub (enable, channel, amount, type)',
            '`/creditmanager` — credit hub (add, remove, wipe seasonal/permanent)',
            "`/creditview` — view another user's credit balance",
            '`/servermanager` — Nitrado hub (start/stop/restart, password, name)',
            '`/donatemanage` — donation methods, links & PayPal sync',
            '`/donate` — post public donation embed',
            '`/player search` — find players (ban/unban/kick on profile)',
          ].join('\n'),
        },
        {
          name: 'Server owner',
          value:
            '`/permissions` — set which roles can use Donations / Rewards / Credits / Server power (owner only)',
        },
        {
          name: 'Feature setup',
          value:
            'Run `/setup` first for the category + admin role. Admin, Chat, and Join/Leave each use a shared forum with **one thread per map**. Donation logs use their own forum. **Server Status** refreshes every 5m; Admin/Chat every 10m; joins/leaves every 60s.',
        }
      );

    await interaction.reply({ embeds: [embed], ephemeral: true });
  },
};
