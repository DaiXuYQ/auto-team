import { access } from 'node:fs/promises';
import process from 'node:process';
import puppeteer from 'puppeteer-core';

const SENTINEL_FRAME_URL = 'https://sentinel.openai.com/backend-api/sentinel/frame.html?sv=20260219f9f6';
const DEFAULT_TIMEOUT_MS = 20000;
const BROWSER_PATHS = [
  process.env.SENTINEL_BROWSER_PATH,
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean);

let browserRuntime = null;
let browserKey = '';
let browserQueue = Promise.resolve();

async function resolveExecutablePath() {
  for (const candidate of BROWSER_PATHS) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue until a locally installed Chromium browser is found.
    }
  }
  throw new Error('sentinel_browser_unavailable');
}

function normalizeProxy(proxy) {
  if (!proxy?.server) return null;
  let parsed;
  try {
    parsed = new URL(String(proxy.server));
  } catch {
    throw new Error('sentinel_proxy_invalid');
  }
  const username = String(proxy.username || (parsed.username ? decodeURIComponent(parsed.username) : ''));
  const password = String(proxy.password || (parsed.password ? decodeURIComponent(parsed.password) : ''));
  if (parsed.protocol.startsWith('socks') && (username || password)) {
    throw new Error('sentinel_socks_auth_unsupported');
  }
  const port = parsed.port || (parsed.protocol.startsWith('socks') ? '1080' : '8080');
  // Chromium's --proxy-server flag expects the socks5 spelling; keep the
  // socks5h alias at the Node request boundary where it is meaningful.
  const browserProtocol = parsed.protocol === 'socks5h:' ? 'socks5:' : parsed.protocol;
  return {
    server: `${browserProtocol}//${parsed.hostname}:${port}`,
    username,
    password,
  };
}

async function closeBrowser() {
  const runtime = browserRuntime;
  browserRuntime = null;
  browserKey = '';
  await runtime?.close().catch(() => undefined);
}

async function browserFor(proxy) {
  const executablePath = await resolveExecutablePath();
  const key = JSON.stringify({ executablePath, proxy: proxy?.server || '' });
  if (browserRuntime?.connected && browserKey === key) return browserRuntime;
  await closeBrowser();
  const args = [
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--disable-gpu',
  ];
  if (proxy?.server) args.push(`--proxy-server=${proxy.server}`);
  const browser = await puppeteer.launch({ executablePath, headless: true, args });
  browserRuntime = browser;
  browserKey = key;
  browser.once('disconnected', () => {
    if (browserRuntime === browser) {
      browserRuntime = null;
      browserKey = '';
    }
  });
  return browser;
}

async function calculateToken({ flow, deviceId, userAgent, proxy, timeoutMs }) {
  const normalizedProxy = normalizeProxy(proxy);
  const browser = await browserFor(normalizedProxy);
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  try {
    if (normalizedProxy?.username || normalizedProxy?.password) {
      await page.authenticate({ username: normalizedProxy.username, password: normalizedProxy.password });
    }
    await page.setUserAgent(userAgent);
    await page.setViewport({ width: 1365, height: 768, deviceScaleFactor: 1 });
    await page.setExtraHTTPHeaders({ 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' });
    await page.setCookie({
      name: 'oai-did',
      value: deviceId,
      domain: 'sentinel.openai.com',
      path: '/',
      secure: true,
      httpOnly: false,
      sameSite: 'None',
    });
    await page.goto(SENTINEL_FRAME_URL, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    try {
      await page.waitForFunction(() => typeof window.SentinelSDK?.token === 'function', { timeout: timeoutMs });
    } catch {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: timeoutMs });
      await page.waitForFunction(() => typeof window.SentinelSDK?.token === 'function', { timeout: timeoutMs });
    }
    const token = await page.evaluate(async (runtimeFlow) => window.SentinelSDK.token(runtimeFlow), flow);
    if (typeof token !== 'string' || !token.trim()) throw new Error('sentinel_token_empty');
    return token.trim();
  } finally {
    await context.close().catch(() => undefined);
  }
}

export function fetchSentinelToken({ flow, deviceId, userAgent, proxy = null, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const task = () => calculateToken({
    flow: String(flow || ''),
    deviceId: String(deviceId || ''),
    userAgent: String(userAgent || ''),
    proxy,
    timeoutMs: Math.max(5000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS),
  });
  const result = browserQueue.then(task, task);
  browserQueue = result.catch(() => undefined);
  return result;
}

export async function closeSentinelBrowser() {
  await browserQueue.catch(() => undefined);
  await closeBrowser();
}
