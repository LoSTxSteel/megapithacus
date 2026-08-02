const { REST, Routes } = require('discord.js');
const config = require('../config');

const REQUIRED_COMMANDS = [
  'credit',
  'creditview',
  'creditmanager',
  'rewardmanager',
  'servermanager',
];

/**
 * Push the bot's loaded slash commands to Discord (guild if configured, else global).
 * Safe to call on every ready — keeps /setup etc. in sync after deploys.
 */
async function deploySlashCommands(client) {
  const loaded = [...client.commands.values()].filter((c) => c?.data?.toJSON);
  const commands = loaded.map((c) => c.data.toJSON());
  const names = commands.map((c) => c.name).sort();

  if (!commands.length) {
    console.warn('Slash deploy: no commands loaded');
    return { ok: false, count: 0, names: [] };
  }

  const missingRequired = REQUIRED_COMMANDS.filter((n) => !names.includes(n));
  if (missingRequired.length) {
    console.error(
      `Slash deploy: REQUIRED commands missing from loader: ${missingRequired.join(', ')}`
    );
    console.error(
      'Slash deploy: refusing to PUT — would wipe credit/reward from Discord. Fix the host code first.'
    );
    return {
      ok: false,
      count: commands.length,
      names,
      missingRequired,
      refused: true,
    };
  }

  console.log(`Slash deploy: pushing ${commands.length} command(s): ${names.join(', ')}`);

  const rest = new REST({ version: '10' }).setToken(config.token());
  const clientId = config.clientId();
  const guildId = config.guildId;

  try {
    if (guildId) {
      await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
        body: commands,
      });
      console.log(`Slash commands deployed to guild ${guildId} (${commands.length})`);
    } else {
      await rest.put(Routes.applicationCommands(clientId), { body: commands });
      console.log(`Slash commands deployed globally (${commands.length})`);
    }
  } catch (error) {
    console.error('Slash deploy REST failed:', error.message);
    if (error.rawError) {
      console.error('Slash deploy details:', JSON.stringify(error.rawError));
    }
    throw error;
  }

  return { ok: true, count: commands.length, names, guildId: guildId || null };
}

module.exports = { deploySlashCommands, REQUIRED_COMMANDS };
