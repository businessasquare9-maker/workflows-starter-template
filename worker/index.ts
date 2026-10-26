// @ts-nocheck
// ===== BLOCK 1/10: Header and configuration =====
/**
 * ALEX PIZZA NYC - VOICE AGENT WORKER
 * Refined production build in 10 paste blocks.
 *
 * IMPORTANT: This source contains no phone number values.
 * Manager, store, WhatsApp and SMS numbers are read at runtime from
 * Cloudflare Secrets / Variables only. Dynamic customer numbers come from
 * the Vapi tool call payload and are never written into this file.
 *
 * Paste Blocks 1 through 10, in order, into one Cloudflare Worker module.
 */

const WORKER_NAME = 'alex-pizza-voice-agent';
const DEFAULT_TENANT = 'alex-pizza';
const CURRENCY = 'USD';
const TIME_ZONE_DEFAULT = 'America/New_York';
const ZOHO_TOKEN_URL_DEFAULT = 'https://accounts.zoho.com/oauth/v2/token';

const MAX_TOOL_CALLS = 25;
const MAX_BODY_BYTES = 1000000;
const MAX_MENU_ROWS = 200;
const MAX_ORDER_ITEMS = 50;
const DEFAULT_CALL_SECONDS = 180;
const RETENTION_DAYS = 60;
const REPEAT_WINDOW_MINUTES = 30;
const MAX_TABLES_DEFAULT = 10;
const OPEN_HOUR_DEFAULT = 10;
const CLOSE_HOUR_DEFAULT = 2;
const CUTOFF_MINUTES_DEFAULT = 20;
const SLOT_MIN_MINUTES = 30;
const SLOT_MAX_MINUTES = 240;
const SLOT_DEFAULT_MINUTES = 90;

const ALLOWED_TABLES = new Set([
  'tenants', 'audit_log', 'bookings', 'business_settings', 'calls',
  'integration_status', 'manager_tasks', 'menu_items', 'notifications',
  'order_change_requests', 'order_items', 'orders', 'zoho_oauth_tokens',
  'monthly_call_usage'
]);

const TENANT_COLUMNS = [
  'tenant_id', 'client_id', 'business_id', 'restaurant_id', 'tenantid', 'clientid'
];

const ENV_KEYS = {
  toolSecret: ['TOOL_SHARED_SECRET', 'VAPI_TOOL_SECRET', 'AGENT_TOOL_SECRET'],
  adminToken: ['ADMIN_API_TOKEN', 'ADMIN_SECRET', 'WORKER_ADMIN_TOKEN'],
  managerPhones: [
    'MANAGER_PHONE', 'MANAGER_PHONES', 'MANAGER_WHATSAPP',
    'MANAGER_WHATSAPP_PHONE', 'ALERT_PHONE', 'WHATSAPP_MANAGER_PHONE',
    'OWNER_PHONE', 'NOTIFY_PHONE'
  ],
  businessPhones: [
    'BUSINESS_PHONE', 'STORE_PHONE', 'RESTAURANT_PHONE', 'SMS_FROM_PHONE',
    'WHATSAPP_FROM_PHONE', 'TWILIO_PHONE_NUMBER', 'VAPI_PHONE_NUMBER',
    'CALLER_ID', 'SENDER_PHONE'
  ],
  phoneBook: ['PHONE_CONTACTS', 'PHONE_BOOK', 'NOTIFICATION_CONTACTS'],
  allowedOrigins: ['ALLOWED_ORIGINS', 'CORS_ALLOWED_ORIGINS'],
  webhookUrl: ['NOTIFICATION_WEBHOOK_URL', 'MESSAGING_WEBHOOK_URL'],
  webhookToken: ['NOTIFICATION_WEBHOOK_TOKEN', 'MESSAGING_WEBHOOK_TOKEN'],
  zohoTokenUrl: ['ZOHO_TOKEN_URL', 'ZOHO_ACCOUNTS_TOKEN_URL'],
  zohoClientId: ['ZOHO_CLIENT_ID'],
  zohoClientSecret: ['ZOHO_CLIENT_SECRET'],
  zohoPosUrl: ['ZOHO_POS_ORDER_URL', 'ZOHO_ORDER_WEBHOOK_URL'],
  zohoRefreshToken: ['ZOHO_REFRESH_TOKEN'],
  zohoTenant: ['ZOHO_TENANT_ID'],
  callerSalt: ['CALLER_HASH_SALT', 'TOOL_SHARED_SECRET', 'ADMIN_API_TOKEN'],
  storeRawPhone: ['STORE_RAW_CALLER_PHONE'],
  requireCustomerPhone: ['REQUIRE_CUSTOMER_PHONE'],
  allowManualTotal: ['ALLOW_MANUAL_TOTAL']
};

const PHONE_KEY_HINT = /phone|whatsapp|mobile|sms|number|contact|recipient|msisdn|e164/i;
const MANAGER_HINT = /manager|owner|admin|alert|notify|notification/i;
const BUSINESS_HINT = /business|store|restaurant|shop|sender|from|twilio|vapi|caller|sms|default|main|office/i;
const GENERIC_HINT = /^(phone|phone_number|contact_number|whatsapp_number|hotline|support_phone)$/i;

const PURGE_TABLES = [
  'audit_log', 'bookings', 'calls', 'notifications', 'manager_tasks',
  'order_change_requests', 'order_items', 'orders'
];

const DQ = String.fromCharCode(34);
const NL = String.fromCharCode(10);
const columnCache = new Map();
let schemaPromise = null;

// ===== BLOCK 2/10: Shared utilities, phone resolution and security =====
class AppError extends Error {
  constructor(message, code = 'bad_request', status = 400, details = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details || {};
  }
}

function nowIso() { return new Date().toISOString(); }
function norm(value) { return String(value ?? '').trim().toLowerCase(); }
function clean(value, max = 500) { return String(value ?? '').trim().slice(0, max); }
function roundMoney(n) {
  const value = Number(n);
  return Number.isFinite(value) ? Math.round((value + Number.EPSILON) * 100) / 100 : 0;
}
function parseMoney(value) {
  if (typeof value === 'number') return roundMoney(value);
  const n = Number(String(value ?? '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? roundMoney(n) : 0;
}
function money(n) { return '$' + roundMoney(n).toFixed(2); }

function makeId(length = 12) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, byte => alphabet[byte % alphabet.length]).join('');
}

function quoteIdent(name) {
  const value = String(name ?? '');
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new AppError('Unsafe SQL identifier rejected.', 'unsafe_identifier', 500);
  }
  return DQ + value.split(DQ).join(DQ + DQ) + DQ;
}
function q(name) { return quoteIdent(name); }

function envValue(env, names) {
  for (const name of names || []) {
    const value = env?.[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}
function envFlag(env, names, fallback = false) {
  const raw = envValue(env, names);
  if (!raw) return fallback;
  return ['1', 'true', 'yes', 'on', 'enabled'].includes(norm(raw));
}
function envNumber(env, names, fallback, min, max) {
  const raw = envValue(env, names);
  const value = Number(raw);
  if (!raw || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function normalizePhone(value) {
  let raw = String(value ?? '').trim();
  if (!raw || raw.startsWith('{') || raw.startsWith('[')) return '';
  raw = raw
    .replace(/^whatsapp:/i, '')
    .replace(/^tel:/i, '')
    .replace(/^sms:/i, '')
    .trim();
  if (raw.startsWith('00')) raw = '+' + raw.slice(2);
  let digits = raw.replace(/[^+0-9]/g, '');
  if (digits.startsWith('+')) digits = '+' + digits.slice(1).replace(/[+]/g, '');
  else digits = digits.replace(/[+]/g, '');
  if (!new RegExp('^[+]?[0-9]{8,15}$').test(digits)) return '';
  return digits;
}
function normalizePhoneList(value) {
  const raw = String(value ?? '');
  if (raw.trim().startsWith('{') || raw.trim().startsWith('[')) return [];
  const parts = raw.split(/[,;|]+/).map(normalizePhone).filter(Boolean);
  return Array.from(new Set(parts)).slice(0, 10);
}
function contactValueToPhones(value) {
  if (value == null) return [];
  if (typeof value === 'string' || typeof value === 'number') return normalizePhoneList(value);
  if (Array.isArray(value)) return value.flatMap(contactValueToPhones);
  if (typeof value === 'object') {
    return normalizePhoneList(value.phone || value.number || value.value || value.e164 || value.whatsapp || '');
  }
  return [];
}
function phoneBookFromEnv(env) {
  const raw = envValue(env, ENV_KEYS.phoneBook);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return Object.fromEntries(parsed.map((item, index) => [
        clean(item?.role || item?.name || item?.label || String(index), 80), item
      ]));
    }
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}
function contactMatchesRole(key, role) {
  const k = norm(key).replace(/[ ._-]+/g, '_');
  if (role === 'manager') {
    if (/business|store|sender|from|customer|twilio|vapi/.test(k)) return false;
    return /manager|owner|admin|alert|notify|whatsapp|primary|default/.test(k);
  }
  if (/manager|owner|alert/.test(k) && !/from|sender|business|store/.test(k)) return false;
  return /business|store|restaurant|shop|sender|from|twilio|vapi|caller|sms|default|main|office|whatsapp/.test(k);
}
function resolvePhones(env, role) {
  const explicitKeys = role === 'manager' ? ENV_KEYS.managerPhones : ENV_KEYS.businessPhones;
  const found = [];
  for (const key of explicitKeys) found.push(...normalizePhoneList(env?.[key]));

  const book = phoneBookFromEnv(env);
  for (const [key, value] of Object.entries(book)) {
    if (!contactMatchesRole(key, role)) continue;
    found.push(...contactValueToPhones(value));
  }

  if (!found.length) {
    for (const key of Object.keys(env || {})) {
      if (!PHONE_KEY_HINT.test(key)) continue;
      const isManager = MANAGER_HINT.test(key);
      const isBusiness = BUSINESS_HINT.test(key);
      if (role === 'manager' && !(isManager || GENERIC_HINT.test(key)) && !isBusiness) continue;
      if (role === 'manager' && isBusiness && !isManager && !GENERIC_HINT.test(key)) continue;
      if (role === 'business' && !isBusiness) continue;
      if (role === 'business' && isManager && !isBusiness) continue;
      found.push(...normalizePhoneList(env[key]));
    }
  }

  return Array.from(new Set(found)).slice(0, 10);
}
function requirePhones(env, role) {
  const phones = resolvePhones(env, role);
  if (!phones.length) {
    const preferred = role === 'manager' ? ENV_KEYS.managerPhones[0] : ENV_KEYS.businessPhones[0];
    throw new AppError(
      'No ' + role + ' phone configured. Set ' + preferred + ' or PHONE_CONTACTS in Cloudflare.',
      'phone_config_missing',
      503,
      { role, preferred_variable: preferred }
    );
  }
  return phones;
}
function customerPhoneFrom(args, required = false) {
  const value = args?.customer_phone ?? args?.phone ?? args?.caller_phone ?? args?.from ?? args?.customerNumber;
  const normalized = normalizePhone(value);
  if (required && !normalized) {
    throw new AppError('A valid customer_phone is required in tool arguments.', 'customer_phone_required', 400);
  }
  return normalized;
}
async function callerFingerprint(env, phoneValue) {
  const normalized = normalizePhone(phoneValue);
  if (!normalized) return 'anon';
  const salt = envValue(env, ENV_KEYS.callerSalt) || 'alex-pizza-caller-ref';
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(salt + '|' + normalized));
  return 'cr_' + Array.from(new Uint8Array(digest)).slice(0, 12)
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function redact(text) {
  return String(text ?? '').replace(new RegExp('[+]?[0-9][0-9 ().-]{7,}[0-9]', 'g'), '[redacted]');
}
function sanitizeDetails(value, depth = 0) {
  if (depth > 3) return '[truncated]';
  if (typeof value === 'string') return redact(clean(value, 500));
  if (Array.isArray(value)) return value.slice(0, 20).map(item => sanitizeDetails(item, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, 30)) {
      if (/secret|token|password|authorization|phone|number/i.test(key)) continue;
      out[clean(key, 50)] = sanitizeDetails(item, depth + 1);
    }
    return out;
  }
  return value;
}
function publicError(err) {
  const error = {
    ok: false,
    error: redact(clean(err?.message || 'Unexpected error', 300)),
    code: clean(err?.code || 'internal_error', 80)
  };
  if (err instanceof AppError && Object.keys(err.details || {}).length) {
    error.details = sanitizeDetails(err.details);
  }
  return error;
}
function safeLog(err) {
  try {
    console.error(JSON.stringify({
      level: 'error',
      code: clean(err?.code || 'internal_error', 80),
      message: redact(clean(err?.message || 'Unexpected error', 300))
    }));
  } catch {}
}

function parseArgs(raw) {
  if (raw == null || raw === '') return {};
  if (Array.isArray(raw)) throw new AppError('Tool arguments must be a JSON object.', 'invalid_tool_arguments', 400);
  if (typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(String(raw));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed;
  } catch {
    throw new AppError('Tool arguments must be valid JSON.', 'invalid_tool_arguments', 400);
  }
}
function toolResult(callId, value) {
  return { toolCallId: String(callId ?? 'unknown'), result: JSON.stringify(value) };
}

function allowedOrigin(request, env) {
  const configured = envValue(env, ENV_KEYS.allowedOrigins);
  if (!configured) return '*';
  const list = configured.split(/[,;]+/).map(item => item.trim()).filter(Boolean);
  const origin = request?.headers.get('origin') || '';
  return origin && list.includes(origin) ? origin : 'null';
}
function responseHeaders(request, env, extra = {}) {
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': allowedOrigin(request, env),
    Vary: 'Origin',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-agent-tool-secret, x-tool-secret, x-vapi-secret, x-admin-key, x-admin-token, x-admin-secret',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...extra
  };
}
function json(request, env, data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), { status, headers: responseHeaders(request, env, extra) });
}
function preflight(request, env) {
  return new Response(null, { status: 204, headers: responseHeaders(request, env) });
}
function httpErrorResponse(request, env, err) {
  const status = err instanceof AppError ? err.status : 500;
  return json(request, env, publicError(err), status);
}
function requireMethod(request, env, method) {
  if (request.method === method) return null;
  return json(request, env, { ok: false, error: 'Method not allowed', code: 'method_not_allowed' }, 405, { Allow: method });
}

async function secureEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b))
  ]);
  const aa = new Uint8Array(ha);
  const bb = new Uint8Array(hb);
  let diff = aa.length ^ bb.length;
  for (let i = 0; i < aa.length; i++) diff |= aa[i] ^ bb[i];
  return diff === 0;
}
function bearerOrHeader(request, names) {
  const auth = request.headers.get('authorization') || '';
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  if (bearer) return bearer;
  for (const name of names) {
    const value = request.headers.get(name);
    if (value) return value.trim();
  }
  return '';
}

async function requireToolAuth(request, env) {
  const envKey = ENV_KEYS.toolSecret.find((name) => {
    const value = env?.[name];
    return (
      (typeof value === 'string' && value.trim()) ||
      (typeof value === 'number' && Number.isFinite(value))
    );
  });

  const expected = envValue(env, ENV_KEYS.toolSecret);

  if (!expected) {
    throw new AppError(
      'Tool authentication is not configured.',
      'tool_auth_unconfigured',
      503,
      { env_key_found: false }
    );
  }

  const auth = request.headers.get('authorization') || '';
  const bearer = auth.toLowerCase().startsWith('bearer ');

  const headerNames = [
    'x-agent-tool-secret',
    'x-tool-secret',
    'x-vapi-secret'
  ];

  let suppliedHeader = '';
  let supplied = '';

  if (bearer) {
    supplied = auth.slice(7).trim();
    suppliedHeader = 'authorization_bearer';
  } else {
    for (const name of headerNames) {
      const value = request.headers.get(name);
      if (value) {
        supplied = value.trim();
        suppliedHeader = name;
        break;
      }
    }
  }

  if (!(await secureEqual(supplied, expected))) {
    throw new AppError(
      'Unauthorized tool request.',
      'unauthorized',
      401,
      {
        env_key_in_use: envKey,
        received_header: suppliedHeader || 'none',
        supplied_value_present: Boolean(supplied)
      }
    );
  }
}

async function requireAdminAuth(request, env) {
  const expected = envValue(env, ENV_KEYS.adminToken);
  if (!expected) throw new AppError('ADMIN_API_TOKEN is not configured.', 'admin_auth_unconfigured', 503);
  const supplied = bearerOrHeader(request, ['x-admin-key', 'x-admin-token', 'x-admin-secret']);
  if (!(await secureEqual(supplied, expected))) {
    throw new AppError('Unauthorized admin request.', 'unauthorized', 401);
  }
}
async function readJson(request, env) {
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > MAX_BODY_BYTES) throw new AppError('Request body is too large.', 'body_too_large', 413);
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
    throw new AppError('Request body is too large.', 'body_too_large', 413);
  }
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    throw new AppError('Request body must be valid JSON.', 'invalid_json', 400);
  }
}
function validateTenant(value) {
  const tenantId = norm(clean(value || DEFAULT_TENANT, 64));
  if (!/^[a-z0-9-]{1,64}$/.test(tenantId)) {
    throw new AppError('Invalid tenant identifier.', 'invalid_tenant', 400);
  }
  return tenantId;
}
function assertHttpsUrl(raw, code) {
  let url;
  try { url = new URL(String(raw)); }
  catch { throw new AppError('Configured URL is invalid.', code, 503); }
  if (url.protocol !== 'https:') throw new AppError('Configured URL must use HTTPS.', code, 503);
  return url.toString();
}
async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ===== BLOCK 3/10: D1 schema bootstrap and safe data helpers =====
const SCHEMA_STATEMENTS = [
  'CREATE TABLE IF NOT EXISTS `tenants` (`tenant_id` TEXT NOT NULL PRIMARY KEY, `name` TEXT, `timezone` TEXT, `created_at` TEXT)',
  'CREATE TABLE IF NOT EXISTS `business_settings` (`tenant_id` TEXT NOT NULL, `id` TEXT NOT NULL, `setting_key` TEXT, `setting_value` TEXT, `created_at` TEXT, PRIMARY KEY (`tenant_id`, `id`))',
  'CREATE TABLE IF NOT EXISTS `audit_log` (`tenant_id` TEXT NOT NULL, `id` TEXT NOT NULL, `event` TEXT, `details` TEXT, `created_at` TEXT, PRIMARY KEY (`tenant_id`, `id`))',
  'CREATE TABLE IF NOT EXISTS `integration_status` (`tenant_id` TEXT NOT NULL, `id` TEXT NOT NULL, `provider` TEXT, `status` TEXT, `details` TEXT, `created_at` TEXT, PRIMARY KEY (`tenant_id`, `id`))',
  'CREATE TABLE IF NOT EXISTS `menu_items` (`tenant_id` TEXT NOT NULL, `id` TEXT NOT NULL, `sku` TEXT, `name` TEXT NOT NULL, `category` TEXT, `price` REAL NOT NULL DEFAULT 0, `active` INTEGER NOT NULL DEFAULT 1, `created_at` TEXT, `updated_at` TEXT, PRIMARY KEY (`tenant_id`, `id`))',
  'CREATE TABLE IF NOT EXISTS `bookings` (`tenant_id` TEXT NOT NULL, `id` TEXT NOT NULL, `booking_time` TEXT NOT NULL, `duration_minutes` INTEGER NOT NULL DEFAULT 90, `party_size` INTEGER, `customer_name` TEXT, `customer_phone` TEXT, `caller_hash` TEXT, `status` TEXT, `notes` TEXT, `created_at` TEXT, `updated_at` TEXT, PRIMARY KEY (`tenant_id`, `id`))',
  'CREATE TABLE IF NOT EXISTS `calls` (`tenant_id` TEXT NOT NULL, `id` TEXT NOT NULL, `call_id` TEXT, `customer_phone` TEXT, `caller_hash` TEXT, `purpose` TEXT, `direction` TEXT, `created_at` TEXT, PRIMARY KEY (`tenant_id`, `id`))',
  'CREATE TABLE IF NOT EXISTS `manager_tasks` (`tenant_id` TEXT NOT NULL, `id` TEXT NOT NULL, `task_id` TEXT, `title` TEXT, `description` TEXT, `priority` TEXT, `status` TEXT, `caller_hash` TEXT, `dedupe_key` TEXT, `created_at` TEXT, PRIMARY KEY (`tenant_id`, `id`))',
  'CREATE TABLE IF NOT EXISTS `notifications` (`tenant_id` TEXT NOT NULL, `id` TEXT NOT NULL, `notification_id` TEXT, `recipient_phone` TEXT, `sender_phone` TEXT, `message` TEXT, `notification_type` TEXT, `channel` TEXT, `status` TEXT, `provider_message_id` TEXT, `metadata` TEXT, `created_at` TEXT, PRIMARY KEY (`tenant_id`, `id`))',
  'CREATE TABLE IF NOT EXISTS `orders` (`tenant_id` TEXT NOT NULL, `id` TEXT NOT NULL, `order_id` TEXT, `customer_name` TEXT, `customer_phone` TEXT, `caller_hash` TEXT, `order_type` TEXT, `total` REAL NOT NULL DEFAULT 0, `currency` TEXT, `items_json` TEXT, `status` TEXT, `notes` TEXT, `created_at` TEXT, `updated_at` TEXT, PRIMARY KEY (`tenant_id`, `id`))',
  'CREATE TABLE IF NOT EXISTS `order_items` (`tenant_id` TEXT NOT NULL, `id` TEXT NOT NULL, `order_id` TEXT, `sku` TEXT, `name` TEXT, `category` TEXT, `unit_price` REAL NOT NULL DEFAULT 0, `quantity` INTEGER NOT NULL DEFAULT 1, `line_total` REAL NOT NULL DEFAULT 0, `created_at` TEXT, PRIMARY KEY (`tenant_id`, `id`))',
  'CREATE TABLE IF NOT EXISTS `order_change_requests` (`tenant_id` TEXT NOT NULL, `id` TEXT NOT NULL, `order_id` TEXT, `caller_hash` TEXT, `requested_change` TEXT, `reason` TEXT, `status` TEXT, `created_at` TEXT, PRIMARY KEY (`tenant_id`, `id`))',
  'CREATE TABLE IF NOT EXISTS `monthly_call_usage` (`tenant_id` TEXT NOT NULL, `month` TEXT NOT NULL, `total_minutes` INTEGER NOT NULL DEFAULT 0, `last_call_at` TEXT, `status` TEXT, `updated_at` TEXT, PRIMARY KEY (`tenant_id`, `month`))',
  'CREATE TABLE IF NOT EXISTS `zoho_oauth_tokens` (`tenant_id` TEXT NOT NULL PRIMARY KEY, `access_token` TEXT, `refresh_token` TEXT, `expires_at` INTEGER, `updated_at` TEXT)',
  'CREATE INDEX IF NOT EXISTS `idx_menu_tenant_sku` ON `menu_items` (`tenant_id`, `sku`)',
  'CREATE INDEX IF NOT EXISTS `idx_bookings_tenant_time` ON `bookings` (`tenant_id`, `booking_time`)',
  'CREATE INDEX IF NOT EXISTS `idx_calls_tenant_time` ON `calls` (`tenant_id`, `created_at`)',
  'CREATE INDEX IF NOT EXISTS `idx_notifications_tenant_time` ON `notifications` (`tenant_id`, `created_at`)',
  'CREATE INDEX IF NOT EXISTS `idx_orders_tenant_time` ON `orders` (`tenant_id`, `created_at`)',
  'CREATE INDEX IF NOT EXISTS `idx_tasks_tenant_time` ON `manager_tasks` (`tenant_id`, `created_at`)'
];

async function ensureSchema(env) {
  if (!env?.DB) throw new AppError('D1 binding DB is missing.', 'db_binding_missing', 503);
  if (schemaPromise) return schemaPromise;
  schemaPromise = (async () => {
    let tablesChecked = 0;
    for (const statement of SCHEMA_STATEMENTS) {
      try {
        await env.DB.prepare(statement).run();
        tablesChecked++;
      } catch (err) {
        // Existing customer schemas may use legacy column names. Table creation
        // remains required; best-effort indexes must not block those schemas.
        if (!statement.startsWith('CREATE INDEX IF NOT EXISTS')) throw err;
      }
    }
    columnCache.clear();
    return { tablesChecked };
  })();
  try {
    return await schemaPromise;
  } catch (err) {
    schemaPromise = null;
    throw new AppError('D1 schema bootstrap failed: ' + clean(err?.message, 160), 'schema_bootstrap_failed', 500);
  }
}

async function getColumns(env, table) {
  if (!ALLOWED_TABLES.has(table)) throw new AppError('Table not allowed: ' + table, 'table_not_allowed', 400);
  if (columnCache.has(table)) return columnCache.get(table);
  await ensureSchema(env);
  const result = await env.DB.prepare('PRAGMA table_info(' + q(table) + ')').all();
  const columns = (result.results || []).map(row => ({
    name: row.name,
    type: row.type || '',
    pk: Number(row.pk || 0)
  }));
  if (!columns.length) throw new AppError('Table is missing or unreadable: ' + table, 'table_missing', 500);
  columnCache.set(table, columns);
  return columns;
}
function findColumn(columns, aliases) {
  const byName = new Map(columns.map(col => [col.name.toLowerCase(), col.name]));
  for (const alias of aliases || []) {
    const found = byName.get(String(alias).toLowerCase());
    if (found) return found;
  }
  return null;
}
async function tenantColumn(env, table) {
  const columns = await getColumns(env, table);
  const column = findColumn(columns, TENANT_COLUMNS);
  if (!column) throw new AppError('Table lacks a tenant column: ' + table, 'tenant_column_missing', 500);
  return column;
}
async function rowsForTenant(env, table, tenantId, limit = 500) {
  const scopeColumn = await tenantColumn(env, table);
  const result = await env.DB.prepare(
    `SELECT * FROM ${q(table)} WHERE ${q(scopeColumn)} = ? LIMIT ?`
  ).bind(tenantId, Math.max(1, Math.min(1000, Number(limit) || 500))).all();
  return result.results || [];
}
async function insertScoped(env, table, tenantId, entries) {
  const columns = await getColumns(env, table);
  const scopeColumn = findColumn(columns, TENANT_COLUMNS);
  if (!scopeColumn) throw new AppError('Table lacks a tenant column: ' + table, 'tenant_column_missing', 500);

  const data = { [scopeColumn]: tenantId };
  for (const [aliases, value] of entries || []) {
    if (value === undefined || value === null) continue;
    const candidates = Array.isArray(aliases) ? aliases : [aliases];
    const column = findColumn(columns, candidates);
    if (column) data[column] = value;
  }

  const singular = table.endsWith('s') ? table.slice(0, -1) : table;
  const idColumn = findColumn(columns, ['id', singular + '_id', 'uuid']);
  if (idColumn && data[idColumn] === undefined) data[idColumn] = makeId(16);
  const createdColumn = findColumn(columns, ['created_at', 'createdAt', 'created']);
  if (createdColumn && data[createdColumn] === undefined) data[createdColumn] = nowIso();
  const updatedColumn = findColumn(columns, ['updated_at', 'updatedAt']);
  if (updatedColumn && data[updatedColumn] === undefined) data[updatedColumn] = nowIso();

  const keys = Object.keys(data);
  const names = keys.map(key => q(key)).join(', ');
  const placeholders = keys.map(() => '?').join(', ');
  await env.DB.prepare(
    `INSERT INTO ${q(table)} (${names}) VALUES (${placeholders})`
  ).bind(...keys.map(key => data[key])).run();
  return data;
}
async function audit(env, tenantId, event, details = {}) {
  try {
    await insertScoped(env, 'audit_log', tenantId, [
      [['event', 'event_type', 'action'], clean(event, 100)],
      [['details', 'payload', 'message'], JSON.stringify(sanitizeDetails(details)).slice(0, 3000)],
      [['created_at'], nowIso()]
    ]);
  } catch {}
}
async function recordIntegrationStatus(env, tenantId, provider, status, details = {}) {
  try {
    await insertScoped(env, 'integration_status', tenantId, [
      [['provider', 'integration', 'service'], clean(provider, 80)],
      [['status', 'state'], clean(status, 80)],
      [['details', 'payload'], JSON.stringify(sanitizeDetails(details)).slice(0, 2000)],
      [['created_at'], nowIso()]
    ]);
  } catch {}
}

// ===== BLOCK 4/10: Official menu, D1 sync and menu lookup =====
const SIZES = [
  { code: 'S', label: 'Small' },
  { code: 'M', label: 'Medium' },
  { code: 'L', label: 'Large' },
  { code: 'XL', label: 'Extra Large' }
];
const MENU_GROUPS = [
  { prefix: 'DRK-COLA', name: 'Cola', category: 'Drinks', prices: [1.99, 2.49, 2.99, 3.49] },
  { prefix: 'DRK-DIET', name: 'Diet Cola', category: 'Drinks', prices: [1.99, 2.49, 2.99, 3.49] },
  { prefix: 'DRK-LEMON', name: 'Lemon Lime', category: 'Drinks', prices: [1.99, 2.49, 2.99, 3.49] },
  { prefix: 'DRK-ORANGE', name: 'Orange Soda', category: 'Drinks', prices: [1.99, 2.49, 2.99, 3.49] },
  { prefix: 'DRK-ROOT', name: 'Root Beer', category: 'Drinks', prices: [1.99, 2.49, 2.99, 3.49] },
  { prefix: 'DRK-ICED', name: 'Iced Tea', category: 'Drinks', prices: [2.19, 2.69, 3.19, 3.49] },
  { prefix: 'PIZ-MARG', name: 'Classic Margherita Pizza', category: 'Food', prices: [8.99, 12.99, 16.99, 19.99] },
  { prefix: 'PIZ-PEPP', name: 'Pepperoni Feast Pizza', category: 'Food', prices: [9.99, 14.99, 18.99, 22.99] },
  { prefix: 'PIZ-BBQ', name: 'BBQ Chicken Pizza', category: 'Food', prices: [10.99, 15.99, 19.99, 23.99] },
  { prefix: 'PIZ-VEG', name: 'Veggie Supreme Pizza', category: 'Food', prices: [9.49, 13.99, 17.99, 21.99] },
  { prefix: 'APP-GBREAD', name: 'Garlic Bread', category: 'Food', prices: [3.99, 5.99, 7.99, 9.99] },
  { prefix: 'APP-CGBREAD', name: 'Cheese Garlic Bread', category: 'Food', prices: [4.99, 6.99, 8.99, 11.99] },
  { prefix: 'WNG-PLAIN', name: 'Chicken Wings', category: 'Food', prices: [6.99, 12.99, 17.99, 22.99] },
  { prefix: 'WNG-BUFF', name: 'Spicy Buffalo Wings', category: 'Food', prices: [7.49, 13.49, 18.49, 23.49] },
  { prefix: 'SLD-CAES', name: 'Caesar Salad', category: 'Food', prices: [5.99, 8.99, 11.99, 14.99] },
  { prefix: 'SLD-GREEK', name: 'Greek Salad', category: 'Food', prices: [6.49, 9.49, 12.49, 15.49] }
];
const OFFICIAL_MENU = MENU_GROUPS.flatMap(group => SIZES.map((size, index) => ({
  sku: group.prefix + '-' + size.code,
  name: group.name + ' (' + size.label + ')',
  category: group.category,
  price: roundMoney(group.prices[index])
})));

async function syncAndReplaceD1Menu(env, tenantId) {
  await ensureSchema(env);
  const scopeColumn = await tenantColumn(env, 'menu_items');
  await env.DB.prepare(`DELETE FROM ${q('menu_items')} WHERE ${q(scopeColumn)} = ?`).bind(tenantId).run();
  for (const item of OFFICIAL_MENU) {
    await insertScoped(env, 'menu_items', tenantId, [
      [['id', 'sku', 'menu_item_id'], item.sku],
      [['sku'], item.sku],
      [['name', 'item_name', 'title'], item.name],
      [['category'], item.category],
      [['price', 'unit_price'], item.price],
      [['active', 'is_active'], 1],
      [['created_at'], nowIso()],
      [['updated_at'], nowIso()]
    ]);
  }
  await audit(env, tenantId, 'menu_synced', { items: OFFICIAL_MENU.length });
  return { ok: true, tenant_id: tenantId, items_synced: OFFICIAL_MENU.length };
}
async function getMenuRows(env, tenantId, options = {}) {
  await ensureSchema(env);
  const columns = await getColumns(env, 'menu_items');
  const scopeColumn = findColumn(columns, TENANT_COLUMNS);
  const skuColumn = findColumn(columns, ['sku', 'id', 'menu_item_id']);
  const nameColumn = findColumn(columns, ['name', 'item_name', 'title']);
  const categoryColumn = findColumn(columns, ['category']);
  const priceColumn = findColumn(columns, ['price', 'unit_price']);
  const activeColumn = findColumn(columns, ['active', 'is_active']);
  if (!scopeColumn || !nameColumn || !priceColumn) {
    throw new AppError('menu_items schema is incomplete.', 'menu_schema_incomplete', 500);
  }

  const where = [`${q(scopeColumn)} = ?`];
  const params = [tenantId];
  if (activeColumn && !options.includeInactive) {
    where.push(`${q(activeColumn)} = 1`);
  }
  if (categoryColumn && options.category) {
    where.push(`LOWER(${q(categoryColumn)}) = ?`);
    params.push(norm(clean(options.category, 50)));
  }
  if (nameColumn && options.search) {
    where.push(`LOWER(${q(nameColumn)}) LIKE ?`);
    params.push('%' + norm(clean(options.search, 60)) + '%');
  }
  const limit = Math.max(1, Math.min(MAX_MENU_ROWS, Number(options.limit) || MAX_MENU_ROWS));
  const result = await env.DB.prepare(
    `SELECT * FROM ${q('menu_items')} WHERE ${where.join(' AND ')} ORDER BY ${q(nameColumn)} LIMIT ?`
  ).bind(...params, limit).all();

  return (result.results || []).map(row => ({
    id: row.id || row[skuColumn] || '',
    sku: row[skuColumn] || row.id || '',
    name: clean(row[nameColumn], 200),
    category: categoryColumn ? clean(row[categoryColumn], 80) : '',
    price: parseMoney(row[priceColumn]),
    active: activeColumn ? Boolean(row[activeColumn]) : true
  }));
}
async function findMenuItemsBySku(env, tenantId, identifiers) {
  const wanted = Array.from(new Set((identifiers || []).map(norm).filter(Boolean))).slice(0, MAX_ORDER_ITEMS * 2);
  if (!wanted.length) return new Map();
  const columns = await getColumns(env, 'menu_items');
  const scopeColumn = findColumn(columns, TENANT_COLUMNS);
  const skuColumn = findColumn(columns, ['sku', 'id', 'menu_item_id']);
  const nameColumn = findColumn(columns, ['name', 'item_name', 'title']);
  const priceColumn = findColumn(columns, ['price', 'unit_price']);
  const categoryColumn = findColumn(columns, ['category']);
  const activeColumn = findColumn(columns, ['active', 'is_active']);
  if (!scopeColumn || !skuColumn || !nameColumn || !priceColumn) {
    throw new AppError('menu_items schema is incomplete.', 'menu_schema_incomplete', 500);
  }
  const placeholders = wanted.map(() => '?').join(', ');
  const sql = `SELECT * FROM ${q('menu_items')} WHERE ${q(scopeColumn)} = ? AND (LOWER(${q(skuColumn)}) IN (${placeholders}) OR LOWER(${q(nameColumn)}) IN (${placeholders}))` +
    (activeColumn ? ` AND ${q(activeColumn)} = 1` : '') + ` LIMIT ?`;
  const result = await env.DB.prepare(sql).bind(tenantId, ...wanted, ...wanted, MAX_MENU_ROWS).all();
  const map = new Map();
  for (const row of result.results || []) {
    const item = {
      sku: clean(row[skuColumn], 80),
      name: clean(row[nameColumn], 200),
      category: categoryColumn ? clean(row[categoryColumn], 80) : '',
      price: parseMoney(row[priceColumn])
    };
    map.set(norm(item.sku), item);
    map.set(norm(item.name), item);
    map.set(norm(item.sku).replace(/[ _-]+/g, ''), item);
  }
  return map;
}

// ===== BLOCK 5/10: Business hours, table booking and repeat caller logic =====
function businessConfig(env) {
  return {
    timeZone: clean(envValue(env, ['BUSINESS_TIME_ZONE', 'TIME_ZONE']) || TIME_ZONE_DEFAULT, 64),
    openHour: envNumber(env, ['OPEN_HOUR', 'OPENING_HOUR', 'BUSINESS_OPEN_HOUR'], OPEN_HOUR_DEFAULT, 0, 23),
    closeHour: envNumber(env, ['CLOSE_HOUR', 'CLOSING_HOUR', 'BUSINESS_CLOSE_HOUR'], CLOSE_HOUR_DEFAULT, 0, 23),
    cutoffMinutes: envNumber(env, ['BOOKING_CUTOFF_MINUTES', 'RESERVATION_CUTOFF_MINUTES'], CUTOFF_MINUTES_DEFAULT, 0, 180),
    maxTables: envNumber(env, ['MAX_TABLES', 'TABLE_CAPACITY', 'BOOKING_CAPACITY'], MAX_TABLES_DEFAULT, 1, 1000),
    minMinutes: envNumber(env, ['MIN_BOOKING_MINUTES'], SLOT_MIN_MINUTES, 15, 240),
    maxMinutes: envNumber(env, ['MAX_BOOKING_MINUTES'], SLOT_MAX_MINUTES, 30, 480),
    defaultMinutes: envNumber(env, ['DEFAULT_BOOKING_MINUTES'], SLOT_DEFAULT_MINUTES, 30, 240)
  };
}
function formatHour(hour) { return String(hour).padStart(2, '0') + ':00'; }
function businessHoursMessage(config) {
  return 'Open ' + formatHour(config.openHour) + ' to ' + formatHour(config.closeHour) +
    ' (' + config.timeZone + '). Reservations close ' + config.cutoffMinutes +
    ' minutes before closing.';
}
function zonedParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    weekday: 'short'
  }).formatToParts(date).reduce((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second),
    weekday: parts.weekday || ''
  };
}
function timeZoneOffsetMs(date, timeZone) {
  const parts = zonedParts(date, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}
function zonedLocalToUtc(localIso, timeZone) {
  const localAsUtc = new Date(localIso + 'Z').getTime();
  let guess = new Date(localAsUtc);
  if (Number.isNaN(guess.getTime())) return guess;
  for (let i = 0; i < 2; i++) {
    const offset = timeZoneOffsetMs(guess, timeZone);
    guess = new Date(localAsUtc - offset);
  }
  return guess;
}
function parseBookingTime(value, timeZone) {
  if (value instanceof Date) return value;
  if (typeof value === 'number') return new Date(value);
  let raw = String(value ?? '').trim();
  if (!raw) throw new AppError('booking_time is required.', 'booking_time_required', 400);
  raw = raw.replace(' ', 'T');
  const match = raw.match(new RegExp('^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2})(?::([0-9]{2}))?(?:[.][0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})?$'));
  let date;
  if (match && !match[7]) {
    const local = match[1] + '-' + match[2] + '-' + match[3] + 'T' + match[4] + ':' + match[5] + ':' + (match[6] || '00');
    date = zonedLocalToUtc(local, timeZone);
  } else {
    date = new Date(raw);
  }
  if (Number.isNaN(date.getTime())) {
    throw new AppError('booking_time must be a valid ISO date/time.', 'invalid_booking_time', 400);
  }
  return date;
}
function isWithinBusinessHours(date, config) {
  const parts = zonedParts(date, config.timeZone);
  const minuteOfDay = parts.hour * 60 + parts.minute;
  const openMinutes = config.openHour * 60;
  const closeMinutes = config.closeHour * 60;
  const totalOpenMinutes = (closeMinutes - openMinutes + 1440) % 1440;
  const lastBookingMinute = totalOpenMinutes - config.cutoffMinutes;
  const elapsed = (minuteOfDay - openMinutes + 1440) % 1440;
  const ok = lastBookingMinute > 0 && elapsed >= 0 && elapsed < lastBookingMinute;
  return { ok, reason: ok ? '' : businessHoursMessage(config), config, parts };
}

async function checkAvailability(env, tenantId, bookingTime, durationMinutes) {
  await ensureSchema(env);
  const config = businessConfig(env);
  const start = parseBookingTime(bookingTime, config.timeZone).getTime();
  if (start < Date.now() - 5 * 60000) {
    return { available: false, reason: 'Booking time cannot be in the past.' };
  }
  const hours = isWithinBusinessHours(new Date(start), config);
  if (!hours.ok) return { available: false, reason: hours.reason };

  const duration = Math.max(config.minMinutes, Math.min(config.maxMinutes, Number(durationMinutes) || config.defaultMinutes));
  const end = start + duration * 60000;
  const columns = await getColumns(env, 'bookings');
  const scopeColumn = findColumn(columns, TENANT_COLUMNS);
  const timeColumn = findColumn(columns, ['booking_time', 'start_time', 'reservation_time']);
  const durationColumn = findColumn(columns, ['duration_minutes', 'duration']);
  const statusColumn = findColumn(columns, ['status']);
  if (!scopeColumn || !timeColumn) throw new AppError('bookings schema is incomplete.', 'bookings_schema_incomplete', 500);

  const lowerBound = new Date(start - config.maxMinutes * 60000).toISOString();
  const upperBound = new Date(end).toISOString();
  const where = [
    `${q(scopeColumn)} = ?`,
    `${q(timeColumn)} >= ?`,
    `${q(timeColumn)} <= ?`
  ];
  const params = [tenantId, lowerBound, upperBound];
  if (statusColumn) {
    where.push(`LOWER(COALESCE(${q(statusColumn)}, '')) NOT IN ('cancelled', 'canceled', 'rejected', 'no_show')`);
  }
  const result = await env.DB.prepare(
    `SELECT * FROM ${q('bookings')} WHERE ${where.join(' AND ')} LIMIT 1000`
  ).bind(...params).all();

  const occupied = (result.results || []).filter(row => {
    const bStart = new Date(row[timeColumn]).getTime();
    if (Number.isNaN(bStart)) return false;
    const bEnd = bStart + (Number(row[durationColumn]) || config.defaultMinutes) * 60000;
    return start < bEnd && end > bStart;
  }).length;

  if (occupied >= config.maxTables) {
    return {
      available: false,
      reason: 'All ' + config.maxTables + ' tables are reserved for that time slot.',
      tables_occupied: occupied,
      tables_remaining: 0
    };
  }
  return {
    available: true,
    booking_time: new Date(start).toISOString(),
    duration_minutes: duration,
    tables_occupied: occupied,
    tables_remaining: config.maxTables - occupied,
    max_tables: config.maxTables,
    hours: businessHoursMessage(config)
  };
}
async function createBooking(env, tenantId, args) {
  const availability = await checkAvailability(env, tenantId, args.booking_time, args.duration_minutes);
  if (!availability.available) {
    return { ok: false, code: 'booking_unavailable', ...availability };
  }
  const required = envFlag(env, ENV_KEYS.requireCustomerPhone, false);
  const customerPhone = customerPhoneFrom(args, required);
  const callerRef = await callerFingerprint(env, customerPhone);
  const bookingId = 'BOK-' + makeId(8);
  const partySize = Math.max(1, Math.min(50, Math.floor(Number(args.party_size || args.guests) || 1)));
  await insertScoped(env, 'bookings', tenantId, [
    [['id'], bookingId],
    [['booking_id'], bookingId],
    [['booking_time', 'start_time', 'reservation_time'], availability.booking_time],
    [['duration_minutes', 'duration'], availability.duration_minutes],
    [['party_size', 'guests'], partySize],
    [['customer_name', 'name'], clean(args.customer_name || args.name || '', 120)],
    [['customer_phone', 'phone'], customerPhone || null],
    [['caller_hash'], callerRef],
    [['status'], 'confirmed'],
    [['notes', 'special_requests'], clean(args.notes || '', 1000)],
    [['created_at'], nowIso()],
    [['updated_at'], nowIso()]
  ]);
  let confirmation = { queued: false, reason: 'no_customer_phone' };
  if (customerPhone) {
    const sender = resolvePhones(env, 'business')[0] || '';
    confirmation = await queueNotification(env, tenantId, {
      to: customerPhone,
      from: sender,
      message: 'Alex Pizza reservation confirmed for ' + availability.booking_time + ' (' + availability.duration_minutes + ' minutes).',
      kind: 'booking_confirmation',
      channel: 'sms',
      metadata: { booking_id: bookingId, caller_ref: callerRef }
    });
  }
  await audit(env, tenantId, 'booking_created', { booking_id: bookingId, caller_ref: callerRef, tables_remaining: availability.tables_remaining });
  return {
    ok: true,
    booking_id: bookingId,
    booking_time: availability.booking_time,
    duration_minutes: availability.duration_minutes,
    tables_remaining: availability.tables_remaining,
    status: 'confirmed',
    confirmation
  };
}
async function hasRecentRepeatTask(env, tenantId, dedupeKey, since) {
  const columns = await getColumns(env, 'manager_tasks');
  const scopeColumn = findColumn(columns, TENANT_COLUMNS);
  const createdColumn = findColumn(columns, ['created_at', 'createdAt']);
  const dedupeColumn = findColumn(columns, ['dedupe_key', 'dedupe', 'reference']);
  const descColumn = findColumn(columns, ['description', 'details', 'message']);
  if (!scopeColumn) return false;
  const where = [`${q(scopeColumn)} = ?`];
  const params = [tenantId];
  if (createdColumn) { where.push(`${q(createdColumn)} >= ?`); params.push(since); }
  if (dedupeColumn) { where.push(`${q(dedupeColumn)} = ?`); params.push(dedupeKey); }
  else if (descColumn) { where.push(`${q(descColumn)} LIKE ?`); params.push('%' + dedupeKey + '%'); }
  else return false;
  const row = await env.DB.prepare(
    `SELECT 1 FROM ${q('manager_tasks')} WHERE ${where.join(' AND ')} LIMIT 1`
  ).bind(...params).first();
  return Boolean(row);
}
async function detectRepeatCaller(env, tenantId, customerPhone, purpose = 'Order / support query') {
  await ensureSchema(env);
  const normalizedPhone = normalizePhone(customerPhone);
  const callerRef = await callerFingerprint(env, normalizedPhone);
  const since = new Date(Date.now() - REPEAT_WINDOW_MINUTES * 60000).toISOString();
  const columns = await getColumns(env, 'calls');
  const scopeColumn = findColumn(columns, TENANT_COLUMNS);
  const createdColumn = findColumn(columns, ['created_at', 'createdAt']);
  const hashColumn = findColumn(columns, ['caller_hash', 'phone_hash', 'customer_hash']);
  const phoneColumn = findColumn(columns, ['customer_phone', 'phone', 'caller_phone', 'from_phone']);
  if (!scopeColumn) throw new AppError('calls schema is incomplete.', 'calls_schema_incomplete', 500);

  const where = [`${q(scopeColumn)} = ?`];
  const params = [tenantId];
  if (createdColumn) { where.push(`${q(createdColumn)} >= ?`); params.push(since); }
  const idConditions = [];
  if (hashColumn && normalizedPhone) {
    idConditions.push(`${q(hashColumn)} = ?`);
    params.push(callerRef);
  }
  if (phoneColumn && normalizedPhone) {
    idConditions.push(`${q(phoneColumn)} = ?`);
    params.push(normalizedPhone);
  }
  if (!idConditions.length) where.push('1 = 0');
  else where.push('(' + idConditions.join(' OR ') + ')');

  const recent = await env.DB.prepare(
    `SELECT * FROM ${q('calls')} WHERE ${where.join(' AND ')} LIMIT 100`
  ).bind(...params).all();
  const priorCount = (recent.results || []).length;

  const callId = 'CALL-' + makeId(8);
  await insertScoped(env, 'calls', tenantId, [
    [['id'], callId],
    [['call_id'], callId],
    [['customer_phone', 'phone', 'caller_phone'], envFlag(env, ENV_KEYS.storeRawPhone, true) ? (normalizedPhone || null) : null],
    [['caller_hash'], callerRef],
    [['purpose', 'reason'], clean(purpose, 250)],
    [['direction'], 'inbound'],
    [['created_at'], nowIso()]
  ]);

  if (priorCount < 1) return { flagged: false, callCount: 1, callerRef };

  const windowBucket = Math.floor(Date.now() / (REPEAT_WINDOW_MINUTES * 60000));
  const dedupeKey = 'repeat:' + callerRef + ':' + windowBucket;
  if (await hasRecentRepeatTask(env, tenantId, dedupeKey, since)) {
    return { flagged: true, callCount: priorCount + 1, callerRef, taskId: null, deduplicated: true };
  }

  const taskId = 'TASK-' + makeId(8);
  const description = 'Repeat caller alert. Call count in the last ' + REPEAT_WINDOW_MINUTES +
    ' minutes: ' + (priorCount + 1) + '. Stated purpose: ' + clean(purpose, 300) +
    '. Caller ref: ' + callerRef + '. Dedupe: ' + dedupeKey + '.';
  await insertScoped(env, 'manager_tasks', tenantId, [
    [['id'], taskId],
    [['task_id'], taskId],
    [['title'], 'HIGH PRIORITY: Repeat caller'],
    [['description', 'details'], description],
    [['priority'], 'urgent'],
    [['status'], 'flagged_repeat_caller'],
    [['caller_hash'], callerRef],
    [['dedupe_key', 'dedupe'], dedupeKey],
    [['created_at'], nowIso()]
  ]);
  let notification = { queued: 0, reason: 'manager_phone_unavailable' };
  try {
    notification = await queueRoleNotification(env, tenantId, 'manager', description, 'repeat_caller_alert');
  } catch (err) {
    notification = { queued: 0, reason: clean(err?.code || 'notification_failed', 80) };
  }
  await audit(env, tenantId, 'repeat_caller_flagged', { caller_ref: callerRef, call_count: priorCount + 1, task_id: taskId, notifications: notification.queued });
  return { flagged: true, callCount: priorCount + 1, callerRef, taskId, notification };
}

// ===== BLOCK 6/10: Retention, call minutes, notification queue and receipts =====
async function run60DayDataPurge(env) {
  await ensureSchema(env);
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  let purgedRecords = 0;
  const tables = [];
  for (const table of PURGE_TABLES) {
    try {
      const columns = await getColumns(env, table);
      const createdColumn = findColumn(columns, ['created_at', 'createdAt', 'created']);
      if (!createdColumn) continue;
      const result = await env.DB.prepare(
        `DELETE FROM ${q(table)} WHERE ${q(createdColumn)} < ?`
      ).bind(cutoff).run();
      const changes = Number(result.meta?.changes || 0);
      purgedRecords += changes;
      tables.push({ table, deleted: changes });
    } catch {}
  }
  return { ok: true, purgedRecords, cutoffDate: cutoff, retentionDays: RETENTION_DAYS, tables };
}
async function recordCallMinutes(env, tenantId, durationSeconds) {
  await ensureSchema(env);
  const seconds = Math.max(1, Math.min(86400, Number(durationSeconds) || DEFAULT_CALL_SECONDS));
  const minutes = Math.ceil(seconds / 60);
  const now = new Date();
  const monthKey = nowIso().slice(0, 7);
  const columns = await getColumns(env, 'monthly_call_usage');
  const scopeColumn = findColumn(columns, TENANT_COLUMNS);
  const monthColumn = findColumn(columns, ['month', 'month_key', 'billing_month']);
  const minutesColumn = findColumn(columns, ['total_minutes', 'minutes', 'minutes_used']);
  const lastCallColumn = findColumn(columns, ['last_call_at', 'last_call']);
  const statusColumn = findColumn(columns, ['status']);
  const updatedColumn = findColumn(columns, ['updated_at']);
  if (!scopeColumn || !monthColumn || !minutesColumn) {
    throw new AppError('monthly_call_usage schema is incomplete.', 'usage_schema_incomplete', 500);
  }

  if (now.getUTCDate() === 1 && now.getUTCHours() === 0 && now.getUTCMinutes() < 10 && statusColumn) {
    await env.DB.prepare(
      `UPDATE ${q('monthly_call_usage')} SET ${q(statusColumn)} = 'archived' WHERE ${q(scopeColumn)} = ? AND ${q(monthColumn)} < ?`
    ).bind(tenantId, monthKey).run();
  }

  const set = [`${q(minutesColumn)} = ${q(minutesColumn)} + ?`];
  const setParams = [minutes];
  if (lastCallColumn) { set.push(`${q(lastCallColumn)} = ?`); setParams.push(nowIso()); }
  if (statusColumn) set.push(`${q(statusColumn)} = 'active'`);
  if (updatedColumn) { set.push(`${q(updatedColumn)} = ?`); setParams.push(nowIso()); }
  const updated = await env.DB.prepare(
    `UPDATE ${q('monthly_call_usage')} SET ${set.join(', ')} WHERE ${q(scopeColumn)} = ? AND ${q(monthColumn)} = ?`
  ).bind(...setParams, tenantId, monthKey).run();

  if (!Number(updated.meta?.changes || 0)) {
    const data = { [scopeColumn]: tenantId, [monthColumn]: monthKey, [minutesColumn]: minutes };
    if (lastCallColumn) data[lastCallColumn] = nowIso();
    if (statusColumn) data[statusColumn] = 'active';
    if (updatedColumn) data[updatedColumn] = nowIso();
    const keys = Object.keys(data);
    await env.DB.prepare(
      `INSERT INTO ${q('monthly_call_usage')} (${keys.map(key => q(key)).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`
    ).bind(...keys.map(key => data[key])).run();
  }

  const totalRow = await env.DB.prepare(
    `SELECT ${q(minutesColumn)} AS total_minutes FROM ${q('monthly_call_usage')} WHERE ${q(scopeColumn)} = ? AND ${q(monthColumn)} = ?`
  ).bind(tenantId, monthKey).first();
  return { currentMonth: monthKey, addedMinutes: minutes, monthlyTotal: Number(totalRow?.total_minutes || minutes) };
}
async function setNotificationStatus(env, tenantId, notificationId, status, providerMessageId) {
  try {
    const columns = await getColumns(env, 'notifications');
    const scopeColumn = findColumn(columns, TENANT_COLUMNS);
    const idColumn = findColumn(columns, ['notification_id', 'id']);
    const statusColumn = findColumn(columns, ['status']);
    const providerColumn = findColumn(columns, ['provider_message_id', 'provider_id']);
    if (!scopeColumn || !idColumn || !statusColumn) return;
    const set = [`${q(statusColumn)} = ?`];
    const params = [status];
    if (providerColumn && providerMessageId) { set.push(`${q(providerColumn)} = ?`); params.push(clean(providerMessageId, 200)); }
    params.push(tenantId, notificationId);
    await env.DB.prepare(
      `UPDATE ${q('notifications')} SET ${set.join(', ')} WHERE ${q(scopeColumn)} = ? AND ${q(idColumn)} = ?`
    ).bind(...params).run();
  } catch {}
}
async function deliverNotification(env, payload) {
  const rawUrl = envValue(env, ENV_KEYS.webhookUrl);
  if (!rawUrl) return { delivered: false, skipped: true, reason: 'webhook_not_configured' };
  const url = assertHttpsUrl(rawUrl, 'webhook_url_invalid');
  const token = envValue(env, ENV_KEYS.webhookToken);
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...payload, sent_at: nowIso() })
  }, 6000);
  return { delivered: response.ok, skipped: false, provider_status: response.status };
}
async function queueNotification(env, tenantId, options) {
  await ensureSchema(env);
  const to = normalizePhone(options?.to);
  if (!to) throw new AppError('A valid recipient phone is required.', 'recipient_phone_missing', 400);
  const from = normalizePhone(options?.from || '');
  const channel = clean(options?.channel || (String(options?.kind || '').includes('whatsapp') ? 'whatsapp' : 'sms'), 40);
  const id = 'NOT-' + makeId(8);
  const payload = {
    notification_id: id,
    tenant_id: tenantId,
    to,
    from: from || null,
    channel,
    kind: clean(options?.kind || 'general', 80),
    message: clean(options?.message || '', 3000),
    metadata: sanitizeDetails(options?.metadata || {})
  };
  await insertScoped(env, 'notifications', tenantId, [
    [['id'], id],
    [['notification_id'], id],
    [['recipient_phone', 'to_phone'], to],
    [['sender_phone', 'from_phone'], from || null],
    [['message'], payload.message],
    [['notification_type', 'type'], payload.kind],
    [['channel'], channel],
    [['status'], 'queued'],
    [['metadata', 'payload'], JSON.stringify(payload.metadata).slice(0, 2000)],
    [['created_at'], nowIso()]
  ]);
  let delivery;
  try {
    delivery = await deliverNotification(env, payload);
    const status = delivery.skipped ? 'queued' : (delivery.delivered ? 'sent_to_provider' : 'provider_rejected');
    await setNotificationStatus(env, tenantId, id, status);
  } catch (err) {
    delivery = { delivered: false, skipped: false, error: clean(publicError(err).error, 160) };
    await setNotificationStatus(env, tenantId, id, 'provider_error');
  }
  return { id, queued: true, channel, ...delivery };
}
async function queueRoleNotification(env, tenantId, role, message, kind) {
  const phones = requirePhones(env, role);
  const sender = resolvePhones(env, 'business')[0] || '';
  const channel = role === 'manager' ? 'whatsapp' : (String(kind).includes('sms') ? 'sms' : 'dashboard');
  const results = [];
  for (const phone of phones) {
    results.push(await queueNotification(env, tenantId, {
      to: phone,
      from: sender,
      message,
      kind,
      channel,
      metadata: { role }
    }));
  }
  return { queued: results.length, ids: results.map(item => item.id) };
}
function buildReceiptText(order) {
  const lines = [
    'Order ' + order.order_id,
    'Type: ' + order.order_type,
    ...order.items.map(item => item.quantity + ' x ' + item.name + ' @ ' + money(item.unit_price) + ' = ' + money(item.line_total)),
    'Total: ' + money(order.total) + ' ' + order.currency
  ];
  if (order.notes) lines.push('Notes: ' + order.notes);
  return lines.join(NL).slice(0, 2500);
}
async function dispatchOrderReceipt(env, tenantId, order, customerPhone) {
  const receipt = buildReceiptText(order);
  let manager = { queued: 0, reason: 'manager_phone_unavailable' };
  try {
    manager = await queueRoleNotification(env, tenantId, 'manager', 'POS ORDER: ' + receipt, 'whatsapp_manager_pos');
  } catch (err) {
    manager = { queued: 0, reason: clean(err?.code || 'notification_failed', 80) };
  }
  let customer = { queued: false, reason: 'no_customer_phone' };
  if (customerPhone) {
    customer = await queueNotification(env, tenantId, {
      to: customerPhone,
      from: resolvePhones(env, 'business')[0] || '',
      message: 'Alex Pizza Receipt:' + NL + receipt,
      kind: 'customer_carrier_sms',
      channel: 'sms',
      metadata: { order_id: order.order_id }
    });
  }
  return { status: 'queued_for_dashboard_and_provider', manager, customer, receipt_preview: receipt.slice(0, 300) };
}

// ===== BLOCK 7/10: Zoho OAuth and optional POS push =====
async function ensureZohoTokenRow(env, tenantId) {
  const columns = await getColumns(env, 'zoho_oauth_tokens');
  const scopeColumn = findColumn(columns, TENANT_COLUMNS);
  const refreshColumn = findColumn(columns, ['refresh_token']);
  const updatedColumn = findColumn(columns, ['updated_at']);
  if (!scopeColumn || !refreshColumn) {
    throw new AppError('zoho_oauth_tokens schema is incomplete.', 'zoho_schema_incomplete', 500);
  }
  const envRefresh = envValue(env, ENV_KEYS.zohoRefreshToken);
  if (envRefresh) {
    const existing = await env.DB.prepare(
      `SELECT 1 FROM ${q('zoho_oauth_tokens')} WHERE ${q(scopeColumn)} = ? LIMIT 1`
    ).bind(tenantId).first();
    if (existing) {
      const set = [`${q(refreshColumn)} = ?`];
      const params = [envRefresh];
      if (updatedColumn) { set.push(`${q(updatedColumn)} = ?`); params.push(nowIso()); }
      params.push(tenantId);
      await env.DB.prepare(
        `UPDATE ${q('zoho_oauth_tokens')} SET ${set.join(', ')} WHERE ${q(scopeColumn)} = ?`
      ).bind(...params).run();
    } else {
      const data = { [scopeColumn]: tenantId, [refreshColumn]: envRefresh };
      if (updatedColumn) data[updatedColumn] = nowIso();
      const keys = Object.keys(data);
      await env.DB.prepare(
        `INSERT INTO ${q('zoho_oauth_tokens')} (${keys.map(key => q(key)).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`
      ).bind(...keys.map(key => data[key])).run();
    }
  }
  return { columns, scopeColumn, refreshColumn };
}
async function getZohoAccessToken(env, tenantId) {
  await ensureSchema(env);
  const { columns, scopeColumn, refreshColumn } = await ensureZohoTokenRow(env, tenantId);
  const clientId = envValue(env, ENV_KEYS.zohoClientId);
  const clientSecret = envValue(env, ENV_KEYS.zohoClientSecret);
  const row = await env.DB.prepare(
    `SELECT * FROM ${q('zoho_oauth_tokens')} WHERE ${q(scopeColumn)} = ? LIMIT 1`
  ).bind(tenantId).first();
  const refreshToken = row?.[refreshColumn] || envValue(env, ENV_KEYS.zohoRefreshToken);
  if (!clientId || !clientSecret || !refreshToken) {
    throw new AppError('Zoho POS is not fully configured.', 'zoho_not_configured', 503);
  }
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = Number(row?.expires_at || 0);
  if (row?.access_token && expiresAt > now + 120) return row.access_token;

  const tokenUrl = assertHttpsUrl(
    envValue(env, ENV_KEYS.zohoTokenUrl) || ZOHO_TOKEN_URL_DEFAULT,
    'zoho_token_url_invalid'
  );
  const response = await fetchWithTimeout(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken
    }).toString()
  }, 8000);
  let data = {};
  try { data = await response.json(); } catch {}
  if (!response.ok || !data.access_token) {
    throw new AppError('Zoho token refresh failed: ' + clean(data.error || 'provider error', 120), 'zoho_token_refresh_failed', 502);
  }
  const newExpiry = now + (Number(data.expires_in) || 3600);
  const set = [];
  const params = [];
  const accessColumn = findColumn(columns, ['access_token']);
  const expiryColumn = findColumn(columns, ['expires_at']);
  const updatedColumn = findColumn(columns, ['updated_at']);
  if (accessColumn) { set.push(`${q(accessColumn)} = ?`); params.push(data.access_token); }
  if (expiryColumn) { set.push(`${q(expiryColumn)} = ?`); params.push(newExpiry); }
  if (updatedColumn) { set.push(`${q(updatedColumn)} = ?`); params.push(nowIso()); }
  if (set.length) {
    params.push(tenantId);
    await env.DB.prepare(
      `UPDATE ${q('zoho_oauth_tokens')} SET ${set.join(', ')} WHERE ${q(scopeColumn)} = ?`
    ).bind(...params).run();
  }
  return data.access_token;
}
async function pushOrderToZoho(env, tenantId, order) {
  const rawUrl = envValue(env, ENV_KEYS.zohoPosUrl);
  if (!rawUrl) return { pushed: false, reason: 'zoho_pos_not_configured' };
  const url = assertHttpsUrl(rawUrl, 'zoho_pos_url_invalid');
  const token = await getZohoAccessToken(env, tenantId);
  const payload = {
    source: WORKER_NAME,
    tenant_id: tenantId,
    order_id: order.order_id,
    order_type: order.order_type,
    currency: order.currency,
    total: order.total,
    items: order.items.map(item => ({
      sku: item.sku, name: item.name, quantity: item.quantity,
      unit_price: item.unit_price, line_total: item.line_total
    })),
    caller_ref: order.callerRef,
    created_at: order.createdAt
  };
  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + token
    },
    body: JSON.stringify(payload)
  }, 8000);
  await recordIntegrationStatus(env, tenantId, 'zoho_pos', response.ok ? 'ok' : 'error', {
    order_id: order.order_id,
    provider_status: response.status
  });
  return { pushed: response.ok, provider_status: response.status };
}

// ===== BLOCK 8/10: Order pricing, order persistence and order tools =====
function normalizeOrderItems(raw) {
  let items = raw;
  if (typeof items === 'string') {
    try { items = JSON.parse(items); }
    catch { throw new AppError('order items must be valid JSON.', 'invalid_items', 400); }
  }
  if (!Array.isArray(items) && items && typeof items === 'object') {
    if (Array.isArray(items.items)) items = items.items;
    else items = Object.entries(items).map(([sku, value]) =>
      value && typeof value === 'object' ? { sku, ...value } : { sku, quantity: value }
    );
  }
  if (!Array.isArray(items)) return [];
  return items.slice(0, MAX_ORDER_ITEMS).map(item => {
    const source = item && typeof item === 'object' ? item : { sku: item };
    const quantity = Math.max(1, Math.min(99, Math.floor(Number(source.quantity ?? source.qty ?? source.count) || 1)));
    return {
      sku: clean(source.sku ?? source.id ?? source.menu_item_id ?? '', 80),
      name: clean(source.name ?? source.item_name ?? '', 200),
      requestedPrice: parseMoney(source.price ?? source.unit_price ?? 0),
      quantity
    };
  });
}
async function loadPricedItems(env, tenantId, rawItems, argsTotal) {
  const requested = normalizeOrderItems(rawItems);
  if (!requested.length) {
    const manualTotal = parseMoney(argsTotal);
    if (manualTotal > 0 && envFlag(env, ENV_KEYS.allowManualTotal, false)) {
      return [{
        sku: 'CUSTOM-TOTAL',
        name: 'Custom order total',
        category: 'Custom',
        unitPrice: manualTotal,
        quantity: 1,
        lineTotal: manualTotal
      }];
    }
    throw new AppError('Order items are required.', 'order_items_required', 400);
  }
  const identifiers = requested.flatMap(item => [item.sku, item.name]).filter(Boolean);
  const menuMap = await findMenuItemsBySku(env, tenantId, identifiers);
  return requested.map(item => {
    const key = norm(item.sku || item.name).replace(/[ _-]+/g, '');
    const menuItem = menuMap.get(norm(item.sku)) || menuMap.get(key) || menuMap.get(norm(item.name));
    if (!menuItem) {
      throw new AppError('Menu item not found: ' + clean(item.sku || item.name, 80), 'menu_item_not_found', 400);
    }
    const unitPrice = roundMoney(menuItem.price);
    return {
      sku: menuItem.sku,
      name: menuItem.name,
      category: menuItem.category,
      unitPrice,
      quantity: item.quantity,
      lineTotal: roundMoney(unitPrice * item.quantity)
    };
  });
}
async function createOrderRecord(env, tenantId, args, pricedItems, callerRef, resolvedCustomerPhone) {
  const orderId = 'ORD-' + makeId(8);
  const total = roundMoney(pricedItems.reduce((sum, item) => sum + item.lineTotal, 0));
  const customerPhone = resolvedCustomerPhone === undefined
    ? customerPhoneFrom(args, true)
    : normalizePhone(resolvedCustomerPhone);
  const customerName = clean(args.customer_name || args.name || '', 120);
  const orderType = (() => {
    const value = norm(args.order_type || args.fulfillment_type || 'pickup');
    return ['pickup', 'delivery', 'dine_in'].includes(value) ? value : 'pickup';
  })();
  const notes = clean(args.notes || args.special_instructions || '', 1000);
  const createdAt = nowIso();
  await insertScoped(env, 'orders', tenantId, [
    [['id'], orderId],
    [['order_id'], orderId],
    [['customer_name', 'name'], customerName],
    [['customer_phone', 'phone'], envFlag(env, ENV_KEYS.storeRawPhone, true) ? customerPhone : null],
    [['caller_hash'], callerRef],
    [['order_type', 'fulfillment_type'], orderType],
    [['total', 'total_amount', 'amount'], total],
    [['currency'], CURRENCY],
    [['items_json', 'items'], JSON.stringify(pricedItems).slice(0, 8000)],
    [['status'], 'submitted'],
    [['notes', 'special_instructions'], notes],
    [['created_at'], createdAt],
    [['updated_at'], createdAt]
  ]);
  for (const item of pricedItems) {
    await insertScoped(env, 'order_items', tenantId, [
      [['id'], makeId(16)],
      [['order_id'], orderId],
      [['sku'], item.sku],
      [['name', 'item_name'], item.name],
      [['category'], item.category],
      [['unit_price', 'price'], item.unitPrice],
      [['quantity'], item.quantity],
      [['line_total'], item.lineTotal],
      [['created_at'], createdAt]
    ]);
  }
  return {
    order_id: orderId,
    customer_name: customerName,
    customerPhone,
    callerRef,
    order_type: orderType,
    currency: CURRENCY,
    total,
    items: pricedItems,
    notes,
    status: 'submitted',
    createdAt
  };
}
async function submitOrder(env, tenantId, args, ctx) {
  await ensureSchema(env);
  const customerPhone = customerPhoneFrom(args, envFlag(env, ENV_KEYS.requireCustomerPhone, true));
  const pricedItems = await loadPricedItems(env, tenantId, args.items ?? args.order_items, args.total);
  const callerRef = await callerFingerprint(env, customerPhone);
  const repeat = await detectRepeatCaller(env, tenantId, customerPhone, args.call_purpose || 'New order submission');
  const order = await createOrderRecord(env, tenantId, args, pricedItems, callerRef, customerPhone);
  const receipt = await dispatchOrderReceipt(env, tenantId, order, customerPhone);
  const usage = await recordCallMinutes(env, tenantId, args.duration_seconds || args.call_duration_seconds || DEFAULT_CALL_SECONDS);
  if (ctx?.waitUntil) {
    ctx.waitUntil(pushOrderToZoho(env, tenantId, order).catch(async err => {
      safeLog(err);
      await recordIntegrationStatus(env, tenantId, 'zoho_pos', 'error', {
        order_id: order.order_id,
        code: clean(err?.code || 'zoho_push_failed', 80)
      });
    }));
  }
  await audit(env, tenantId, 'order_submitted', {
    order_id: order.order_id,
    total: order.total,
    item_count: order.items.length,
    caller_ref: callerRef,
    repeat_flagged: repeat.flagged
  });
  return {
    ok: true,
    order_id: order.order_id,
    status: 'submitted_to_d1',
    total: order.total,
    currency: order.currency,
    item_count: order.items.length,
    repeat_caller_alert: repeat.flagged,
    caller_ref: callerRef,
    receipt,
    call_minutes: usage,
    zoho_pos: 'queued_if_configured'
  };
}
async function getOrderStatus(env, tenantId, args) {
  await ensureSchema(env);
  const orderId = clean(args.order_id || args.id || '', 100);
  if (!orderId) throw new AppError('order_id is required.', 'order_id_required', 400);
  const columns = await getColumns(env, 'orders');
  const scopeColumn = findColumn(columns, TENANT_COLUMNS);
  const idColumn = findColumn(columns, ['order_id', 'id']);
  const statusColumn = findColumn(columns, ['status']);
  const totalColumn = findColumn(columns, ['total', 'total_amount', 'amount']);
  const createdColumn = findColumn(columns, ['created_at']);
  const currencyColumn = findColumn(columns, ['currency']);
  if (!scopeColumn || !idColumn) throw new AppError('orders schema is incomplete.', 'orders_schema_incomplete', 500);
  const row = await env.DB.prepare(
    `SELECT * FROM ${q('orders')} WHERE ${q(scopeColumn)} = ? AND ${q(idColumn)} = ? LIMIT 1`
  ).bind(tenantId, orderId).first();
  if (!row) throw new AppError('Order not found.', 'order_not_found', 404);
  return {
    ok: true,
    order_id: orderId,
    status: statusColumn ? clean(row[statusColumn], 80) : 'unknown',
    total: totalColumn ? parseMoney(row[totalColumn]) : 0,
    currency: currencyColumn ? clean(row[currencyColumn], 10) : CURRENCY,
    created_at: createdColumn ? row[createdColumn] : null
  };
}
async function requestOrderChange(env, tenantId, args) {
  await ensureSchema(env);
  const orderId = clean(args.order_id || args.id || '', 100);
  const requestedChange = clean(args.requested_change || args.change || args.message || '', 2000);
  if (!orderId || !requestedChange) {
    throw new AppError('order_id and requested_change are required.', 'change_request_incomplete', 400);
  }
  const callerRef = await callerFingerprint(env, customerPhoneFrom(args, false));
  const requestId = 'CHG-' + makeId(8);
  await insertScoped(env, 'order_change_requests', tenantId, [
    [['id', 'request_id'], requestId],
    [['order_id'], orderId],
    [['caller_hash'], callerRef],
    [['requested_change', 'change', 'message'], requestedChange],
    [['reason'], clean(args.reason || '', 500)],
    [['status'], 'pending_manager_review'],
    [['created_at'], nowIso()]
  ]);
  await audit(env, tenantId, 'order_change_requested', { order_id: orderId, request_id: requestId, caller_ref: callerRef });
  return { ok: true, request_id: requestId, status: 'pending_manager_review' };
}
function getBusinessInfo(env) {
  const config = businessConfig(env);
  return {
    ok: true,
    name: 'Alex Pizza NYC',
    currency: CURRENCY,
    time_zone: config.timeZone,
    hours: businessHoursMessage(config),
    open_hour: config.openHour,
    close_hour: config.closeHour,
    reservation_cutoff_minutes: config.cutoffMinutes,
    max_tables: config.maxTables,
    manager_phone_configured: resolvePhones(env, 'manager').length > 0,
    business_phone_configured: resolvePhones(env, 'business').length > 0
  };
}

// ===== BLOCK 9/10: Vapi tool registry and tool-call executor =====
function toToolKey(name) {
  return String(name ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[ ._-]+/g, '_')
    .toLowerCase();
}
const TOOL_ALIASES = new Map(Object.entries({
  menu: 'get_menu',
  getMenu: 'get_menu',
  checkAvailability: 'check_table_availability',
  checkTableAvailability: 'check_table_availability',
  availability: 'check_table_availability',
  bookTable: 'book_table',
  createBooking: 'book_table',
  reserveTable: 'book_table',
  submitOrder: 'submit_order',
  placeOrder: 'submit_order',
  order: 'submit_order',
  orderStatus: 'get_order_status',
  getOrder: 'get_order_status',
  changeOrder: 'request_order_change',
  requestChange: 'request_order_change',
  businessInfo: 'get_business_info',
  hours: 'get_business_info',
  repeatCaller: 'flag_repeat_caller'
}).map(([key, value]) => [toToolKey(key), value]));
function resolveToolName(name) {
  const key = toToolKey(name);
  return TOOL_ALIASES.get(key) || key;
}

const TOOL_HANDLERS = {
  async get_menu(env, tenantId, args) {
    const menu = await getMenuRows(env, tenantId, {
      category: args.category,
      search: args.search || args.query,
      limit: args.limit,
      includeInactive: envFlag(env, ['MENU_INCLUDE_INACTIVE'], false)
    });
    if (!menu.length && envFlag(env, ['AUTO_SYNC_MENU'], true)) {
      await syncAndReplaceD1Menu(env, tenantId);
      return { ok: true, menu: await getMenuRows(env, tenantId, {}), count: OFFICIAL_MENU.length, currency: CURRENCY, auto_synced: true };
    }
    return { ok: true, menu, count: menu.length, currency: CURRENCY };
  },
  async check_table_availability(env, tenantId, args) {
    return await checkAvailability(env, tenantId, args.booking_time, args.duration_minutes);
  },
  async book_table(env, tenantId, args) {
    return await createBooking(env, tenantId, args);
  },
  async submit_order(env, tenantId, args, ctx) {
    return await submitOrder(env, tenantId, args, ctx);
  },
  async get_order_status(env, tenantId, args) {
    return await getOrderStatus(env, tenantId, args);
  },
  async request_order_change(env, tenantId, args) {
    return await requestOrderChange(env, tenantId, args);
  },
  async get_business_info(env) {
    return getBusinessInfo(env);
  },
  async flag_repeat_caller(env, tenantId, args) {
    const phone = customerPhoneFrom(args, true);
    return { ok: true, ...(await detectRepeatCaller(env, tenantId, phone, args.purpose || 'Caller requested assistance')) };
  }
};

const TOOL_CATALOG = [
  {
    name: 'get_menu',
    description: 'Return active Alex Pizza menu items and prices.',
    parameters: { type: 'object', properties: { category: { type: 'string' }, search: { type: 'string' }, limit: { type: 'number' } }, additionalProperties: false }
  },
  {
    name: 'check_table_availability',
    description: 'Check reservation availability in business time zone.',
    parameters: { type: 'object', properties: { booking_time: { type: 'string' }, duration_minutes: { type: 'number' } }, required: ['booking_time'], additionalProperties: false }
  },
  {
    name: 'book_table',
    description: 'Create a confirmed table reservation after checking availability.',
    parameters: { type: 'object', properties: { booking_time: { type: 'string' }, duration_minutes: { type: 'number' }, party_size: { type: 'number' }, customer_name: { type: 'string' }, customer_phone: { type: 'string' }, notes: { type: 'string' } }, required: ['booking_time'], additionalProperties: false }
  },
  {
    name: 'submit_order',
    description: 'Price items against D1 menu, persist order, queue receipts and push to POS if configured.',
    parameters: { type: 'object', properties: { items: { type: 'array' }, customer_phone: { type: 'string' }, customer_name: { type: 'string' }, order_type: { type: 'string' }, notes: { type: 'string' }, duration_seconds: { type: 'number' } }, required: ['items', 'customer_phone'], additionalProperties: false }
  },
  {
    name: 'get_order_status',
    description: 'Look up an existing order by order_id.',
    parameters: { type: 'object', properties: { order_id: { type: 'string' } }, required: ['order_id'], additionalProperties: false }
  },
  {
    name: 'request_order_change',
    description: 'Queue an order change request for manager review.',
    parameters: { type: 'object', properties: { order_id: { type: 'string' }, requested_change: { type: 'string' }, reason: { type: 'string' }, customer_phone: { type: 'string' } }, required: ['order_id', 'requested_change'], additionalProperties: false }
  },
  {
    name: 'get_business_info',
    description: 'Return hours, time zone, capacity and non-sensitive configuration status.',
    parameters: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'flag_repeat_caller',
    description: 'Log a call and raise a manager alert for repeat callers inside the configured window.',
    parameters: { type: 'object', properties: { customer_phone: { type: 'string' }, purpose: { type: 'string' } }, required: ['customer_phone'], additionalProperties: false }
  }
];

function extractToolCalls(body) {
  const message = body?.message && typeof body.message === 'object' ? body.message : {};
  const candidates = [
    message.toolCallList, message.toolCalls, message.tool_calls,
    body?.toolCallList, body?.toolCalls, body?.tool_calls, body?.calls
  ];
  const list = candidates.find(value => Array.isArray(value)) || [];
  return list.slice(0, MAX_TOOL_CALLS);
}
function getToolCallId(call, index) {
  return clean(call?.toolCallId || call?.id || call?.callId || ('call-' + index), 120);
}
function getToolName(call) {
  return clean(call?.function?.name || call?.name || call?.tool?.name || '', 120);
}
function getToolArgs(call) {
  return parseArgs(
    call?.function?.arguments ?? call?.arguments ?? call?.parameters ?? call?.tool?.arguments ?? {}
  );
}
async function executeToolCall(env, tenantId, call, index, ctx) {
  const callId = getToolCallId(call, index);
  try {
    const toolName = getToolName(call);
    const key = resolveToolName(toolName);
    const handler = TOOL_HANDLERS[key];
    if (!handler) {
      throw new AppError('Unknown tool: ' + clean(toolName, 100), 'unknown_tool', 404, {
        available_tools: Object.keys(TOOL_HANDLERS)
      });
    }
    const args = getToolArgs(call);
    const payload = await handler(env, tenantId, args, ctx);
    return toolResult(callId, payload);
  } catch (err) {
    return toolResult(callId, publicError(err));
  }
}
async function handleVapiTools(request, env, ctx, tenantId) {
  await requireToolAuth(request, env);
  const blocked = requireMethod(request, env, 'POST');
  if (blocked) return blocked;
  await ensureSchema(env);
  const body = await readJson(request, env);
  const calls = extractToolCalls(body);
  const results = [];
  for (let i = 0; i < calls.length; i++) {
    results.push(await executeToolCall(env, tenantId, calls[i], i, ctx));
  }
  return json(request, env, { results, tool_count: results.length, tenant_id: tenantId });
}
async function handleToolCatalog(request, env, tenantId) {
  await requireToolAuth(request, env);
  return json(request, env, { ok: true, tenant_id: tenantId, tools: TOOL_CATALOG });
}

// ===== BLOCK 10/10: Router, admin endpoints, cron and export =====
function routePath(url) {
  return url.pathname.replace(/[/]+$/, '') || '/';
}
function adminTenant(request, url, body) {
  return validateTenant(body?.tenant_id || body?.tenantId || url.searchParams.get('tenant_id'));
}
async function handleAdmin(request, env, url, path) {
  await requireAdminAuth(request, env);
  const blocked = requireMethod(request, env, 'POST');
  if (blocked) return blocked;
  const body = await readJson(request, env);
  const tenantId = adminTenant(request, url, body);

  if (path === '/admin/bootstrap') {
    const schema = await ensureSchema(env);
    await audit(env, tenantId, 'schema_bootstrap', schema);
    return json(request, env, { ok: true, tenant_id: tenantId, schema: 'ready', ...schema });
  }
  if (path === '/admin/sync-menu') {
    const result = await syncAndReplaceD1Menu(env, tenantId);
    return json(request, env, { ok: true, result });
  }
  if (path === '/admin/purge-60-days') {
    const result = await run60DayDataPurge(env);
    await audit(env, tenantId, 'manual_purge', { purgedRecords: result.purgedRecords });
    return json(request, env, { ok: true, result });
  }
  if (path === '/admin/zoho-token') {
    await getZohoAccessToken(env, tenantId);
    return json(request, env, { ok: true, tenant_id: tenantId, token_available: true });
  }
  return json(request, env, { ok: false, error: 'Admin route not found', code: 'admin_route_not_found' }, 404);
}
async function handleFetch(request, env, ctx) {
  if (request.method === 'OPTIONS') return preflight(request, env);
  const url = new URL(request.url);
  const path = routePath(url);

  try {
    if (request.method === 'GET' && (path === '/' || path === '/health')) {
      return json(request, env, {
        ok: true,
        service: WORKER_NAME,
        status: 'Alex Pizza AI Core Active',
        time: nowIso(),
        db_configured: Boolean(env?.DB),
        tool_auth_configured: Boolean(envValue(env, ENV_KEYS.toolSecret)),
        admin_auth_configured: Boolean(envValue(env, ENV_KEYS.adminToken)),
        manager_phones_configured: resolvePhones(env, 'manager').length,
        business_phones_configured: resolvePhones(env, 'business').length,
        zoho_oauth_configured: Boolean(
          envValue(env, ENV_KEYS.zohoClientId) &&
          envValue(env, ENV_KEYS.zohoClientSecret) &&
          envValue(env, ENV_KEYS.zohoRefreshToken) &&
          env?.DB
        ),
        zoho_pos_endpoint_configured: Boolean(envValue(env, ENV_KEYS.zohoPosUrl)),
        zoho_pos_configured: Boolean(
          envValue(env, ENV_KEYS.zohoClientId) &&
          envValue(env, ENV_KEYS.zohoClientSecret) &&
          envValue(env, ENV_KEYS.zohoRefreshToken) &&
          envValue(env, ENV_KEYS.zohoPosUrl) &&
          env?.DB
        ),
        zoho_missing_configuration: [
          ...(!envValue(env, ENV_KEYS.zohoClientId) ? ['ZOHO_CLIENT_ID'] : []),
          ...(!envValue(env, ENV_KEYS.zohoClientSecret) ? ['ZOHO_CLIENT_SECRET'] : []),
          ...(!envValue(env, ENV_KEYS.zohoRefreshToken) ? ['ZOHO_REFRESH_TOKEN'] : []),
          ...(!envValue(env, ENV_KEYS.zohoPosUrl) ? ['ZOHO_POS_ORDER_URL or ZOHO_ORDER_WEBHOOK_URL'] : []),
          ...(!env?.DB ? ['D1 binding DB'] : [])
        ],
        notification_webhook_configured: Boolean(envValue(env, ENV_KEYS.webhookUrl))
      });
    }

    if (path.startsWith('/admin/')) return await handleAdmin(request, env, url, path);

    const match = path.match(new RegExp('^/vapi/([a-z0-9-]+)/tools$', 'i'));
    if (match) {
      const tenantId = validateTenant(match[1]);
      if (request.method === 'GET') return await handleToolCatalog(request, env, tenantId);
      if (request.method === 'POST') return await handleVapiTools(request, env, ctx, tenantId);
      return json(request, env, { ok: false, error: 'Method not allowed', code: 'method_not_allowed' }, 405, { Allow: 'GET, POST' });
    }

    return json(request, env, { ok: false, error: 'Route not found', code: 'route_not_found' }, 404);
  } catch (err) {
    safeLog(err);
    return httpErrorResponse(request, env, err);
  }
}
async function handleScheduled(env) {
  try {
    await ensureSchema(env);
    const purge = await run60DayDataPurge(env);
    await audit(env, DEFAULT_TENANT, 'scheduled_purge', { purgedRecords: purge.purgedRecords });
    return purge;
  } catch (err) {
    safeLog(err);
    return { ok: false, ...publicError(err) };
  }
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduled(env));
  },
  async fetch(request, env, ctx) {
    return handleFetch(request, env, ctx);
  }
};