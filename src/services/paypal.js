/**
 * PayPal REST helpers for the receiving (main) account.
 * Uses Transaction Search to detect money that has landed.
 *
 * App needs the Transaction Search scope:
 * https://uri.paypal.com/services/reporting/search/read
 */

const TOKEN_TTL_MS = 8 * 60 * 1000;
const tokenCache = new Map(); // key -> { token, expiresAt }

function apiBase(mode) {
  return mode === 'sandbox'
    ? 'https://api-m.sandbox.paypal.com'
    : 'https://api-m.paypal.com';
}

function cacheKey(clientId, mode) {
  return `${mode}:${clientId}`;
}

async function getAccessToken({ clientId, clientSecret, mode = 'live' }) {
  if (!clientId || !clientSecret) {
    throw new Error('PayPal Client ID and Secret are required.');
  }

  const key = cacheKey(clientId, mode);
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.token;
  }

  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const res = await fetch(`${apiBase(mode)}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail =
      body?.error_description || body?.error || res.statusText || 'auth failed';
    throw new Error(`PayPal auth failed: ${detail}`);
  }

  const token = body.access_token;
  const expiresIn = Number(body.expires_in) || 300;
  tokenCache.set(key, {
    token,
    expiresAt: Date.now() + Math.min(expiresIn * 1000, TOKEN_TTL_MS) - 30_000,
  });
  return token;
}

/**
 * List successful credit transactions in [start, end] (max 31 days).
 */
async function listReceivedTransactions({
  clientId,
  clientSecret,
  mode = 'live',
  startDate,
  endDate,
}) {
  const token = await getAccessToken({ clientId, clientSecret, mode });
  const start = new Date(startDate);
  const end = new Date(endDate || Date.now());
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new Error('Invalid PayPal date range.');
  }

  // PayPal requires seconds in ISO timestamps
  const params = new URLSearchParams({
    start_date: start.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    end_date: end.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    fields: 'all',
    page_size: '100',
    page: '1',
    transaction_status: 'S',
    balance_affecting_records_only: 'Y',
  });

  const credits = [];
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages && page <= 10) {
    params.set('page', String(page));
    const res = await fetch(
      `${apiBase(mode)}/v1/reporting/transactions?${params}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail =
        body?.message ||
        body?.name ||
        body?.details?.[0]?.description ||
        res.statusText;
      throw new Error(`PayPal transaction search failed: ${detail}`);
    }

    totalPages = Number(body.total_pages) || 1;
    const details = body.transaction_details || [];

    for (const row of details) {
      const info = row.transaction_info || {};
      const payer = row.payer_info || {};
      const amountRaw = info.transaction_amount?.value;
      const amount = Number(amountRaw);
      // Credits to the account are positive; skip debits/refunds out
      if (!Number.isFinite(amount) || amount <= 0) continue;

      credits.push({
        transactionId: info.transaction_id,
        amount,
        currency: info.transaction_amount?.currency_code || null,
        status: info.transaction_status || null,
        eventCode: info.transaction_event_code || null,
        updatedAt: info.transaction_updated_date || info.transaction_initiation_date,
        note: info.transaction_note || info.transaction_subject || null,
        invoiceId: info.invoice_id || null,
        customField: info.custom_field || null,
        payerEmail: payer.email_address || null,
        payerName:
          [payer.payer_name?.given_name, payer.payer_name?.surname]
            .filter(Boolean)
            .join(' ') ||
          payer.payer_name?.alternate_full_name ||
          null,
        payerAccountId: payer.account_id || null,
      });
    }

    page += 1;
  }

  return credits;
}

async function testPayPalConnection(creds) {
  const token = await getAccessToken(creds);
  // Lightweight check: search last hour (may be empty)
  const end = new Date();
  const start = new Date(end.getTime() - 60 * 60 * 1000);
  await listReceivedTransactions({
    ...creds,
    startDate: start,
    endDate: end,
  });
  return { ok: true, tokenPreview: `${String(token).slice(0, 8)}…` };
}

module.exports = {
  getAccessToken,
  listReceivedTransactions,
  testPayPalConnection,
};
