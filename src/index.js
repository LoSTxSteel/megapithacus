const fs = require('fs');
const path = require('path');
const {
  Client,
  Collection,
  GatewayIntentBits,
  Partials,
} = require('discord.js');

/**
 * Cybrancee / Pterodactyl often extract zips into a nested folder, or leave
 * only index.js at /home/container. Find the real app root that contains
 * commands/ + events/.
 */
function resolveAppRoot() {
  const tried = [];
  const candidates = [__dirname];

  // One level of subdirectories (e.g. /home/container/Megapithacus)
  try {
    for (const ent of fs.readdirSync(__dirname, { withFileTypes: true })) {
      if (ent.isDirectory() && ent.name !== 'node_modules' && ent.name !== 'data') {
        candidates.push(path.join(__dirname, ent.name));
        candidates.push(path.join(__dirname, ent.name, 'src'));
      }
    }
  } catch {
    // ignore
  }

  candidates.push(path.join(__dirname, 'src'));

  for (const dir of candidates) {
    tried.push(dir);
    const commands = path.join(dir, 'commands');
    const events = path.join(dir, 'events');
    if (fs.existsSync(commands) && fs.existsSync(events)) {
      return dir;
    }
  }

  let listing = '(unable to list directory)';
  try {
    listing = fs
      .readdirSync(__dirname)
      .map((name) => {
        try {
          return fs.statSync(path.join(__dirname, name)).isDirectory()
            ? `${name}/`
            : name;
        } catch {
          return name;
        }
      })
      .join(', ');
  } catch {
    // ignore
  }

  console.error('Megapithacus could not find commands/ and events/.');
  console.error(`Looking from: ${__dirname}`);
  console.error(`Files here: ${listing}`);
  console.error('Tried:', tried.join(' | '));
  console.error(
    'Fix: extract the FULL megapithacus-cybrancee.zip into /home/container ' +
      'so you see index.js, commands/, events/, services/, package.json, and .env together.'
  );
  process.exit(1);
}

const appRoot = resolveAppRoot();
if (appRoot !== __dirname) {
  console.log(`Megapithacus: using app root ${appRoot}`);
}

// Ensure requires like ./config resolve from the app root
module.paths.unshift(appRoot);
process.chdir(appRoot);

const config = require(path.join(appRoot, 'config'));

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
  ],
  // Required so DM messageCreate / collectors work for uncached DM channels
  partials: [Partials.Channel],
});

client.commands = new Collection();

const commandsPath = path.join(appRoot, 'commands');
for (const file of fs.readdirSync(commandsPath).filter((f) => f.endsWith('.js'))) {
  const command = require(path.join(commandsPath, file));
  client.commands.set(command.data.name, command);
}

const eventsPath = path.join(appRoot, 'events');
for (const file of fs.readdirSync(eventsPath).filter((f) => f.endsWith('.js'))) {
  const event = require(path.join(eventsPath, file));
  // Skip helper modules that are not Discord event handlers
  if (!event?.name || typeof event.execute !== 'function') continue;
  if (event.once) {
    client.once(event.name, (...args) => event.execute(...args));
  } else {
    client.on(event.name, (...args) => event.execute(...args));
  }
}

client.login(config.token());
