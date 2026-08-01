const { REST, Routes } = require('discord.js');
const fs = require('fs');
const path = require('path');
const config = require('./config');

const commands = [];
const commandsPath = path.join(__dirname, 'commands');

for (const file of fs.readdirSync(commandsPath).filter((f) => f.endsWith('.js'))) {
  const command = require(path.join(commandsPath, file));
  commands.push(command.data.toJSON());
}

const rest = new REST({ version: '10' }).setToken(config.token());

(async () => {
  try {
    console.log(`Deploying ${commands.length} slash commands...`);

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
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
})();
