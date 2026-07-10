#!/usr/bin/env node

/**
 * Claude Scheduler — Send a message to a claude.ai conversation at a scheduled time.
 *
 * Usage:
 *   node claude-scheduler.js --time "18:30" --url "https://claude.ai/chat/abc123" --message "Continue about X"
 *   node claude-scheduler.js --now --url "https://claude.ai/chat/abc123" --message "test"
 *
 * First run: browser opens, you log in manually. Session saves to .browser-profile/
 * Subsequent runs: auto-logged in.
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const PROFILE_DIR = path.join(__dirname, '.browser-profile');

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--time' && args[i + 1]) parsed.time = args[++i];
    if (args[i] === '--url' && args[i + 1]) parsed.url = args[++i];
    if (args[i] === '--message' && args[i + 1]) parsed.message = args[++i];
    if (args[i] === '--now') parsed.now = true;
  }
  if (!parsed.url || !parsed.message) {
    console.error('Usage: node claude-scheduler.js --time "HH:MM" --url "https://claude.ai/chat/..." --message "Your message" [--now]');
    process.exit(1);
  }
  if (!parsed.time && !parsed.now) {
    console.error('Error: --time or --now is required');
    process.exit(1);
  }
  return parsed;
}

function msUntilTime(timeStr) {
  const [hours, minutes] = timeStr.split(':').map(Number);
  const now = new Date();
  const target = new Date();
  target.setHours(hours, minutes, 0, 0);
  if (target <= now) target.setDate(target.getDate() + 1);
  return target.getTime() - now.getTime();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function findVisibleElement(page, selectors) {
  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (el && await el.isVisible()) return el;
    } catch (e) {}
  }
  return null;
}

async function waitForResponse(page, timeoutMs = 90000) {
  const start = Date.now();
  let lastLen = 0;
  let stableCount = 0;

  while (Date.now() - start < timeoutMs) {
    try {
      const content = await page.evaluate(() => {
        const msgs = document.querySelectorAll('[data-testid="assistant-message"], [class*="assistant"], .font-claude-message');
        if (msgs.length === 0) return '';
        return msgs[msgs.length - 1]?.textContent || '';
      });

      if (content.length > 0 && content.length === lastLen) {
        stableCount++;
        if (stableCount >= 5) return content;
      } else {
        stableCount = 0;
        lastLen = content.length;
      }
    } catch (e) {}
    await sleep(1000);
  }
  return null;
}

async function main() {
  const { time, url, message, now } = parseArgs();

  if (!now) {
    const waitMs = msUntilTime(time);
    const hours = Math.floor(waitMs / 3600000);
    const mins = Math.floor((waitMs % 3600000) / 60000);
    console.log(`[Claude Scheduler] Waiting ${hours}h ${mins}m until ${time}...`);
    await sleep(waitMs);
  }

  console.log('[Claude Scheduler] Launching browser...');

  if (!fs.existsSync(PROFILE_DIR)) {
    fs.mkdirSync(PROFILE_DIR, { recursive: true });
  }

  let context;
  try {
    context = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: false,
      viewport: { width: 1280, height: 800 },
      args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
      ignoreDefaultArgs: ['--enable-automation']
    });
  } catch (err) {
    console.error('[Claude Scheduler] Failed to launch browser:', err.message);
    process.exit(1);
  }

  const page = context.pages()[0] || await context.newPage();

  try {
    console.log(`[Claude Scheduler] Navigating to ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    await sleep(5000);

    const inputSelectors = [
      'div[contenteditable="true"]',
      'div[role="textbox"]',
      'textarea'
    ];

    let input = await findVisibleElement(page, inputSelectors);

    if (!input) {
      console.log('[Claude Scheduler] Not logged in. Please log in manually in the browser.');
      console.log('[Claude Scheduler] Waiting up to 5 minutes for login...');

      for (let i = 0; i < 60; i++) {
        await sleep(5000);
        try {
          input = await findVisibleElement(page, inputSelectors);
          if (input) break;
        } catch (e) {
          await sleep(2000);
        }
      }

      if (!input) {
        console.error('[Claude Scheduler] Timed out waiting for login.');
        await context.close();
        process.exit(1);
      }

      console.log('[Claude Scheduler] Login detected!');
      await sleep(2000);
    } else {
      console.log('[Claude Scheduler] Already logged in.');
    }

    console.log('[Claude Scheduler] Typing message...');
    await input.click();
    await sleep(500);

    await page.keyboard.type(message, { delay: 20 });
    await sleep(1000);

    console.log('[Claude Scheduler] Sending message...');
    const sendBtn = await findVisibleElement(page, [
      'button[aria-label*="Send"]',
      'button[aria-label*="send"]',
      'button[data-testid="send-button"]'
    ]);

    if (sendBtn) {
      await sendBtn.click();
      console.log('[Claude Scheduler] Message sent!');
    } else {
      console.log('[Claude Scheduler] Send button not found, pressing Enter...');
      await page.keyboard.press('Enter');
    }

    console.log('[Claude Scheduler] Waiting for Claude response...');
    const response = await waitForResponse(page, 90000);
    if (response) {
      console.log('[Claude Scheduler] Response received:');
      console.log('---');
      console.log(response.substring(0, 800));
      console.log('---');
    } else {
      console.log('[Claude Scheduler] No response detected (Claude might be slow or UI changed).');
    }

  } catch (err) {
    console.error('[Claude Scheduler] Error:', err.message);
  }

  console.log('[Claude Scheduler] Done. Closing browser in 5 seconds...');
  await sleep(5000);
  await context.close();
}

main().catch(err => {
  console.error('[Claude Scheduler] Fatal:', err);
  process.exit(1);
});
