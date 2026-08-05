const { EmbedBuilder } = require('discord.js');
const {
  fetchGameLogText,
  tokenForServer,
  extractMapName,
  getCachedStatusResult,
  isFileServerRateLimited,
  getGuildClusterSnapshot,
} = require('./nitrado');
const { enrichPlayersFromChatLogs } = require('./playerDb');
const { brandEmbed } = require('../utils/embeds');
const { brand } = require('../config');

const ADMIN_LOG_COLOR = 0x9b59b6;
const ADMIN_GROUP_WINDOW_MS = 60_000;
/** Matches logBoards scheduler — next-update countdown uses this interval. */
const LOG_BOARD_INTERVAL_MS = 12 * 60 * 1000;
/** Reserve room for `Next update: <t:…:R> (<t:…:t>)` (+ optional fence close). */
const NEXT_UPDATE_SUFFIX_MAX = 72;
const DESC_MAX = 4096 - NEXT_UPDATE_SUFFIX_MAX;

function isChatBody(body) {
  const text = String(body || '').trim();
  if (!text || text.length < 4) return false;
  if (/tribe\s+.+,?\s*id\s*\d+/i.test(text)) return false;
  if (
    /was killed|joined this ark|left this ark|tamed a|destroyed|tribelog/i.test(
      text
    )
  ) {
    return false;
  }
  // PlayerName (TribeOrChar): message  OR  PlayerName: message
  return /^[^:]{2,64}(?:\s+\([^)]{1,64}\))?\s*:\s+\S/.test(text);
}

function isAdminLine(lower, trimmed) {
  if (
    /admincmd|admincheat|admin\s*command|logarkadmin|used\s+cheat|used\s+admin/i.test(
      lower
    )
  ) {
    return true;
  }
  // Broad cheat / spectator patterns — avoid matching ordinary chat about "cheaters"
  if (
    /(?:^|[\s:])(?:cheat|admincheat)\s+\S/i.test(trimmed) ||
    /\b(?:godmode|enablespectator|forceplayertojoin|destroyall|setadminplayer|enablescript)\b/i.test(
      lower
    )
  ) {
    return true;
  }
  // Xbox / AdminLogging broadcast style: "SERVER: Foo used cheat Bar"
  if (/\bused\s+(?:admin\s+)?cheat\b/i.test(lower)) return true;
  return false;
}

function classifyLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length < 4) return null;

  const lower = trimmed.toLowerCase();

  if (isAdminLine(lower, trimmed)) {
    return { type: 'admin', text: trimmed };
  }

  if (
    /serverchat|global\)|tribe chat|alliance chat|\(global\)|\(local\)/i.test(lower) ||
    /\bChat[:\s]/i.test(trimmed)
  ) {
    return { type: 'chat', text: trimmed };
  }

  // Gamertag: message style (avoid tribe ID / join-leave / kill system lines)
  if (
    /^\s*[^:]{2,32}:\s+.+$/.test(trimmed) &&
    !/tribe\s+.+,?\s*id\s*\d+/i.test(trimmed) &&
    !/joined this ark|left this ark|was killed|tamed a/i.test(trimmed)
  ) {
    return { type: 'chat', text: trimmed };
  }

  // Timestamp-prefixed chat (common in ShooterGame / ServerGame logs)
  const stripped = stripChatChannelPrefix(stripLogPrefixes(trimmed));
  if (stripped && stripped !== trimmed && isChatBody(stripped)) {
    return { type: 'chat', text: trimmed };
  }

  return null;
}

/** Parse ARK / ShooterGame log timestamps into a Date (treated as UTC). */
function parseArkTimestamp(line) {
  let m = String(line).match(
    /\[(\d{4})\.(\d{2})\.(\d{2})-(\d{2})\.(\d{2})\.(\d{2})(?::\d+)?\]/
  );
  if (m) {
    return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
  }

  m = String(line).match(/(\d{4})\.(\d{2})\.(\d{2})_(\d{2})\.(\d{2})\.(\d{2})/);
  if (m) {
    return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
  }

  return null;
}

function stripLogPrefixes(line) {
  return String(line)
    .replace(/^\[[^\]]+\]\s*(?:\[[^\]]+\]\s*)?/, '')
    .replace(/^\d{4}\.\d{2}\.\d{2}_\d{2}\.\d{2}\.\d{2}:\s*/, '')
    .trim();
}

function parseAdminFields(line) {
  const atDate = parseArkTimestamp(line) || new Date();
  let adminName = 'Unknown';
  let command = stripLogPrefixes(line);

  // Classic ASE: AdminCmd: god (PlayerName: Foo, ARKID: …, SteamID/UniqueNetId: …)
  let adminCmd = line.match(
    /AdminCmd:\s*(.+?)\s*\(\s*PlayerName:\s*([^,)]+)/i
  );
  if (!adminCmd) {
    // Some Xbox builds omit the space or use AdminCheat:
    adminCmd = line.match(
      /AdminCheat:\s*(.+?)\s*\(\s*PlayerName:\s*([^,)]+)/i
    );
  }
  if (adminCmd) {
    command = adminCmd[1].trim();
    adminName = adminCmd[2].trim();
  } else {
    const playerName = line.match(/PlayerName:\s*([^,)]+)/i);
    if (playerName) adminName = playerName[1].trim();

    // "Foo used cheat god" / "Foo used admin cheat GodMode"
    const usedCheat = line.match(
      /(?:^|[\s:])([^\s:]{2,64}?)\s+used\s+(?:admin\s+)?cheat\s*:?\s*(.+)$/i
    );
    if (usedCheat) {
      adminName = usedCheat[1].trim();
      command = usedCheat[2].trim();
    } else {
      const cheat = line.match(/(?:admin)?cheat\s+(.+)$/i);
      if (cheat) command = cheat[1].trim();
    }
  }

  // Strip trailing id blobs left on the command when parentheses parsing failed
  command = command
    .replace(/\s*\(\s*PlayerName:.*$/i, '')
    .replace(/\s*\(\s*UniqueNetId:.*$/i, '')
    .trim();

  return {
    adminName: adminName.slice(0, 64) || 'Unknown',
    command: command.slice(0, 400) || line.slice(0, 400),
    at: atDate.toISOString(),
  };
}

function stripChatChannelPrefix(body) {
  return String(body || '')
    .replace(/^(?:serverchat|tribe chat|alliance chat)\s*:\s*/i, '')
    .replace(/^\((?:global|local|tribe|alliance)\)\s*/i, '')
    .replace(/^Chat\s*:\s*/i, '')
    .replace(/^Day\s+\d+,\s+\d{1,2}:\d{2}:\d{2}:\s*/i, '')
    .trim();
}

function parseChatFields(line) {
  const atDate = parseArkTimestamp(line) || new Date();
  let body = stripChatChannelPrefix(stripLogPrefixes(line));

  let playerName = 'Unknown';
  let tribeOrChar = null;
  let message = body;

  // PlayerName (TribeOrChar): message
  let m = body.match(/^(.{1,64}?)\s+\(([^)]{1,64})\)\s*:\s*(.+)$/);
  if (m) {
    playerName = m[1].trim();
    tribeOrChar = m[2].trim();
    message = m[3].trim();
  } else {
    m = body.match(/^([^:]{1,64}?):\s*(.+)$/);
    if (m) {
      playerName = m[1].trim();
      message = m[2].trim();
    }
  }

  return {
    playerName: playerName.slice(0, 64) || 'Unknown',
    tribeOrChar: tribeOrChar ? tribeOrChar.slice(0, 64) : null,
    message: (message || body).replace(/\r?\n/g, ' ').slice(0, 300),
    at: atDate.toISOString(),
  };
}

function parseLogText(text, mapName, serviceId) {
  const chat = [];
  const admin = [];
  if (!text) return { chat, admin };

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\u0000/g, '').trim();
    const classified = classifyLine(line);
    if (!classified) continue;

    if (classified.type === 'chat') {
      const fields = parseChatFields(classified.text);
      chat.push({
        map: mapName,
        serviceId,
        text: classified.text.slice(0, 300),
        playerName: fields.playerName,
        tribeOrChar: fields.tribeOrChar,
        message: fields.message,
        at: fields.at,
      });
      continue;
    }

    if (classified.type === 'admin') {
      const fields = parseAdminFields(classified.text);
      admin.push({
        map: mapName,
        serviceId,
        text: classified.text.slice(0, 500),
        adminName: fields.adminName,
        command: fields.command,
        at: fields.at,
      });
    }
  }

  return { chat, admin };
}

/** Stagger cluster pulls so Nitrado file_server isn't hit in a burst. */
const SERVICE_STAGGER_MS = 1500;
/** Share one pull between admin + chat boards in the same refresh cycle. */
const COLLECT_CACHE_TTL_MS = 2 * 60 * 1000;
/**
 * Only skip file_server log pulls when pop is a *fresh* confirmed 0 online.
 * Stale / unknown / rate-limited → still try (never skip forever on bad cache).
 */
const EMPTY_SKIP_MAX_AGE_MS = 8 * 60 * 1000;
/** @type {Map<string, { at: number, result?: any, promise?: Promise<any> }>} */
const collectCache = new Map();
/** Last successful parse per service — keep boards alive across 429 cooldowns. */
const lastGoodByService = new Map();
/** serviceId → ISO of last successful log fetch (even if 0 chat/admin lines). */
const lastSuccessfulFetchAt = new Map();
/** Log empty-server skip once until players return. */
const emptySkipLogged = new Set();
/** Odd streaks skip; even streaks still try (never skip every cycle forever). */
const emptySkipStreak = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Known online count for skipping file_server log pulls.
 * Uses shared cluster snapshot / status cache only — no separate queryService.
 * Returns null when unknown/stale/rate-limited (do not skip).
 * @returns {Promise<{ count: number|null, ageMs: number|null, reason: string }>}
 */
async function resolveOnlineCountForLogSkip(server, token) {
  const sid = String(server.serviceId);

  // Fresh confirmed count only (< ~8m). Never trust hour-old 0-pop cache.
  const fresh = getCachedStatusResult(sid, { maxAgeMs: EMPTY_SKIP_MAX_AGE_MS });
  if (
    fresh &&
    !fresh.playersUnknown &&
    !fresh.rateLimited &&
    Number.isFinite(Number(fresh.players))
  ) {
    const count = fresh.online ? Number(fresh.players) : 0;
    return {
      count,
      ageMs: fresh.cacheAgeMs ?? null,
      reason: count === 0 ? 'fresh_zero' : 'fresh_online',
    };
  }

  // file_server cooldown — fetchGameLogText will short-circuit; do not fake 0.
  if (token && isFileServerRateLimited(token)) {
    return { count: null, ageMs: null, reason: 'file_cooldown' };
  }

  return { count: null, ageMs: null, reason: 'unknown_or_stale' };
}

function applyEmptyServerSkip(byMap, server, serviceId, detail = '') {
  const agePart = detail ? ` ${detail}` : '';
  if (!emptySkipLogged.has(serviceId)) {
    emptySkipLogged.add(serviceId);
    console.log(
      `[gameLogs] skip logs serviceId=${serviceId} reason=fresh_zero_online${agePart}`
    );
  }

  const prev = lastGoodByService.get(serviceId);
  if (prev) {
    byMap[serviceId] = {
      ...prev,
      skippedEmpty: true,
      stale: true,
    };
    return;
  }

  byMap[serviceId] = {
    name: server.name,
    chat: [],
    admin: [],
    skippedEmpty: true,
    error: 'No players online — log pull skipped',
  };
}

async function collectPerMapLogsUncached(guild, guildId = null) {
  const byMap = {};
  const errors = [];
  const servers = guild.servers || [];

  // Warm shared status snapshot once so pop/tracker/logs share one cluster pull.
  if (guildId && servers.length && (guild.nitradoAccounts || []).length) {
    try {
      await getGuildClusterSnapshot(guild, guildId);
    } catch {
      // Continue — empty-skip may fall back to null/unknown.
    }
  }

  for (let i = 0; i < servers.length; i += 1) {
    const server = servers[i];
    if (i > 0) await sleep(SERVICE_STAGGER_MS);

    const serviceId = String(server.serviceId);
    const token = tokenForServer(server, guild);
    if (!token) {
      byMap[serviceId] = {
        name: server.name,
        chat: [],
        admin: [],
        error: 'No Nitrado token',
      };
      errors.push(`${server.name}: no token`);
      console.log(
        `[gameLogs] skip serviceId=${serviceId} reason=no_token lastOk=${
          lastSuccessfulFetchAt.get(serviceId) || 'never'
        }`
      );
      continue;
    }

    const online = await resolveOnlineCountForLogSkip(server, token);
    const onlineCount = online.count;

    if (onlineCount === 0) {
      const streak = (emptySkipStreak.get(serviceId) || 0) + 1;
      emptySkipStreak.set(serviceId, streak);
      // Skip odd cycles; force-try every other so a stuck 0 cache cannot freeze forever.
      if (streak % 2 === 1) {
        const ageMin =
          online.ageMs != null ? `age=${Math.round(online.ageMs / 60000)}m` : '';
        applyEmptyServerSkip(byMap, server, serviceId, ageMin);
        continue;
      }
      console.log(
        `[gameLogs] retry despite 0 online serviceId=${serviceId} (every-other cycle) lastOk=${
          lastSuccessfulFetchAt.get(serviceId) || 'never'
        }`
      );
    } else {
      emptySkipStreak.delete(serviceId);
      emptySkipLogged.delete(serviceId);
    }

    if (onlineCount == null) {
      console.log(
        `[gameLogs] fetch serviceId=${serviceId} online=unknown reason=${online.reason} lastOk=${
          lastSuccessfulFetchAt.get(serviceId) || 'never'
        }`
      );
    }

    try {
      const { gameserver, text, logFiles, rateLimited, skipped } =
        await fetchGameLogText(serviceId, token);

      if (rateLimited || skipped === 'rate_limited') {
        console.log(
          `[gameLogs] rate_limited serviceId=${serviceId} lastOk=${
            lastSuccessfulFetchAt.get(serviceId) || 'never'
          }`
        );
        const prev = lastGoodByService.get(serviceId);
        if (prev) {
          byMap[serviceId] = {
            ...prev,
            rateLimited: true,
            stale: true,
            error: 'Stale — Nitrado rate limited',
          };
        } else {
          byMap[serviceId] = {
            name: server.name,
            chat: [],
            admin: [],
            rateLimited: true,
            error: 'Nitrado rate limited — backing off',
          };
        }
        continue;
      }

      const mapName =
        extractMapName(gameserver, server.name) || server.name || serviceId;
      const parsed = parseLogText(text, mapName, serviceId);
      const fetchedAt = new Date().toISOString();
      lastSuccessfulFetchAt.set(serviceId, fetchedAt);
      const entry = {
        name: mapName,
        chat: parsed.chat.slice(-40),
        admin: parsed.admin.slice(-40),
        logFiles: logFiles || [],
        fetchedAt,
      };
      byMap[serviceId] = entry;
      // Always keep last-good so embeds refresh (countdown) even with 0 new lines.
      lastGoodByService.set(serviceId, { ...entry });

      console.log(
        `[gameLogs] ok serviceId=${serviceId} map=${mapName}` +
          ` chat=${parsed.chat.length} admin=${parsed.admin.length}` +
          ` files=${(logFiles || []).join(',') || 'none'}` +
          ` online=${onlineCount == null ? '?' : onlineCount}` +
          ` lastOk=${fetchedAt}`
      );

      if (guildId && parsed.chat.length) {
        const n = enrichPlayersFromChatLogs(guildId, parsed.chat, {
          serviceId,
          map: mapName,
        });
        if (n > 0) {
          console.log(
            `[gameLogs] enriched ${n} player IGN(s) from chat service=${serviceId}`
          );
        }
      }
    } catch (error) {
      console.warn(
        `[gameLogs] guild pull failed serviceId=${serviceId} map=${server.name}: ${error.message}` +
          ` lastOk=${lastSuccessfulFetchAt.get(serviceId) || 'never'}`
      );
      const prev = lastGoodByService.get(serviceId);
      if (prev && /\b429\b/.test(String(error.message || ''))) {
        byMap[serviceId] = {
          ...prev,
          rateLimited: true,
          stale: true,
          error: 'Stale — Nitrado rate limited',
        };
      } else {
        byMap[serviceId] = {
          name: server.name,
          chat: [],
          admin: [],
          error: error.message,
        };
        errors.push(`${server.name}: ${error.message}`);
      }
    }
  }

  return { byMap, errors };
}

/**
 * Collect per-map chat + in-game admin lines from Nitrado.
 * When guildId is provided, also enrich player profiles with IGNs from chat
 * (`Gamertag (CharacterName): message` on ASE Xbox).
 * Dedupes concurrent/near-concurrent pulls (admin + chat boards).
 * @returns {{ byMap: Record<string, { name, chat, admin, error? }>, errors: string[] }}
 */
async function collectPerMapLogs(guild, guildId = null) {
  const cacheKey = guildId || '_anon';
  const hit = collectCache.get(cacheKey);
  if (hit) {
    if (hit.promise) return hit.promise;
    if (hit.result && Date.now() - hit.at < COLLECT_CACHE_TTL_MS) {
      return hit.result;
    }
  }

  const promise = collectPerMapLogsUncached(guild, guildId).then((result) => {
    collectCache.set(cacheKey, { at: Date.now(), result });
    return result;
  });
  collectCache.set(cacheKey, { at: Date.now(), promise });
  try {
    return await promise;
  } catch (error) {
    collectCache.delete(cacheKey);
    throw error;
  }
}

function escapeMdBold(name) {
  return String(name || 'Unknown').replace(/[*_`~|\\]/g, '\\$&');
}

function sanitizeInlineCode(value) {
  return String(value || '')
    .replace(/`/g, "'")
    .replace(/\r?\n/g, ' ')
    .trim();
}

function unixFromIso(at) {
  if (typeof at === 'number' && Number.isFinite(at)) {
    // Accept ms or already-seconds.
    return at > 1e11 ? Math.floor(at / 1000) : Math.floor(at);
  }
  const ms = Date.parse(at);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : Math.floor(Date.now() / 1000);
}

function formatChatLine(entry) {
  const unix = unixFromIso(entry.at);
  const gamertag = entry.playerName || 'Unknown';
  const ign = entry.tribeOrChar ? String(entry.tribeOrChar).trim() : '';
  const message = String(entry.message || entry.text || '')
    .replace(/\r?\n/g, ' ')
    .trim();

  // ASE Xbox: left side is usually gamertag; parentheses is often character/IGN.
  if (ign && ign.toLowerCase() !== String(gamertag).toLowerCase()) {
    return `<t:${unix}:R> - **${escapeMdBold(ign)}** (\`${sanitizeInlineCode(
      gamertag
    )}\`) : ${message}`;
  }

  return `<t:${unix}:R> - **${escapeMdBold(gamertag)}** : ${message}`;
}

function formatChatDescription(entries, emptyMessage) {
  if (!entries.length) return emptyMessage;

  const recent = entries.slice(-40);
  const lines = [];

  for (let i = recent.length - 1; i >= 0; i--) {
    const line = formatChatLine(recent[i]);
    const next = lines.length ? `${line}\n${lines.join('\n')}` : line;
    if (next.length > DESC_MAX) break;
    lines.unshift(line);
  }

  if (!lines.length) {
    return formatChatLine(recent[recent.length - 1]).slice(0, DESC_MAX);
  }

  return lines.join('\n').slice(0, DESC_MAX);
}

function sanitizeCodeLine(cmd) {
  return String(cmd || '')
    .replace(/```/g, "'''")
    .replace(/\r?\n/g, ' ')
    .trim();
}

function groupAdminEntries(entries) {
  const groups = [];
  for (const entry of entries) {
    const adminName = entry.adminName || 'Unknown';
    const command = entry.command || entry.text || '';
    const at = entry.at || new Date().toISOString();
    const entryTs = Date.parse(at) || 0;
    const last = groups[groups.length - 1];
    const lastTs = last ? Date.parse(last.at) || 0 : 0;

    if (
      last &&
      last.adminName === adminName &&
      Math.abs(entryTs - lastTs) <= ADMIN_GROUP_WINDOW_MS
    ) {
      last.commands.push(command);
      continue;
    }

    groups.push({
      adminName,
      at,
      commands: [command],
    });
  }
  return groups;
}

function formatAdminGroup(group) {
  // Unix seconds — Discord `<t:>` ignores ms values / shows raw markup.
  const unix = unixFromIso(group.at);
  const cmds = group.commands.map(sanitizeCodeLine).filter(Boolean);
  if (!cmds.length) cmds.push('(empty)');

  // Timestamp MUST stay outside the code fence or Discord will not render it.
  const fence = cmds.length > 1 ? '```py' : '```';
  return [
    `<t:${unix}:R>`,
    `**${escapeMdBold(group.adminName)}**`,
    `${fence}\n${cmds.join('\n')}\n\`\`\``,
  ].join('\n');
}

function formatAdminDescription(entries, emptyMessage) {
  if (!entries.length) return emptyMessage;

  const groups = groupAdminEntries(entries.slice(-30));
  const blocks = [];

  for (let i = groups.length - 1; i >= 0; i--) {
    const block = formatAdminGroup(groups[i]);
    const next = blocks.length ? `${block}\n\n${blocks.join('\n\n')}` : block;
    if (next.length > DESC_MAX) break;
    blocks.unshift(block);
  }

  if (!blocks.length) {
    // Single oversized group — hard truncate
    return formatAdminGroup(groups[groups.length - 1]).slice(0, DESC_MAX);
  }

  return blocks.join('\n\n').slice(0, DESC_MAX);
}

function formatFooterStamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function buildMapLogFooter(serverName, serviceId) {
  const name = String(serverName || 'Server').slice(0, 180);
  const id = String(serviceId || '—');
  return `Server: ${name}\nID: ${id} - ${brand.name} - ${formatFooterStamp()}`;
}

/** Unix seconds for the next scheduled board refresh (Discord relative timestamp). */
function nextRefreshUnix(intervalMs = LOG_BOARD_INTERVAL_MS, fromMs = Date.now()) {
  return Math.floor((fromMs + intervalMs) / 1000);
}

/**
 * Append a live Discord relative countdown. `<t:…>` only renders in
 * description/fields (not footers), so this goes at the description end.
 * Also closes any dangling ``` so a truncated admin code block cannot
 * swallow the timestamp into a fence (where Discord shows raw markup).
 */
function withNextUpdateCountdown(description, intervalMs = LOG_BOARD_INTERVAL_MS) {
  const unix = nextRefreshUnix(intervalMs);
  // Keep both relative + short clock so the Discord timestamp is obvious.
  const suffix = `\n\nNext update: <t:${unix}:R> (<t:${unix}:t>)`;
  let body = String(description || '');
  const fenceCount = (body.match(/```/g) || []).length;
  const fenceClose = fenceCount % 2 === 1 ? '\n```' : '';
  const maxBody = Math.max(0, 4096 - fenceClose.length - suffix.length);
  return `${body.slice(0, maxBody)}${fenceClose}${suffix}`;
}

/**
 * Overseer-style Chat Logs embed for a map thread.
 */
function buildMapChatEmbed(serverName, serviceId, chatEntries, note, guild = null) {
  const empty =
    note && note !== 'OK'
      ? `_${String(note).slice(0, 200)}_`
      : '_No in-game chat lines found for this map in the latest Nitrado log pull._';

  return brandEmbed(
    new EmbedBuilder()
      .setTitle('Chat Logs')
      .setDescription(
        withNextUpdateCountdown(formatChatDescription(chatEntries || [], empty))
      ),
    guild,
    {
      color: ADMIN_LOG_COLOR,
      author: false,
      timestamp: false,
      footer: buildMapLogFooter(serverName, serviceId),
      context: 'Chat log · every 12m',
    }
  );
}

/**
 * Overseer-style Admin Logs embed for a map thread.
 */
function buildMapAdminEmbed(serverName, serviceId, gameAdminEntries, note, guild = null) {
  const empty =
    note && note !== 'OK'
      ? `_${String(note).slice(0, 200)}_`
      : '_No in-game admin commands found for this map in the latest Nitrado log pull._';

  return brandEmbed(
    new EmbedBuilder()
      .setTitle('Admin Logs')
      .setDescription(
        withNextUpdateCountdown(formatAdminDescription(gameAdminEntries || [], empty))
      ),
    guild,
    {
      color: ADMIN_LOG_COLOR,
      author: false,
      timestamp: false,
      footer: buildMapLogFooter(serverName, serviceId),
      context: 'Admin log · every 12m',
    }
  );
}

module.exports = {
  collectPerMapLogs,
  buildMapChatEmbed,
  buildMapAdminEmbed,
  parseLogText,
  parseAdminFields,
  parseChatFields,
  groupAdminEntries,
  nextRefreshUnix,
  withNextUpdateCountdown,
  ADMIN_LOG_COLOR,
  LOG_BOARD_INTERVAL_MS,
};
