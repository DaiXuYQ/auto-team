import { access } from 'node:fs/promises';
import process from 'node:process';
import puppeteer from 'puppeteer-core';

const CHROME_PATHS = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean);

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function executablePath() {
  for (const candidate of CHROME_PATHS) {
    try { await access(candidate); return candidate; } catch { /* keep searching */ }
  }
  return '';
}

async function firstVisible(page, selectors) {
  for (const selector of selectors) {
    const handle = await page.$(selector);
    if (!handle) continue;
    const visible = await handle.evaluate((element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    }).catch(() => false);
    if (visible) return handle;
    await handle.dispose().catch(() => {});
  }
  return null;
}

async function fill(page, selectors, value) {
  const input = await firstVisible(page, selectors);
  if (!input) return false;
  await input.click({ clickCount: 3 });
  await input.type(String(value), { delay: 22 });
  return true;
}

async function clickSubmit(page) {
  const button = await firstVisible(page, [
    'button[type="submit"]',
    'button[data-dd-action-name="Continue"]',
    'button[data-testid="continue-button"]',
    'input[type="submit"]',
  ]);
  if (!button) return false;
  await button.click();
  return true;
}

async function pageText(page) {
  return page.evaluate(() => document.body?.innerText || '').catch(() => '');
}

function isEmailVerification(url, text) {
  return /email-verification|email-otp/i.test(url) || /check your email|email verification|邮箱验证码|检查.*邮箱/i.test(text);
}

function isTotpVerification(url, text) {
  return /totp|two-factor|authenticator|one-time-password|\/mfa/i.test(url)
    || /authenticator|two-factor|verification code from your|动态验证码|身份验证器/i.test(text);
}

function isBrowserChallenge(url, text) {
  return /captcha|challenge|turnstile|unsupported.country|country.region/i.test(url)
    || /verify you are human|security check|cloudflare|unsupported country|not available in your country|country, region, or territory|人机验证|安全验证|地区暂不支持/i.test(text);
}

export async function browserLoginForCallback(options = {}) {
  const chrome = await executablePath();
  if (!chrome) return { ok: false, code: 'browser_unavailable', message: '未找到本机 Chrome 或 Edge' };
  const args = ['--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--window-size=1200,860'];
  if (options.proxy?.server) args.push(`--proxy-server=${options.proxy.server}`);
  let browser;
  let callbackUrl = '';
  try {
    browser = await puppeteer.launch({ executablePath: chrome, headless: true, args });
    const page = await browser.newPage();
    page.setDefaultTimeout(Math.max(5000, Number(options.timeoutMs) || 20000));
    if (options.proxy?.username || options.proxy?.password) await page.authenticate({ username: options.proxy.username || '', password: options.proxy.password || '' });
    page.on('request', (request) => {
      if (request.url().startsWith('http://localhost:1455/auth/callback') || request.url().startsWith('http://127.0.0.1:1455/auth/callback')) callbackUrl = request.url();
    });
    options.onProgress?.('browser_starting', '正在本机 Chrome 中执行登录');
    await page.goto(options.authUrl, { waitUntil: 'domcontentloaded', timeout: Math.max(15000, Number(options.timeoutMs) || 30000) });

    const deadline = Date.now() + Math.max(60000, Number(options.totalTimeoutMs) || 120000);
    let submittedEmail = false;
    let submittedPassword = false;
    let submittedTotp = false;
    let submittedEmailOtp = false;
    while (Date.now() < deadline) {
      const url = page.url();
      if (callbackUrl) return { ok: true, callbackUrl };
      if (url.startsWith('http://localhost:1455/auth/callback') || url.startsWith('http://127.0.0.1:1455/auth/callback')) return { ok: true, callbackUrl: url };
      const text = await pageText(page);
      if (isBrowserChallenge(url, text)) return { ok: false, code: 'browser_verification_required', message: '浏览器登录需要人工完成安全验证', authUrl: options.authUrl };

      if (!submittedEmail && await fill(page, ['input[type="email"]', 'input[name="email"]', 'input[name="username"]', 'input[autocomplete="username"]'], options.email)) {
        options.onProgress?.('browser_email', '浏览器正在提交登录邮箱');
        submittedEmail = true;
        await clickSubmit(page);
        await sleep(1200);
        continue;
      }
      if (!submittedPassword && await fill(page, ['input[type="password"]', 'input[name="password"]', 'input[autocomplete="current-password"]'], options.password)) {
        options.onProgress?.('browser_password', '浏览器正在验证账号密码');
        submittedPassword = true;
        await clickSubmit(page);
        await sleep(1200);
        continue;
      }
      if (isTotpVerification(url, text) && !submittedTotp) {
        const code = options.totpCode?.();
        if (!code) return { ok: false, code: 'totp_required', message: '登录需要 2FA Secret' };
        const filled = await fill(page, ['input[autocomplete="one-time-code"]', 'input[inputmode="numeric"]', 'input[name="code"]', 'input[name="otp"]'], code);
        if (!filled) return { ok: false, code: 'totp_input_missing', message: '未识别 2FA 输入框', authUrl: options.authUrl };
        options.onProgress?.('browser_totp', '浏览器正在验证 2FA');
        submittedTotp = true;
        await clickSubmit(page);
        await sleep(1200);
        continue;
      }
      if (isEmailVerification(url, text) && !submittedEmailOtp) {
        const code = await options.emailOtp?.();
        if (!code) return { ok: false, code: 'email_otp_required', message: '登录需要邮箱验证码' };
        const filled = await fill(page, ['input[autocomplete="one-time-code"]', 'input[inputmode="numeric"]', 'input[name="code"]', 'input[name="otp"]'], code);
        if (!filled) return { ok: false, code: 'email_otp_input_missing', message: '未识别邮箱验证码输入框', authUrl: options.authUrl };
        options.onProgress?.('waiting_code', '浏览器正在提交邮箱验证码');
        submittedEmailOtp = true;
        await clickSubmit(page);
        await sleep(1200);
        continue;
      }

      const consent = await firstVisible(page, ['button[type="submit"]', 'button[data-testid*="consent"]', 'button[data-dd-action-name*="Continue"]']);
      if (consent && /continue|allow|authorize|同意|继续/i.test(await consent.evaluate((element) => element.innerText || element.value || ''))) {
        options.onProgress?.('browser_consent', '浏览器正在确认 OAuth 授权');
        await consent.click();
        await sleep(1200);
        continue;
      }
      await sleep(650);
    }
    return { ok: false, code: 'browser_timeout', message: '浏览器登录超时', authUrl: options.authUrl };
  } catch (error) {
    return { ok: false, code: error?.name === 'TimeoutError' ? 'browser_timeout' : 'browser_login_failed', message: error?.message || '浏览器登录失败', authUrl: options.authUrl };
  } finally {
    await browser?.close().catch(() => {});
  }
}
