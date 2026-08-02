const {
  ChannelType,
  PermissionFlagsBits,
  EmbedBuilder,
} = require('discord.js');
const { getGuild, updateGuild, listGuildIds } = require('./storage');
const { getDonations, money, getDonationCurrency } = require('./donations');
const { ensureCategory } = require('./featureSetup');
const { brandEmbed } = require('../utils/embeds');

const STATS_CHANNEL_NAME = 'donation-stats';
const CHECK_MS = 15 * 60 * 1000;
const DAILY_POST_HOUR_UTC = 23; // post "today" near end of UTC day
const MONTHLY_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000;
const TREND_DAYS = 14;

let timer = null;

function dayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function parseDayKey(key) {
  const [y, m, d] = String(key).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function formatDayLabel(key) {
  const d = parseDayKey(key);
  return d.toLocaleDateString('en-GB', {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function confirmedRecords(donations) {
  return (donations.records || []).filter(
    (r) => r.confirmed || r.status === 'received' || r.status === 'delivered'
  );
}

function recordDayKey(record) {
  const raw = record.receivedAt || record.createdAt;
  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return dayKey(d);
}

function aggregateRange(donations, startMs, endMs) {
  const byMethod = new Map();
  let total = 0;
  let count = 0;

  for (const record of confirmedRecords(donations)) {
    const raw = record.receivedAt || record.createdAt;
    const t = raw ? new Date(raw).getTime() : NaN;
    if (!Number.isFinite(t) || t < startMs || t >= endMs) continue;
    const amount = Number(record.amount) || 0;
    total += amount;
    count += 1;
    const label = record.methodLabel || record.methodId || 'Other';
    byMethod.set(label, (byMethod.get(label) || 0) + amount);
  }

  const methods = [...byMethod.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([label, amount]) => ({ label, amount }));

  return { total, count, methods };
}

function aggregateDay(donations, key) {
  const start = parseDayKey(key).getTime();
  const end = start + 24 * 60 * 60 * 1000;
  return aggregateRange(donations, start, end);
}

function methodLines(methods, symbol) {
  if (!methods.length) return ['_No confirmed donations in this period._'];
  return methods.map(
    (m) => `• **${m.label}** — ${money(m.amount, symbol)}`
  );
}

function sparkline(values) {
  const blocks = '▁▂▃▄▅▆▇█';
  if (!values.length) return '—';
  const max = Math.max(...values, 0.01);
  return values
    .map((v) => blocks[Math.min(blocks.length - 1, Math.floor((v / max) * (blocks.length - 1)))])
    .join('');
}

function trendDirection(values) {
  if (values.length < 2) return { label: 'Not enough data', delta: 0 };
  const half = Math.floor(values.length / 2);
  const older = values.slice(0, half);
  const newer = values.slice(half);
  const avg = (arr) =>
    arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  const a = avg(older);
  const b = avg(newer);
  const delta = b - a;
  if (Math.abs(delta) < 0.01) return { label: 'Flat', delta: 0 };
  if (delta > 0) return { label: 'Up', delta };
  return { label: 'Down', delta };
}

function buildDailySeries(donations, endKey, days) {
  const end = parseDayKey(endKey);
  const series = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(end.getTime() - i * 24 * 60 * 60 * 1000);
    const key = dayKey(d);
    const agg = aggregateDay(donations, key);
    series.push({
      key,
      label: d.toLocaleDateString('en-GB', {
        timeZone: 'UTC',
        day: 'numeric',
        month: 'short',
      }),
      total: agg.total,
    });
  }
  return series;
}

function chartUrl(series, title) {
  const config = {
    type: 'line',
    data: {
      labels: series.map((s) => s.label),
      datasets: [
        {
          label: 'Donations',
          data: series.map((s) => Number(s.total.toFixed(2))),
          fill: true,
          borderColor: 'rgb(46, 204, 113)',
          backgroundColor: 'rgba(46, 204, 113, 0.15)',
          tension: 0.3,
          pointRadius: 3,
        },
      ],
    },
    options: {
      plugins: {
        title: { display: true, text: title, color: '#e5e7eb' },
        legend: { display: false },
      },
      scales: {
        x: {
          ticks: { color: '#9ca3af', maxRotation: 0, autoSkip: true, maxTicksLimit: 8 },
          grid: { color: 'rgba(255,255,255,0.06)' },
        },
        y: {
          beginAtZero: true,
          ticks: { color: '#9ca3af' },
          grid: { color: 'rgba(255,255,255,0.06)' },
        },
      },
    },
  };

  const encoded = encodeURIComponent(JSON.stringify(config));
  return `https://quickchart.io/chart?w=700&h=320&bkg=%23111111&c=${encoded}`;
}

function getStatsState(guildId) {
  const guild = getGuild(guildId);
  return {
    channelId: guild.featureSetup?.donationStats?.channelId || null,
    lastDailyKey: guild.featureSetup?.donationStats?.lastDailyKey || null,
    lastMonthlyAt: guild.featureSetup?.donationStats?.lastMonthlyAt || null,
  };
}

function saveStatsState(guildId, patch) {
  const guild = getGuild(guildId);
  updateGuild(guildId, {
    featureSetup: {
      ...(guild.featureSetup || {}),
      donationStats: {
        ...(guild.featureSetup?.donationStats || {}),
        ...patch,
      },
    },
    features: {
      ...(guild.features || {}),
      donationStats: true,
    },
  });
}

function rememberDaySnapshot(guildId, key, agg) {
  const donations = getDonations(guildId);
  const history = [...(donations.statsHistory || [])].filter((h) => h.date !== key);
  history.push({
    date: key,
    total: Math.round(agg.total * 100) / 100,
    count: agg.count,
    byMethod: Object.fromEntries(agg.methods.map((m) => [m.label, m.amount])),
  });
  history.sort((a, b) => a.date.localeCompare(b.date));
  updateGuild(guildId, {
    donations: {
      methods: donations.methods,
      records: donations.records,
      paypal: donations.paypal,
      stripe: donations.stripe,
      statsHistory: history.slice(-120),
    },
  });
}

async function ensureDonationStatsChannel(discordGuild) {
  const me = discordGuild.members.me;
  if (!me?.permissions.has(PermissionFlagsBits.ManageChannels)) {
    throw new Error(
      'I need **Manage Channels** to create the donation-stats channel.'
    );
  }

  const guildConfig = getGuild(discordGuild.id);
  const category = await ensureCategory(
    discordGuild,
    guildConfig.featureSetup?.categoryId
  );

  updateGuild(discordGuild.id, {
    featureSetup: {
      ...(getGuild(discordGuild.id).featureSetup || {}),
      categoryId: category.id,
    },
  });

  const state = getStatsState(discordGuild.id);
  if (state.channelId) {
    const existing = await discordGuild.channels
      .fetch(state.channelId)
      .catch(() => null);
    if (existing && existing.type === ChannelType.GuildText) {
      if (!state.lastMonthlyAt) {
        saveStatsState(discordGuild.id, {
          channelId: existing.id,
          lastMonthlyAt: new Date().toISOString(),
        });
      }
      return existing;
    }
  }

  const byName = discordGuild.channels.cache.find(
    (c) =>
      c.type === ChannelType.GuildText &&
      c.parentId === category.id &&
      c.name === STATS_CHANNEL_NAME
  );
  if (byName) {
    const prev = getStatsState(discordGuild.id);
    saveStatsState(discordGuild.id, {
      channelId: byName.id,
      lastMonthlyAt: prev.lastMonthlyAt || new Date().toISOString(),
    });
    return byName;
  }

  const channel = await discordGuild.channels.create({
    name: STATS_CHANNEL_NAME,
    type: ChannelType.GuildText,
    parent: category.id,
    topic:
      'Daily donation totals by payment method, trend chart, and monthly reviews.',
    reason: 'Megapithacus donation stats',
  });

  saveStatsState(discordGuild.id, {
    channelId: channel.id,
    // Start the 30-day monthly clock when the channel is first created
    lastMonthlyAt: getStatsState(discordGuild.id).lastMonthlyAt || new Date().toISOString(),
  });
  return channel;
}

function buildDailyEmbed(guildId, key, agg, series) {
  const guild = getGuild(guildId);
  const symbol = getDonationCurrency(guildId).currencySymbol;
  const values = series.map((s) => s.total);
  const trend = trendDirection(values);
  const deltaText =
    trend.delta === 0
      ? ''
      : ` (${trend.delta > 0 ? '+' : ''}${money(trend.delta, symbol)} vs earlier half)`;

  return brandEmbed(
    new EmbedBuilder()
      .setTitle(`Daily donations · ${formatDayLabel(key)}`)
      .setDescription(
        [
          `**Made today:** ${money(agg.total, symbol)} · **${agg.count}** donation(s)`,
          `**Trend (last ${TREND_DAYS} days):** ${trend.label}${deltaText}`,
          `\`${sparkline(values)}\``,
        ].join('\n')
      )
      .addFields({
        name: 'By payment method',
        value: methodLines(agg.methods, symbol).join('\n').slice(0, 1024),
      })
      .setImage(chartUrl(series, `${TREND_DAYS}-day donation trend`)),
    guild,
    { context: 'Donation stats · UTC' }
  );
}

function buildMonthlyEmbed(guildId, startMs, endMs, current, previous) {
  const guild = getGuild(guildId);
  const symbol = getDonationCurrency(guildId).currencySymbol;
  const startLabel = new Date(startMs).toLocaleDateString('en-GB', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
  const endLabel = new Date(endMs - 1).toLocaleDateString('en-GB', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });

  const delta = current.total - previous.total;
  const deltaLabel =
    previous.total === 0 && current.total === 0
      ? 'No change'
      : previous.total === 0
        ? 'New activity'
        : `${delta >= 0 ? 'Up' : 'Down'} ${money(Math.abs(delta), symbol)} vs prior 30 days`;

  // Build 30-day series for chart
  const endKey = dayKey(new Date(endMs - 1));
  const series = buildDailySeries(getDonations(guildId), endKey, 30);

  return brandEmbed(
    new EmbedBuilder()
      .setTitle('Monthly donation review')
      .setDescription(
        [
          `**Period:** ${startLabel} → ${endLabel} (UTC)`,
          `**Total this month:** ${money(current.total, symbol)} · **${current.count}** donation(s)`,
          `**Prior 30 days:** ${money(previous.total, symbol)}`,
          `**Direction:** ${deltaLabel}`,
        ].join('\n')
      )
      .addFields({
        name: 'By payment method',
        value: methodLines(current.methods, symbol).join('\n').slice(0, 1024),
      })
      .setImage(chartUrl(series, '30-day donation trend')),
    guild,
    { context: 'Donation stats · monthly' }
  );
}

async function postDailyStats(client, guildId, key = dayKey()) {
  const discordGuild = await client.guilds.fetch(guildId).catch(() => null);
  if (!discordGuild) return { ok: false, reason: 'guild_missing' };

  let channel;
  try {
    channel = await ensureDonationStatsChannel(discordGuild);
  } catch (error) {
    return { ok: false, reason: error.message };
  }

  const donations = getDonations(guildId);
  const agg = aggregateDay(donations, key);
  const series = buildDailySeries(donations, key, TREND_DAYS);
  rememberDaySnapshot(guildId, key, agg);

  const embed = buildDailyEmbed(guildId, key, agg, series);
  await channel.send({ embeds: [embed] });
  saveStatsState(guildId, { lastDailyKey: key, channelId: channel.id });
  return { ok: true, total: agg.total };
}

async function postMonthlyReview(client, guildId, at = new Date()) {
  const discordGuild = await client.guilds.fetch(guildId).catch(() => null);
  if (!discordGuild) return { ok: false, reason: 'guild_missing' };

  let channel;
  try {
    channel = await ensureDonationStatsChannel(discordGuild);
  } catch (error) {
    return { ok: false, reason: error.message };
  }

  const endMs = at.getTime();
  const startMs = endMs - MONTHLY_INTERVAL_MS;
  const prevStart = startMs - MONTHLY_INTERVAL_MS;
  const donations = getDonations(guildId);
  const current = aggregateRange(donations, startMs, endMs);
  const previous = aggregateRange(donations, prevStart, startMs);

  const embed = buildMonthlyEmbed(guildId, startMs, endMs, current, previous);
  await channel.send({ embeds: [embed] });
  saveStatsState(guildId, {
    lastMonthlyAt: at.toISOString(),
    channelId: channel.id,
  });
  return { ok: true, total: current.total };
}

async function tickGuild(client, guildId) {
  const guild = getGuild(guildId);
  const state = getStatsState(guildId);
  if (!state.channelId && !guild.features?.donationStats) return;

  // Ensure we only post when a stats channel is configured
  if (!state.channelId) return;

  const now = new Date();
  const today = dayKey(now);

  if (
    now.getUTCHours() >= DAILY_POST_HOUR_UTC &&
    state.lastDailyKey !== today
  ) {
    await postDailyStats(client, guildId, today).catch((err) =>
      console.warn(`Donation daily stats ${guildId}:`, err.message)
    );
  }

  const lastMonthly = state.lastMonthlyAt
    ? new Date(state.lastMonthlyAt).getTime()
    : 0;

  // First monthly review after channel setup is delayed 30 days (clock starts at setup)
  if (lastMonthly && now.getTime() - lastMonthly >= MONTHLY_INTERVAL_MS) {
    await postMonthlyReview(client, guildId, now).catch((err) =>
      console.warn(`Donation monthly stats ${guildId}:`, err.message)
    );
  }
}

async function runDonationStatsTick(client) {
  for (const guildId of listGuildIds()) {
    await tickGuild(client, guildId);
  }
}

function startDonationStats(client) {
  if (timer) return;
  setTimeout(() => {
    runDonationStatsTick(client).catch((err) =>
      console.warn('Donation stats startup:', err.message)
    );
  }, 45_000);
  timer = setInterval(() => {
    runDonationStatsTick(client).catch((err) =>
      console.warn('Donation stats tick:', err.message)
    );
  }, CHECK_MS);
  console.log('Donation stats scheduler started (check every 15m)');
}

module.exports = {
  STATS_CHANNEL_NAME,
  ensureDonationStatsChannel,
  postDailyStats,
  postMonthlyReview,
  startDonationStats,
  runDonationStatsTick,
  aggregateDay,
  aggregateRange,
  buildDailySeries,
};
