/**
 * One-shot Discord REST slash deploy (no Client login).
 * Usage: npm run deploy
 */
const { REST, Routes } = require('discord.js');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { REQUIRED_COMMANDS } = require('./services/deploySlashCommands');

const commands = [];
const commandsPath = path.join(__dirname, 'commands');

for (const file of fs.readdirSync(commandsPath).filter((f) => f.endsWith('.js'))) {
  try {
    const command = require(path.join(commandsPath, file));
    if (!command?.data?.toJSON) {
      console.warn(`Skipping ${file}: no SlashCommandBuilder data`);
      continue;
    }
    commands.push(command.data.toJSON());
  } catch (error) {
    console.error(`Failed to load ${file}:`, error.message);
    process.exitCode = 1;
  }
}

const names = commands.map((c) => c.name).sort();
const missing = REQUIRED_COMMANDS.filter((n) => !names.includes(n));
if (missing.length) {
  console.error(`Refusing deploy — missing required commands: ${missing.join(', ')}`);
  process.exit(1);
}

const rest = new REST({ version: '10' }).setToken(config.token());

(async () => {
  try {
    console.log(`Deploying ${commands.length} slash commands: ${names.join(', ')}`);

    if (config.guildId) {
      await rest.put(
        Routes.applicationGuildCommands(config.clientId(), config.guildId),
        { body: commands }
      );
      console.log(`Deployed to guild ${config.guildId}`);
    } else {
      await rest.put(Routes.applicationCommands(config.clientId()), {
        body: commands,
      });
      console.log('Deployed globally (may take up to ~1 hour to appear)');
    }
    console.log('One-shot slash deploy OK');
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
})();
