const { getGuild, updateGuild } = require('./storage');

function defaultAdminPay() {
  return {
    currencySymbol: '£',
    ticketPayAmount: 0,
    eventHostPayAmount: 0,
    payRoleIds: [],
    ledger: [],
    payoutRequests: [],
  };
}

function newId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function parseMoney(value) {
  const n = Number(String(value ?? '').trim().replace(/,/g, ''));
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100) / 100;
}

function isLegacyAdminPay(raw) {
  if (!raw || typeof raw !== 'object') return false;
  if (Array.isArray(raw.staff)) return true;
  if (raw.boardChannelId || raw.boardMessageId) return true;
  if (raw.rates && typeof raw.rates === 'object' && !('ticketPayAmount' in raw)) {
    return true;
  }
  return false;
}

function normalizeAdminPay(raw) {
  const defaults = defaultAdminPay();
  if (!raw || typeof raw !== 'object' || isLegacyAdminPay(raw)) {
    const currency =
      raw?.currencySymbol && String(raw.currencySymbol).trim()
        ? String(raw.currencySymbol).trim().slice(0, 8)
        : defaults.currencySymbol;
    return { ...defaults, currencySymbol: currency };
  }

  const ticket = Number(raw.ticketPayAmount);
  const eventHost = Number(raw.eventHostPayAmount);

  return {
    currencySymbol:
      raw.currencySymbol && String(raw.currencySymbol).trim()
        ? String(raw.currencySymbol).trim().slice(0, 8)
        : defaults.currencySymbol,
    ticketPayAmount:
      Number.isFinite(ticket) && ticket >= 0 ? Math.round(ticket * 100) / 100 : 0,
    eventHostPayAmount:
      Number.isFinite(eventHost) && eventHost >= 0
        ? Math.round(eventHost * 100) / 100
        : 0,
    payRoleIds: [...new Set((raw.payRoleIds || []).map(String))].slice(0, 15),
    ledger: Array.isArray(raw.ledger) ? raw.ledger : [],
    payoutRequests: Array.isArray(raw.payoutRequests) ? raw.payoutRequests : [],
  };
}

function getAdminPay(guildId) {
  return normalizeAdminPay(getGuild(guildId).adminPay);
}

function saveAdminPay(guildId, pay) {
  updateGuild(guildId, { adminPay: normalizeAdminPay(pay) });
  return getAdminPay(guildId);
}

function money(pay, amount) {
  const symbol = pay?.currencySymbol || '£';
  const n = Number(amount) || 0;
  const formatted = Number.isInteger(n) ? String(n) : n.toFixed(2);
  return `${symbol}${formatted}`;
}

/**
 * Ledger-based balance:
 * credits (event/ticket/adjustment) − paid payouts − pending payout requests.
 */
function getUserBalance(guildId, userId) {
  const pay = getAdminPay(guildId);
  const uid = String(userId);
  let earned = 0;
  let paidOut = 0;

  for (const entry of pay.ledger) {
    if (String(entry.userId) !== uid) continue;
    const amount = Number(entry.amount) || 0;
    if (entry.type === 'event' || entry.type === 'ticket' || entry.type === 'adjustment') {
      earned += amount;
    } else if (entry.type === 'payout') {
      const status = entry.status || 'paid';
      if (status === 'paid' || status === 'approved') {
        paidOut += Math.abs(amount);
      }
    }
  }

  let pending = 0;
  for (const req of pay.payoutRequests) {
    if (String(req.userId) !== uid) continue;
    if (req.status === 'pending') {
      pending += Math.abs(Number(req.amount) || 0);
    }
  }

  const balance = Math.round((earned - paidOut) * 100) / 100;
  const available = Math.round((balance - pending) * 100) / 100;

  return {
    earned: Math.round(earned * 100) / 100,
    paidOut: Math.round(paidOut * 100) / 100,
    pending: Math.round(pending * 100) / 100,
    balance,
    available: Math.max(0, available),
  };
}

function setTicketPayAmount(guildId, amountRaw) {
  const amount = parseMoney(amountRaw);
  if (amount == null) return { ok: false, error: 'Enter a valid non-negative amount.' };
  const pay = getAdminPay(guildId);
  pay.ticketPayAmount = amount;
  saveAdminPay(guildId, pay);
  return { ok: true, amount, pay: getAdminPay(guildId) };
}

function setEventHostPayAmount(guildId, amountRaw) {
  const amount = parseMoney(amountRaw);
  if (amount == null) return { ok: false, error: 'Enter a valid non-negative amount.' };
  const pay = getAdminPay(guildId);
  pay.eventHostPayAmount = amount;
  saveAdminPay(guildId, pay);
  return { ok: true, amount, pay: getAdminPay(guildId) };
}

function setPayRoleIds(guildId, roleIds) {
  const pay = getAdminPay(guildId);
  pay.payRoleIds = [...new Set((roleIds || []).map(String))].slice(0, 15);
  saveAdminPay(guildId, pay);
  return { ok: true, pay: getAdminPay(guildId) };
}

function logEventHost(guildId, userId, { note = null, date = null } = {}) {
  const pay = getAdminPay(guildId);
  if (!(pay.eventHostPayAmount > 0)) {
    return {
      ok: false,
      error: 'Event hosting pay is not configured yet. A manager must set it in `/adminpay`.',
    };
  }

  const entry = {
    id: newId(),
    userId: String(userId),
    type: 'event',
    amount: pay.eventHostPayAmount,
    note: note ? String(note).trim().slice(0, 200) : null,
    date: date ? String(date).trim().slice(0, 40) : null,
    createdAt: new Date().toISOString(),
  };
  pay.ledger.push(entry);
  saveAdminPay(guildId, pay);
  return {
    ok: true,
    entry,
    balance: getUserBalance(guildId, userId),
    pay: getAdminPay(guildId),
  };
}

function logTicketWork(guildId, userId, { note = null } = {}) {
  const pay = getAdminPay(guildId);
  if (!(pay.ticketPayAmount > 0)) {
    return {
      ok: false,
      error:
        'Ticket system pay is not configured yet. A manager must set it in `/adminpay` (for when tickets are set up).',
    };
  }

  const entry = {
    id: newId(),
    userId: String(userId),
    type: 'ticket',
    amount: pay.ticketPayAmount,
    note: note ? String(note).trim().slice(0, 200) : null,
    createdAt: new Date().toISOString(),
  };
  pay.ledger.push(entry);
  saveAdminPay(guildId, pay);
  return {
    ok: true,
    entry,
    balance: getUserBalance(guildId, userId),
    pay: getAdminPay(guildId),
  };
}

function createPayoutRequest(guildId, userId, amountRaw, note = null) {
  const amount = parseMoney(amountRaw);
  if (amount == null || amount <= 0) {
    return { ok: false, error: 'Enter a valid payout amount greater than 0.' };
  }

  const balances = getUserBalance(guildId, userId);
  if (amount > balances.available + 1e-9) {
    return {
      ok: false,
      error: `You only have ${money(getAdminPay(guildId), balances.available)} available to request.`,
    };
  }

  const pay = getAdminPay(guildId);
  const request = {
    id: newId(),
    userId: String(userId),
    amount,
    note: note ? String(note).trim().slice(0, 200) : null,
    createdAt: new Date().toISOString(),
    status: 'pending',
  };
  pay.payoutRequests.push(request);
  saveAdminPay(guildId, pay);
  return {
    ok: true,
    request,
    balance: getUserBalance(guildId, userId),
    pay: getAdminPay(guildId),
  };
}

function listPendingPayouts(guildId) {
  return getAdminPay(guildId).payoutRequests.filter((r) => r.status === 'pending');
}

function approvePayoutRequest(guildId, requestId, reviewerId = null) {
  const pay = getAdminPay(guildId);
  const request = pay.payoutRequests.find((r) => r.id === requestId);
  if (!request) return { ok: false, error: 'Payout request not found.' };
  if (request.status !== 'pending') {
    return { ok: false, error: `Request is already ${request.status}.` };
  }

  request.status = 'approved';
  request.reviewedAt = new Date().toISOString();
  request.reviewedBy = reviewerId ? String(reviewerId) : null;

  pay.ledger.push({
    id: newId(),
    userId: String(request.userId),
    type: 'payout',
    amount: Math.abs(Number(request.amount) || 0),
    note: request.note || 'Payout approved',
    createdAt: new Date().toISOString(),
    status: 'paid',
    requestId: request.id,
  });

  saveAdminPay(guildId, pay);
  return {
    ok: true,
    request,
    balance: getUserBalance(guildId, request.userId),
    pay: getAdminPay(guildId),
  };
}

function denyPayoutRequest(guildId, requestId, reviewerId = null) {
  const pay = getAdminPay(guildId);
  const request = pay.payoutRequests.find((r) => r.id === requestId);
  if (!request) return { ok: false, error: 'Payout request not found.' };
  if (request.status !== 'pending') {
    return { ok: false, error: `Request is already ${request.status}.` };
  }

  request.status = 'denied';
  request.reviewedAt = new Date().toISOString();
  request.reviewedBy = reviewerId ? String(reviewerId) : null;
  saveAdminPay(guildId, pay);
  return {
    ok: true,
    request,
    balance: getUserBalance(guildId, request.userId),
    pay: getAdminPay(guildId),
  };
}

function formatPayRoles(guildId) {
  const roles = getAdminPay(guildId).payRoleIds || [];
  if (!roles.length) return '_None — only Manage Server / bot setup role can use `/pay`._';
  return roles.map((id) => `<@&${id}>`).join(', ');
}

function configSummary(guildId) {
  const pay = getAdminPay(guildId);
  const pending = listPendingPayouts(guildId).length;
  return [
    `Currency: \`${pay.currencySymbol}\``,
    `Ticket system pay: **${money(pay, pay.ticketPayAmount)}** _(when ticket system is set up)_`,
    `Event hosting pay: **${money(pay, pay.eventHostPayAmount)}** per event`,
    `\`/pay\` roles: ${formatPayRoles(guildId)}`,
    `Pending payout requests: **${pending}**`,
  ].join('\n');
}

module.exports = {
  defaultAdminPay,
  normalizeAdminPay,
  getAdminPay,
  saveAdminPay,
  money,
  getUserBalance,
  setTicketPayAmount,
  setEventHostPayAmount,
  setPayRoleIds,
  logEventHost,
  logTicketWork,
  createPayoutRequest,
  listPendingPayouts,
  approvePayoutRequest,
  denyPayoutRequest,
  formatPayRoles,
  configSummary,
  parseMoney,
};
