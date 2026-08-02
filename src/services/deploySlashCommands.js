const { REST, Routes } = require('discord.js');
const config = require('../config');

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
    return { ok: false, count: 0 };
  }

  console.log(`Slash deploy: pushing ${commands.length} command(s): ${names.join(', ')}`);

  const rest = new REST({ version: '10' }).setToken(config.token());
  const clientId = config.clientId();
  const guildId = config.guildId;

  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
      body: commands,
    });
    console.log(`Slash commands deployed to guild ${guildId} (${commands.length})`);
  } else {
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
    console.log(`Slash commands deployed globally (${commands.length})`);
  }

  return { ok: true, count: commands.length, names, guildId: guildId || null };
}

module.exports = { deploySlashCommands };
