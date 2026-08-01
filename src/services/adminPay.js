const { getGuild, updateGuild } = require('./storage');

/** Legacy rate units (no shifts). Used only if older roster entries still have rates. */
const RATE_UNITS = [
  { value: 'hour', label: 'Per hour' },
  { value: 'day', label: 'Per day' },
  { value: 'week', label: 'Per week' },
  { value: 'month', label: 'Per month' },
];

/** Payout methods staff must choose when requesting pay. */
const PAYMENT_METHODS = [
  {
    value: 'paypal',
    label: 'PayPal',
    description: 'Paid to your PayPal account',
  },
  {
    value: 'bank_uk',
    label: 'Bank transfer (UK only)',
    description: 'UK sort code + account number',
  },
  {
    value: 'giftcard',
    label: 'Gift card',
    description: 'Digital gift card payout',
  },
];

function getPaymentMethod(value) {
  return PAYMENT_METHODS.find((m) => m.value === value) || null;
}

/**
 * Built-in work activities for the pay board.
 * More types (e.g. completed ticket) can be added later.
 */
const DEFAULT_ACTIVITIES = [
  {
    value: 'discord_event',
    label: 'Discord event',
    description: 'Hosted or ran a Discord event',
    amount: 10,
    enabled: true,
  },
  {
    value: 'ingame_event',
    label: 'In-game event',
    description: 'Hosted or ran an in-game event',
    amount: 15,
    enabled: true,
  },
];

function defaultAdminPay() {
  return {
    currency: 'GBP',
    currencySymbol: '£',
    staff: [],
    ledger: [],
    requests: [],
    activities: DEFAULT_ACTIVITIES.map((a) => ({ ...a })),
  };
}

function mergeActivities(stored) {
  const byValue = new Map(
    (stored || []).map((a) => [a.value, { ...a }])
  );
  // Ensure defaults exist; keep custom amounts/enabled from storage
  for (const def of DEFAULT_ACTIVITIES) {
    if (!byValue.has(def.value)) {
      byValue.set(def.value, { ...def });
    } else {
      const cur = byValue.get(def.value);
      byValue.set(def.value, {
        ...def,
        ...cur,
        value: def.value,
        label: cur.label || def.label,
        description: cur.description || def.description,
        amount: Number.isFinite(Number(cur.amount)) ? Number(cur.amount) : def.amount,
        enabled: cur.enabled !== false,
      });
    }
  }
  return [...byValue.values()];
}

function getAdminPay(guildId) {
  const guild = getGuild(guildId);
  const base = {
    ...defaultAdminPay(),
    ...(guild.adminPay || {}),
    staff: [...(guild.adminPay?.staff || [])],
    ledger: [...(guild.adminPay?.ledger || [])],
    requests: [...(guild.adminPay?.requests || [])],
  };
  base.activities = mergeActivities(guild.adminPay?.activities);
  return base;
}

function saveAdminPay(guildId, adminPay) {
  updateGuild(guildId, { adminPay });
  return getAdminPay(guildId);
}

function newId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function money(adminPay, amount) {
  const n = Number(amount) || 0;
  const sym = adminPay.currencySymbol || '£';
  return `${sym}${n.toFixed(2)}`;
}

function findStaff(adminPay, userId) {
  return adminPay.staff.find((s) => s.userId === userId) || null;
}

function getActivity(adminPay, value) {
  return (adminPay.activities || []).find((a) => a.value === value) || null;
}

function listEnabledActivities(adminPay) {
  return (adminPay.activities || []).filter((a) => a.enabled !== false);
}

function setCurrency(guildId, { currency, currencySymbol }) {
  const pay = getAdminPay(guildId);
  pay.currency = String(currency || pay.currency || 'GBP')
    .trim()
    .toUpperCase()
    .slice(0, 8);
  pay.currencySymbol = String(currencySymbol || pay.currencySymbol || '£')
    .trim()
    .slice(0, 4);
  return saveAdminPay(guildId, pay);
}

function setActivityAmount(guildId, activityValue, amount) {
  const pay = getAdminPay(guildId);
  const activity = getActivity(pay, activityValue);
  if (!activity) return { ok: false, error: 'Unknown activity type.' };
  const value = Number(amount);
  if (!Number.isFinite(value) || value < 0) {
    return { ok: false, error: 'Amount must be a number ≥ 0.' };
  }
  activity.amount = Math.round(value * 100) / 100;
  saveAdminPay(guildId, pay);
  return { ok: true, activity: getActivity(getAdminPay(guildId), activityValue) };
}

/**
 * Add someone to the payroll roster (no hourly/shift rates — pay is per activity).
 */
function upsertStaff(guildId, { userId, label }) {
  const pay = getAdminPay(guildId);
  const existing = findStaff(pay, userId);
  if (!userId) return { ok: false, error: 'Missing user.' };

  if (existing) {
    if (label !== undefined) existing.label = label ? String(label).slice(0, 64) : null;
  } else {
    pay.staff.push({
      userId: String(userId),
      label: label ? String(label).slice(0, 64) : null,
      balance: 0,
      totalEarned: 0,
      totalPaid: 0,
      addedAt: new Date().toISOString(),
    });
  }

  saveAdminPay(guildId, pay);
  return { ok: true, staff: findStaff(getAdminPay(guildId), userId) };
}

function removeStaff(guildId, userId) {
  const pay = getAdminPay(guildId);
  const before = pay.staff.length;
  pay.staff = pay.staff.filter((s) => s.userId !== userId);
  saveAdminPay(guildId, pay);
  return before !== pay.staff.length;
}

function addLedgerEntry(pay, entry) {
  pay.ledger.unshift({
    id: newId(),
    at: new Date().toISOString(),
    ...entry,
  });
  pay.ledger = pay.ledger.slice(0, 200);
}

/**
 * Validate event request fields without saving.
 */
function validateEventRequest(guildId, {
  userId,
  activityValue,
  hostedAt,
  attendance,
}) {
  const pay = getAdminPay(guildId);
  const staff = findStaff(pay, userId);
  if (!staff) {
    return {
      ok: false,
      error: 'You are not on the pay roster. Ask a manager to add you with `/adminpay manage`.',
    };
  }

  const activity = getActivity(pay, activityValue);
  if (!activity || activity.enabled === false) {
    return { ok: false, error: 'That event type is not available.' };
  }

  const hosted = String(hostedAt || '').trim();
  if (!hosted || hosted.length < 3) {
    return { ok: false, error: 'Enter when the event was hosted (date and time).' };
  }

  const attendees = Number(attendance);
  if (!Number.isFinite(attendees) || attendees < 0 || !Number.isInteger(attendees)) {
    return { ok: false, error: 'Attendance must be a whole number (0 or more).' };
  }

  return {
    ok: true,
    pay,
    staff,
    activity,
    hosted: hosted.slice(0, 100),
    attendance: attendees,
    amount: Math.round(Number(activity.amount) * 100) / 100,
  };
}

/**
 * Log a completed event — pending until a manager approves (then credits balance).
 */
function createEventRequest(guildId, {
  userId,
  activityValue,
  hostedAt,
  attendance,
  note,
  byTag,
  photos,
}) {
  const checked = validateEventRequest(guildId, {
    userId,
    activityValue,
    hostedAt,
    attendance,
  });
  if (!checked.ok) return checked;

  const pay = checked.pay;
  const photoList = Array.isArray(photos)
    ? photos
        .filter((p) => p && p.url)
        .slice(0, 5)
        .map((p) => ({
          url: String(p.url),
          name: p.name ? String(p.name).slice(0, 100) : null,
        }))
    : [];
  const request = {
    id: newId(),
    kind: 'event',
    guildId,
    userId: String(userId),
    activity: checked.activity.value,
    activityLabel: checked.activity.label,
    amount: checked.amount,
    hostedAt: checked.hosted,
    attendance: checked.attendance,
    note: note ? String(note).trim().slice(0, 200) : null,
    photos: photoList,
    status: 'pending',
    byTag: byTag || null,
    createdAt: new Date().toISOString(),
    reviewedBy: null,
    reviewedAt: null,
  };

  pay.requests = [request, ...(pay.requests || [])].slice(0, 300);
  saveAdminPay(guildId, pay);
  return { ok: true, request, activity: checked.activity };
}

/** @deprecated alias — use createEventRequest */
function createPayRequest(guildId, fields) {
  return createEventRequest(guildId, fields);
}

/**
 * Request a payout of owed balance — pending until a manager approves.
 */
function createPayoutRequest(guildId, {
  userId,
  amount,
  note,
  byTag,
  paymentMethod,
  paymentDetails,
}) {
  const pay = getAdminPay(guildId);
  const staff = findStaff(pay, userId);
  if (!staff) {
    return {
      ok: false,
      error: 'You are not on the pay roster. Ask a manager to add you with `/adminpay manage`.',
    };
  }

  if (staff.balance <= 0) {
    return { ok: false, error: 'You have no owed balance to request pay for.' };
  }

  const method = getPaymentMethod(paymentMethod);
  if (!method) {
    return {
      ok: false,
      error: 'Choose a payment method: PayPal, Bank transfer (UK only), or Gift card.',
    };
  }

  const details = normalizePaymentDetails(method.value, paymentDetails);
  if (!details.ok) return details;

  let value =
    amount == null || String(amount).trim() === ''
      ? staff.balance
      : Number(amount);
  if (!Number.isFinite(value) || value <= 0) {
    return { ok: false, error: 'Enter a payout amount greater than 0.' };
  }
  value = Math.round(value * 100) / 100;
  if (value > staff.balance + 0.001) {
    return {
      ok: false,
      error: `Cannot request more than your balance (${money(pay, staff.balance)}).`,
    };
  }

  const request = {
    id: newId(),
    kind: 'payout',
    guildId,
    userId: String(userId),
    amount: value,
    balanceAtRequest: staff.balance,
    paymentMethod: method.value,
    paymentMethodLabel: method.label,
    paymentDetails: details.data,
    note: note ? String(note).trim().slice(0, 200) : null,
    status: 'pending',
    byTag: byTag || null,
    createdAt: new Date().toISOString(),
    reviewedBy: null,
    reviewedAt: null,
  };

  pay.requests = [request, ...(pay.requests || [])].slice(0, 300);
  saveAdminPay(guildId, pay);
  return { ok: true, request };
}

function normalizePaymentDetails(method, raw = {}) {
  if (method === 'paypal') {
    const email = String(raw.paypalEmail || '').trim();
    if (!email || email.length < 5 || !email.includes('@')) {
      return { ok: false, error: 'Enter a valid PayPal email address.' };
    }
    return {
      ok: true,
      data: { paypalEmail: email.slice(0, 120) },
    };
  }

  if (method === 'bank_uk') {
    const accountName = String(raw.accountName || '').trim();
    const sortCode = String(raw.sortCode || '')
      .trim()
      .replace(/\s+/g, '');
    const accountNumber = String(raw.accountNumber || '')
      .trim()
      .replace(/\s+/g, '');

    if (!accountName || accountName.length < 2) {
      return { ok: false, error: 'Enter the UK account name.' };
    }
    const sortDigits = sortCode.replace(/-/g, '');
    if (!/^\d{6}$/.test(sortDigits)) {
      return {
        ok: false,
        error: 'Enter a valid UK sort code (6 digits, e.g. 12-34-56).',
      };
    }
    if (!/^\d{8}$/.test(accountNumber)) {
      return {
        ok: false,
        error: 'Enter a valid UK account number (8 digits).',
      };
    }

    const formattedSort = `${sortDigits.slice(0, 2)}-${sortDigits.slice(
      2,
      4
    )}-${sortDigits.slice(4, 6)}`;

    return {
      ok: true,
      data: {
        accountName: accountName.slice(0, 80),
        sortCode: formattedSort,
        accountNumber,
      },
    };
  }

  if (method === 'giftcard') {
    const giftcardType = String(raw.giftcardType || '').trim();
    const email = String(raw.giftcardEmail || '').trim();
    if (!giftcardType || giftcardType.length < 2) {
      return {
        ok: false,
        error: 'Enter the gift card type (e.g. Amazon UK, Steam).',
      };
    }
    if (!email || email.length < 5 || !email.includes('@')) {
      return {
        ok: false,
        error: 'Enter the email address to receive the gift card.',
      };
    }
    return {
      ok: true,
      data: {
        giftcardType: giftcardType.slice(0, 80),
        giftcardEmail: email.slice(0, 120),
      },
    };
  }

  return { ok: false, error: 'Unknown payment method.' };
}

function formatPaymentDetails(request) {
  const method = request.paymentMethod || '';
  const d = request.paymentDetails || {};
  if (method === 'paypal') {
    return [`PayPal: \`${d.paypalEmail || '—'}\``];
  }
  if (method === 'bank_uk') {
    return [
      `Account name: **${d.accountName || '—'}**`,
      `Sort code: \`${d.sortCode || '—'}\``,
      `Account number: \`${d.accountNumber || '—'}\``,
    ];
  }
  if (method === 'giftcard') {
    return [
      `Gift card: **${d.giftcardType || '—'}**`,
      `Send to: \`${d.giftcardEmail || '—'}\``,
    ];
  }
  return ['_No payment details_'];
}

function getPayRequest(guildId, requestId) {
  return getAdminPay(guildId).requests.find((r) => r.id === requestId) || null;
}

/**
 * Approve a pending event (credit work) or payout request.
 */
function approvePayRequest(guildId, requestId, { reviewerId, reviewerTag }) {
  const pay = getAdminPay(guildId);
  const request = pay.requests.find((r) => r.id === requestId);
  if (!request) return { ok: false, error: 'Request not found.' };
  if (request.status !== 'pending') {
    return { ok: false, error: `This request is already **${request.status}**.` };
  }

  const staff = findStaff(pay, request.userId);
  if (!staff) {
    return { ok: false, error: 'That admin is no longer on the pay roster.' };
  }

  const kind = request.kind || 'event';

  if (kind === 'payout') {
    let value = Math.round(Number(request.amount) * 100) / 100;
    if (!Number.isFinite(value) || value <= 0) {
      return { ok: false, error: 'Invalid payout amount on this request.' };
    }
    if (value > staff.balance + 0.001) {
      return {
        ok: false,
        error: `Balance is now only ${money(pay, staff.balance)} — cannot approve this payout.`,
      };
    }

    staff.balance = Math.round((staff.balance - value) * 100) / 100;
    staff.totalPaid = Math.round((staff.totalPaid + value) * 100) / 100;
    request.status = 'approved';
    request.reviewedBy = reviewerId;
    request.reviewedAt = new Date().toISOString();

    const ledgerEntry = {
      type: 'payout',
      userId: request.userId,
      amount: value,
      balanceAfter: staff.balance,
      note: request.note,
      paymentMethod: request.paymentMethod,
      paymentMethodLabel: request.paymentMethodLabel,
      paymentDetails: request.paymentDetails,
      requestId: request.id,
      byId: reviewerId,
      byTag: reviewerTag,
    };
    addLedgerEntry(pay, ledgerEntry);
    saveAdminPay(guildId, pay);

    return {
      ok: true,
      request: getPayRequest(guildId, requestId),
      amount: value,
      balance: staff.balance,
      entry: ledgerEntry,
    };
  }

  // Event log → credit activity amount
  const amount = Math.round(Number(request.amount) * 100) / 100;
  staff.balance = Math.round((staff.balance + amount) * 100) / 100;
  staff.totalEarned = Math.round((staff.totalEarned + amount) * 100) / 100;

  request.status = 'approved';
  request.reviewedBy = reviewerId;
  request.reviewedAt = new Date().toISOString();

  const ledgerEntry = {
    type: 'work',
    userId: request.userId,
    activity: request.activity,
    activityLabel: request.activityLabel,
    amount,
    balanceAfter: staff.balance,
    hostedAt: request.hostedAt,
    attendance: request.attendance,
    note: request.note,
    requestId: request.id,
    byId: reviewerId,
    byTag: reviewerTag,
  };
  addLedgerEntry(pay, ledgerEntry);
  saveAdminPay(guildId, pay);

  return {
    ok: true,
    request: getPayRequest(guildId, requestId),
    amount,
    balance: staff.balance,
    entry: ledgerEntry,
  };
}

function denyPayRequest(guildId, requestId, { reviewerId, reviewerTag, reason }) {
  const pay = getAdminPay(guildId);
  const request = pay.requests.find((r) => r.id === requestId);
  if (!request) return { ok: false, error: 'Pay request not found.' };
  if (request.status !== 'pending') {
    return { ok: false, error: `This request is already **${request.status}**.` };
  }

  request.status = 'denied';
  request.reviewedBy = reviewerId;
  request.reviewedAt = new Date().toISOString();
  request.denyReason = reason ? String(reason).slice(0, 200) : null;
  saveAdminPay(guildId, pay);

  return { ok: true, request: getPayRequest(guildId, requestId) };
}

function addCredit(guildId, { userId, amount, note, byId, byTag }) {
  const pay = getAdminPay(guildId);
  const staff = findStaff(pay, userId);
  if (!staff) return { ok: false, error: 'That user is not on the pay roster.' };

  const value = Number(amount);
  if (!Number.isFinite(value) || value === 0) {
    return { ok: false, error: 'Enter a non-zero amount.' };
  }

  staff.balance = Math.round((staff.balance + value) * 100) / 100;
  if (value > 0) {
    staff.totalEarned = Math.round((staff.totalEarned + value) * 100) / 100;
  }

  const ledgerEntry = {
    type: value > 0 ? 'credit' : 'deduction',
    userId,
    amount: value,
    balanceAfter: staff.balance,
    note: note || null,
    byId,
    byTag,
  };
  addLedgerEntry(pay, ledgerEntry);
  saveAdminPay(guildId, pay);

  return {
    ok: true,
    amount: value,
    balance: staff.balance,
    staff: findStaff(getAdminPay(guildId), userId),
    entry: ledgerEntry,
  };
}

function recordPayout(guildId, { userId, amount, note, byId, byTag }) {
  const pay = getAdminPay(guildId);
  const staff = findStaff(pay, userId);
  if (!staff) return { ok: false, error: 'That user is not on the pay roster.' };

  let value = amount == null || amount === '' ? staff.balance : Number(amount);
  if (!Number.isFinite(value) || value <= 0) {
    return { ok: false, error: 'Payout amount must be greater than 0.' };
  }
  if (value > staff.balance + 0.001) {
    return {
      ok: false,
      error: `Cannot pay more than balance (${money(pay, staff.balance)}).`,
    };
  }

  value = Math.round(value * 100) / 100;
  staff.balance = Math.round((staff.balance - value) * 100) / 100;
  staff.totalPaid = Math.round((staff.totalPaid + value) * 100) / 100;

  const ledgerEntry = {
    type: 'payout',
    userId,
    amount: value,
    balanceAfter: staff.balance,
    note: note || null,
    byId,
    byTag,
  };
  addLedgerEntry(pay, ledgerEntry);
  saveAdminPay(guildId, pay);

  return {
    ok: true,
    amount: value,
    balance: staff.balance,
    staff: findStaff(getAdminPay(guildId), userId),
    entry: ledgerEntry,
  };
}

function staffSummaryLines(adminPay) {
  if (!adminPay.staff.length) return ['_No paid admins on the roster yet._'];
  return adminPay.staff.map((s) => {
    const tag = s.label ? ` (${s.label})` : '';
    return `• <@${s.userId}>${tag} — owed **${money(
      adminPay,
      s.balance
    )}** · paid **${money(adminPay, s.totalPaid)}**`;
  });
}

function activitySummaryLines(adminPay) {
  const list = listEnabledActivities(adminPay);
  if (!list.length) return ['_No activities enabled._'];
  return list.map(
    (a) => `• **${a.label}** — **${money(adminPay, a.amount)}**`
  );
}

function ledgerSummaryLines(adminPay, limit = 8) {
  if (!adminPay.ledger.length) return ['_No pay ledger entries yet._'];
  return adminPay.ledger.slice(0, limit).map((e) => {
    const when = `<t:${Math.floor(new Date(e.at).getTime() / 1000)}:R>`;
    if (e.type === 'work') {
      const label = e.activityLabel || e.activity || 'activity';
      return `• ${when} <@${e.userId}> · **${label}** → **${money(
        adminPay,
        e.amount
      )}**`;
    }
    if (e.type === 'payout') {
      return `• ${when} Paid <@${e.userId}> **${money(adminPay, e.amount)}**`;
    }
    return `• ${when} ${e.type} <@${e.userId}> **${money(adminPay, e.amount)}**${
      e.note ? ` — ${e.note}` : ''
    }`;
  });
}

function pendingRequestCount(adminPay, kind) {
  return (adminPay.requests || []).filter(
    (r) =>
      r.status === 'pending' && (kind ? (r.kind || 'event') === kind : true)
  ).length;
}

module.exports = {
  RATE_UNITS,
  DEFAULT_ACTIVITIES,
  PAYMENT_METHODS,
  getPaymentMethod,
  formatPaymentDetails,
  defaultAdminPay,
  getAdminPay,
  setCurrency,
  setActivityAmount,
  upsertStaff,
  removeStaff,
  validateEventRequest,
  createEventRequest,
  createPayRequest,
  createPayoutRequest,
  getPayRequest,
  approvePayRequest,
  denyPayRequest,
  addCredit,
  recordPayout,
  money,
  findStaff,
  getActivity,
  listEnabledActivities,
  staffSummaryLines,
  activitySummaryLines,
  ledgerSummaryLines,
  pendingRequestCount,
};
