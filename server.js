'use strict';

const express = require('express');
const cors    = require('cors');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// ═══════════════════════════════════════════════════════════
//  STRUCTURED LOGGER
// ═══════════════════════════════════════════════════════════
const log = {
  info:  (msg, meta={}) => console.log(JSON.stringify({ level:'INFO',  ts:new Date().toISOString(), msg, ...meta })),
  warn:  (msg, meta={}) => console.log(JSON.stringify({ level:'WARN',  ts:new Date().toISOString(), msg, ...meta })),
  error: (msg, meta={}) => console.error(JSON.stringify({ level:'ERROR', ts:new Date().toISOString(), msg, ...meta })),
};

// ═══════════════════════════════════════════════════════════
//  RATE LIMITER (in-memory, per IP)
// ═══════════════════════════════════════════════════════════
const rateLimitStore = new Map();
const RATE_LIMIT     = 60;
const RATE_WINDOW_MS = 60_000;

function rateLimit(req, res, next) {
  const ip  = req.ip || req.headers['x-forwarded-for'] || 'unknown';
  const now = Date.now();
  let entry = rateLimitStore.get(ip);
  if (!entry || now > entry.resetAt) entry = { count:0, resetAt:now + RATE_WINDOW_MS };
  entry.count++;
  rateLimitStore.set(ip, entry);
  res.setHeader('X-RateLimit-Limit',     RATE_LIMIT);
  res.setHeader('X-RateLimit-Remaining', Math.max(0, RATE_LIMIT - entry.count));
  res.setHeader('X-RateLimit-Reset',     Math.ceil(entry.resetAt / 1000));
  if (entry.count > RATE_LIMIT) {
    log.warn('Rate limit exceeded', { ip });
    return res.status(429).json({ ok:false, error:'Too many requests. Try again in a minute.' });
  }
  next();
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of rateLimitStore) if (now > e.resetAt) rateLimitStore.delete(ip);
}, 300_000);

// ═══════════════════════════════════════════════════════════
//  MIDDLEWARE
// ═══════════════════════════════════════════════════════════
app.use(cors({ origin:'*', methods:['GET','POST'] }));
app.use(express.json({ limit:'100kb' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge:'1h' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

// ═══════════════════════════════════════════════════════════
//  CACHE STATE
// ═══════════════════════════════════════════════════════════
const MAX_ITEMS      = 100;
let   cache          = [];
let   cacheAt        = 0;
let   lastEtag       = '';
let   dataSource     = 'cache';   // 'api' | 'scrape' | 'cache'
let   fetchError     = null;
let   consecutiveFails = 0;
let   totalFetches   = 0;
let   totalErrors    = 0;

// ═══════════════════════════════════════════════════════════
//  PUPPETEER — singleton browser
// ═══════════════════════════════════════════════════════════
let puppeteer    = null;
let browser      = null;
let scraperReady = false;

async function initPuppeteer() {
  try {
    puppeteer = require('puppeteer');
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
      ],
    });
    scraperReady = true;
    log.info('Puppeteer browser launched');
    browser.on('disconnected', () => {
      scraperReady = false;
      log.warn('Puppeteer disconnected — will retry');
      setTimeout(initPuppeteer, 5_000);
    });
  } catch (err) {
    scraperReady = false;
    log.warn('Puppeteer not available (will use API + cache only)', { error: err.message });
  }
}
initPuppeteer();

// ═══════════════════════════════════════════════════════════
//  fetchAPI()
// ═══════════════════════════════════════════════════════════
const API_URL        = 'https://api.55fiveapi.com/api/webapi/GetNoaverageEmerdList';
const API_TIMEOUT_MS = 8_000;
const MAX_RETRIES    = 3;
const RETRY_DELAY_MS = 1_200;
const sleep          = ms => new Promise(r => setTimeout(r, ms));

function buildPayload() {
  return {
    pageSize:  10, pageNo: 1, typeId: 1, language: 0,
    random:    Math.random().toString(36).slice(2,18).padEnd(16,'0'),
    signature: 'A1B2C3D4E5F6G7H8',
    timestamp: Math.floor(Date.now() / 1000),
  };
}

async function fetchAPI() {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
    try {
      const res = await fetch(API_URL, {
        method:  'POST',
        headers: { 'Content-Type':'application/json', Accept:'application/json' },
        body:    JSON.stringify(buildPayload()),
        signal:  controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const json = await res.json();
      const list = json?.data?.list ?? json?.list ?? json?.data ?? [];
      if (!Array.isArray(list) || !list.length) throw new Error('Empty or malformed response');
      return list;
    } catch (err) {
      clearTimeout(timer);
      log.warn(`fetchAPI attempt ${attempt}/${MAX_RETRIES} failed`, { error: err.message });
      if (attempt < MAX_RETRIES) await sleep(RETRY_DELAY_MS * attempt);
      else throw err;
    }
  }
}

// ═══════════════════════════════════════════════════════════
//  scrapeWeb()  — Puppeteer fallback
// ═══════════════════════════════════════════════════════════
const SCRAPE_URL     = 'https://www.krelmod.com/#/home/AllLotteryGames/WinGo?id=1';
const SCRAPE_TIMEOUT = 20_000;

async function scrapeWeb() {
  if (!scraperReady || !browser) throw new Error('Puppeteer not available');
  let page = null;
  try {
    page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36');
    await page.setViewport({ width:1280, height:800 });
    // block images/fonts to speed up
    await page.setRequestInterception(true);
    page.on('request', req => {
      if (['image','font','media'].includes(req.resourceType())) req.abort();
      else req.continue();
    });

    await page.goto(SCRAPE_URL, { waitUntil:'networkidle2', timeout:SCRAPE_TIMEOUT });

    // wait for result rows
    await page.waitForSelector('.van-cell, .result-item, tr, [class*="result"], [class*="record"]', { timeout:12_000 }).catch(()=>{});

    // try to extract structured data from the page
    const rows = await page.evaluate(() => {
      const results = [];
      // Strategy 1: look for table rows with numbers
      document.querySelectorAll('tr, .van-cell, [class*="result-row"], [class*="record-item"]').forEach(el => {
        const text = el.innerText || '';
        const numMatch = text.match(/\b([0-9])\b/);
        const issueMatch = text.match(/\b(\d{14,20})\b/);
        if (numMatch && issueMatch) {
          results.push({ issueNumber: issueMatch[1], number: parseInt(numMatch[1]) });
        }
      });
      // Strategy 2: look for any elements containing long digit strings (issue numbers)
      if (results.length === 0) {
        document.querySelectorAll('*').forEach(el => {
          if (el.children.length > 0) return;
          const text = (el.innerText || '').trim();
          const m = text.match(/^(\d{14,20})$/);
          if (m) {
            const parent = el.closest('tr, .van-cell, li, div[class]');
            if (parent) {
              const pText = parent.innerText || '';
              const numM = pText.match(/(?:^|\s)([0-9])(?:\s|$)/);
              if (numM) results.push({ issueNumber: m[1], number: parseInt(numM[1]) });
            }
          }
        });
      }
      return results.slice(0, 15);
    });

    if (!rows.length) throw new Error('No data extracted from page');
    log.info('scrapeWeb succeeded', { rows: rows.length });
    return rows;
  } finally {
    if (page) await page.close().catch(()=>{});
  }
}

// ═══════════════════════════════════════════════════════════
//  normalise()
// ═══════════════════════════════════════════════════════════
function normalise(item) {
  const issueNumber = String(item.issueNumber ?? item.issue ?? item.id ?? Date.now());
  const number      = Math.max(0, Math.min(9, parseInt(item.number ?? item.num ?? item.result ?? 0, 10) || 0));
  return {
    issueNumber,
    number,
    besarKecil: number >= 5 ? 'Besar' : 'Kecil',
    timestamp:  item.openTime ?? item.timestamp ?? new Date().toISOString(),
  };
}

// ═══════════════════════════════════════════════════════════
//  getData()  — API → scrape → cache
// ═══════════════════════════════════════════════════════════
async function getData() {
  // 1. Try API
  try {
    const list = await fetchAPI();
    return { list, source: 'api' };
  } catch (apiErr) {
    log.warn('API failed, trying scrape', { error: apiErr.message });
  }

  // 2. Try scraping
  try {
    const list = await scrapeWeb();
    return { list, source: 'scrape' };
  } catch (scrapeErr) {
    log.warn('Scrape failed, using cache', { error: scrapeErr.message });
  }

  // 3. Cache
  return { list: [], source: 'cache' };
}

// ═══════════════════════════════════════════════════════════
//  poll()  — runs every 5 s
// ═══════════════════════════════════════════════════════════
async function poll() {
  totalFetches++;
  try {
    const { list, source } = await getData();

    if (list.length > 0) {
      let added = 0;
      for (const raw of list) {
        const item = normalise(raw);
        if (!cache.find(c => c.issueNumber === item.issueNumber)) {
          cache.unshift(item);
          added++;
        }
      }
      if (cache.length > MAX_ITEMS) cache = cache.slice(0, MAX_ITEMS);
      const newEtag = cache[0]?.issueNumber ?? '';
      if (added > 0) {
        log.info('Cache updated', { source, added, total: cache.length, newest: newEtag });
        lastEtag = newEtag;
      }
      dataSource       = source;
      cacheAt          = Date.now();
      fetchError       = null;
      consecutiveFails = 0;
    } else {
      // pure cache hit — nothing new but not an error
      dataSource = 'cache';
      consecutiveFails++;
      if (consecutiveFails === 1) log.warn('No new data, serving cache');
    }
  } catch (err) {
    totalErrors++;
    consecutiveFails++;
    fetchError = err.message;
    log.error('poll() uncaught error', { error: err.message, consecutiveFails });
    if (cache.length === 0) injectDemo();
  }
}

// ─── demo seed ─────────────────────────────────────────────
function injectDemo() {
  const nums      = [9,6,0,5,7,7,2,9,4,3,8,4,6,8,8,2,9,1,3,8,4,9,6,0,5];
  const baseIssue = 20260501100010112n;
  nums.forEach((n, i) => {
    const issue = String(baseIssue - BigInt(i));
    if (!cache.find(c => c.issueNumber === issue))
      cache.push({ issueNumber:issue, number:n, besarKecil:n>=5?'Besar':'Kecil', timestamp:new Date().toISOString() });
  });
  dataSource = 'cache';
  log.warn('Injected demo data', { count: cache.length });
}

// ─── start polling ─────────────────────────────────────────
poll();
setInterval(poll, 5_000);

// ═══════════════════════════════════════════════════════════
//  ROUTES
// ═══════════════════════════════════════════════════════════
app.get('/api/data', rateLimit, (req, res) => {
  const clientEtag = req.headers['if-none-match'];
  if (clientEtag && clientEtag === lastEtag && cache.length > 0)
    return res.status(304).end();

  res.setHeader('ETag',          lastEtag);
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    ok:         true,
    data:       cache,
    total:      cache.length,
    source:     dataSource,
    cacheAt,
    error:      fetchError,
    isFallback: dataSource !== 'api',
  });
});

app.get('/api/health', (req, res) => {
  const cacheAgeMs = Date.now() - cacheAt;
  const healthy    = consecutiveFails < 5 && cacheAgeMs < 30_000;
  res.status(healthy ? 200 : 503).json({
    ok:               healthy,
    uptime:           Math.round(process.uptime()),
    cacheSize:        cache.length,
    source:           dataSource,
    cacheAgeMs,
    consecutiveFails,
    totalFetches,
    totalErrors,
    scraperReady,
    errorRate:        totalFetches > 0 ? ((totalErrors/totalFetches)*100).toFixed(1)+'%' : '0%',
    lastError:        fetchError,
    memoryMB:         Math.round(process.memoryUsage().rss / 1_048_576),
  });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ═══════════════════════════════════════════════════════════
//  GLOBAL SAFETY NET
// ═══════════════════════════════════════════════════════════
app.use((err, req, res, _next) => {
  log.error('Unhandled Express error', { error: err.message, path: req.path });
  res.status(500).json({ ok: false, error: 'Internal server error' });
});
process.on('uncaughtException',  err => log.error('UncaughtException',  { error: err.message }));
process.on('unhandledRejection', err => log.error('UnhandledRejection', { error: String(err) }));
process.on('SIGTERM', async () => {
  log.info('SIGTERM received — closing browser');
  if (browser) await browser.close().catch(()=>{});
  process.exit(0);
});
app.get("/api/data", async (req, res) => {
  try {
    const response = await fetch("https://api.55fiveapi.com/api/webapi/GetNoaverageEmerdList");
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "gagal ambil data" });
  }
});

// ═══════════════════════════════════════════════════════════
//  START
// ═══════════════════════════════════════════════════════════
app.listen(PORT, () =>
  log.info('Server started', { port:PORT, node:process.version, env:process.env.NODE_ENV||'development' })
);
