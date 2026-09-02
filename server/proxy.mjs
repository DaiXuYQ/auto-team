import * as http from 'node:http';
import * as https from 'node:https';
import { ProxyAgent } from 'proxy-agent';

const SUPPORTED_PROTOCOLS = new Set(['http:', 'https:', 'socks:', 'socks4:', 'socks4a:', 'socks5:', 'socks5h:']);
const agentCache = new Map();
const runtime = new Map();
let cursor = 0;

function hostPort(value) {
  const match = String(value || '').trim().match(/^(.+):(\d{1,5})$/);
  if (!match) return null;
  const port = Number(match[2]);
  return port >= 1 && port <= 65535 ? { host: match[1], port } : null;
}

function normalizeHost(value) {
  const host = String(value || '').trim();
  return host.replace(/^\[|\]$/g, '');
}

function hostForUrl(value) {
  const host = normalizeHost(value);
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

function encodePart(value) {
  return encodeURIComponent(String(value || ''));
}

function proxyUrlFromParts(protocol, host, port, username = '', password = '') {
  const auth = username || password ? `${encodePart(username)}:${encodePart(password)}@` : '';
  return `${protocol}//${auth}${hostForUrl(host)}:${port}`;
}

function credentialsFrom(value) {
  const source = String(value || '').trim();
  const separator = source.indexOf(':');
  if (separator < 0) return [source, ''];
  return [source.slice(0, separator).trim(), source.slice(separator + 1).trim()];
}

function normalizedProtocol(protocol) {
  const value = String(protocol || 'http:').toLowerCase().replace(/:$/, '');
  // SOCKS5H keeps destination DNS resolution inside the proxy. Treat the
  // common SOCKS5 spellings as that mode so a proxy cannot resolve targets
  // locally by accident.
  if (value === 'socks' || value === 'socks5' || value === 'socks5h') return 'socks5h:';
  return `${value}:`;
}

function sourceTypeForHost(host) {
  const value = String(host || '').toLowerCase();
  return /^(localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|::1|\[::1\])$/.test(value) ? 'local' : 'residential';
}

export function parseProxyInput(input) {
  // Proxy lists are often copied from shell snippets where @ is escaped.
  // Remove only backslashes immediately before an authority separator so
  // credentials containing other backslashes remain unchanged.
  let value = String(input || '').trim().replace(/\\+(?=@)/g, '');
  if (!value) throw new Error('proxy_required');
  let protocol = 'http:';
  let host;
  let port;
  let username = '';
  let password = '';

  if (/^[a-z][a-z\d+.-]*:\/\//i.test(value)) {
    const parsed = new URL(value);
    protocol = normalizedProtocol(parsed.protocol);
    if (!SUPPORTED_PROTOCOLS.has(protocol)) throw new Error('unsupported_proxy_protocol');
    host = normalizeHost(parsed.hostname);
    port = Number(parsed.port || (protocol === 'http:' || protocol === 'https:' ? 8080 : 1080));
    try {
      username = decodeURIComponent(parsed.username || '');
      password = decodeURIComponent(parsed.password || '');
    } catch {
      throw new Error('invalid_proxy_credentials');
    }
  } else {
    const at = value.lastIndexOf('@');
    if (at > 0) {
      const left = value.slice(0, at).trim();
      const right = value.slice(at + 1).trim();
      const leftHost = hostPort(left);
      const rightHost = hostPort(right);
      if (leftHost && !rightHost) {
        host = normalizeHost(leftHost.host); port = leftHost.port;
        [username, password] = credentialsFrom(right);
      } else if (rightHost) {
        host = normalizeHost(rightHost.host); port = rightHost.port;
        [username, password] = credentialsFrom(left);
      } else throw new Error('invalid_proxy_host');
    } else {
      const parts = value.split(':').map((part) => part.trim());
      if (parts.length >= 4 && /^\d+$/.test(parts[1])) {
        host = normalizeHost(parts.shift()); port = Number(parts.shift()); username = parts.shift() || ''; password = parts.join(':');
      } else {
        const parsedHost = hostPort(value);
        if (!parsedHost) throw new Error('invalid_proxy_format');
        host = normalizeHost(parsedHost.host); port = parsedHost.port;
      }
    }
  }
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid_proxy_host');
  const url = proxyUrlFromParts(protocol, host, port, username, password);
  return { url, protocol: protocol.slice(0, -1), host, port, username, password, sourceType: sourceTypeForHost(host) };
}

export function maskProxyUrl(value) {
  try {
    const parsed = new URL(String(value));
    const auth = parsed.username || parsed.password ? '***:***@' : '';
    return `${parsed.protocol}//${auth}${parsed.hostname}:${parsed.port || (parsed.protocol.startsWith('socks') ? 1080 : 8080)}`;
  } catch { return '无效代理'; }
}

function proxyEntrySummary(entry) {
  return {
    id: entry.id,
    label: entry.label || '',
    display: entry.display || maskProxyUrl(entry.url),
    protocol: entry.protocol || '',
    host: entry.host || '',
    port: Number(entry.port) || null,
    sourceType: entry.sourceType || sourceTypeForHost(entry.host),
    hasAuth: Boolean(entry.username || entry.password),
    healthy: runtime.get(entry.id)?.healthy !== false,
    failures: runtime.get(entry.id)?.failures || 0,
    cooldownUntil: runtime.get(entry.id)?.cooldownUntil || null,
  };
}

export function publicProxySettings(settings = {}) {
  const proxy = settings.proxy || {};
  const timeoutMs = Number(proxy.timeoutMs);
  const maxRetries = Number(proxy.maxRetries);
  return {
    enabled: proxy.enabled === true,
    strategy: proxy.strategy === 'round_robin' ? 'round_robin' : 'failover',
    timeoutMs: Number.isFinite(timeoutMs) ? Math.min(120000, Math.max(1000, timeoutMs)) : 15000,
    maxRetries: Number.isFinite(maxRetries) ? Math.min(5, Math.max(0, maxRetries)) : 2,
    entries: Array.isArray(proxy.entries) ? proxy.entries.map(proxyEntrySummary) : [],
  };
}

function usableEntries(config = {}, excluded = new Set()) {
  const entries = Array.isArray(config.entries) ? config.entries : [];
  const now = Date.now();
  return entries.filter((entry) => entry?.url && !excluded.has(entry.id) && (!runtime.get(entry.id)?.cooldownUntil || runtime.get(entry.id).cooldownUntil <= now));
}

function selectEntry(config, excluded) {
  const available = usableEntries(config, excluded);
  if (!available.length) {
    const fallback = (Array.isArray(config.entries) ? config.entries : []).filter((entry) => entry?.url && !excluded.has(entry.id));
    return fallback.sort((a, b) => (runtime.get(a.id)?.cooldownUntil || 0) - (runtime.get(b.id)?.cooldownUntil || 0))[0] || null;
  }
  if (config.strategy !== 'round_robin') return available[0];
  const entry = available[cursor % available.length];
  cursor = (cursor + 1) % Math.max(1, available.length);
  return entry;
}

function markSuccess(entry) {
  if (!entry?.id) return;
  runtime.set(entry.id, { healthy: true, failures: 0, cooldownUntil: null, lastUsedAt: Date.now() });
}

function markFailure(entry) {
  if (!entry?.id) return;
  const previous = runtime.get(entry.id) || {};
  const failures = (previous.failures || 0) + 1;
  runtime.set(entry.id, { healthy: false, failures, cooldownUntil: Date.now() + Math.min(120000, 5000 * (2 ** Math.min(failures - 1, 4))), lastUsedAt: Date.now() });
}

function retryableStatus(status) {
  return status === 407 || status === 408 || status === 429 || status >= 500;
}

function agentFor(proxyUrl) {
  let agent = agentCache.get(proxyUrl);
  if (!agent) {
    agent = new ProxyAgent({ getProxyForUrl: () => proxyUrl });
    agentCache.set(proxyUrl, agent);
  }
  return agent;
}

function requestViaProxy(url, options = {}, proxyUrl) {
  const target = new URL(url);
  const transport = target.protocol === 'https:' ? https : http;
  const timeoutMs = Math.max(1000, Number(options.proxyTimeoutMs || options.timeoutMs) || 15000);
  const headers = { ...(options.headers || {}) };
  let body = options.body;
  if (body instanceof URLSearchParams) body = body.toString();
  if (body !== undefined && body !== null && !headers['content-length'] && !headers['Content-Length']) headers['content-length'] = Buffer.byteLength(String(body));
  return new Promise((resolve, reject) => {
    let settled = false;
    const req = transport.request(target, { method: options.method || 'GET', headers, agent: agentFor(proxyUrl), timeout: timeoutMs }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        if (settled) return;
        settled = true;
        resolve(new Response(Buffer.concat(chunks), { status: response.statusCode || 0, statusText: response.statusMessage || '', headers: response.headers }));
      });
    });
    const timer = setTimeout(() => { const error = new Error('proxy request timeout'); error.name = 'TimeoutError'; req.destroy(error); }, timeoutMs);
    req.once('close', () => clearTimeout(timer));
    req.once('error', (error) => { if (settled) return; settled = true; if (!error.name) error.name = 'NetworkError'; reject(error); });
    if (options.signal) {
      if (options.signal.aborted) { req.destroy(options.signal.reason || new Error('aborted')); return; }
      options.signal.addEventListener('abort', () => req.destroy(options.signal.reason || new Error('aborted')), { once: true });
    }
    if (body !== undefined && body !== null) req.write(body);
    req.end();
  });
}

export function createProxyFetch(getSettings) {
  return async function proxyFetch(url, options = {}) {
    const config = getSettings?.() || {};
    const proxyEnabled = config.enabled === true;
    if (proxyEnabled && (!Array.isArray(config.entries) || !config.entries.some((entry) => entry?.url))) {
      throw new Error('proxy_entries_required');
    }
    const attempts = proxyEnabled ? Math.min(6, Math.max(1, Number(config.maxRetries) + 1 || 1)) : 1;
    const excluded = new Set();
    let lastError = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const entry = proxyEnabled ? selectEntry(config, excluded) : null;
      if (proxyEnabled && !entry) throw new Error('proxy_unavailable');
      try {
        const requestOptions = entry
          ? {
              ...options,
              proxyTimeoutMs: Math.max(1000, Number(config.timeoutMs) || 15000),
              // The proxy timeout is user-configurable; replace the caller's fixed
              // business timeout so a configured 30-120s window is honored.
              signal: AbortSignal.timeout(Math.max(1000, Number(config.timeoutMs) || 15000)),
            }
          : options;
        const response = entry ? await requestViaProxy(url, requestOptions, entry.url) : await fetch(url, requestOptions);
        const usableResponse = response.status >= 200 && response.status < 400;
        if (entry && usableResponse) markSuccess(entry);
        if (entry && !usableResponse && retryableStatus(response.status) && attempt < attempts - 1) { markFailure(entry); excluded.add(entry.id); continue; }
        if (entry && !usableResponse && retryableStatus(response.status)) markFailure(entry);
        return response;
      } catch (error) {
        lastError = error;
        if (entry) { markFailure(entry); excluded.add(entry.id); }
        if (attempt >= attempts - 1) throw error;
      }
    }
    throw lastError || new Error('proxy_request_failed');
  };
}
