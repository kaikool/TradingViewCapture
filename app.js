// app.js
// TradingView capture via Browserless
// Code Backup + Pan 50 nến + crop chart

import express from "express";
import cors from "cors";
import puppeteer from "puppeteer-core";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const app = express();
app.disable("x-powered-by");
app.use(cors({ origin: "*" })); // chỉnh domain cụ thể nếu cần

// ====== HARDCODE ======
const TOKEN              = "2SNEoq2by4gxiCk0a5f541b86a7b35f16883c01d0e808ed67"; // Browserless token
const TV_SESSIONID       = "o1hixcbxh1cvz59ri1u6d9juggsv9jko";                   // TradingView sessionid
const CHART_ID           = "fCLTltqk";
const DEFAULT_TICKER     = "OANDA:XAUUSD";
const BROWSERLESS_REGION = "production-sfo";
const PORT               = process.env.PORT || 10000;

const WS_ENDPOINT = `wss://${BROWSERLESS_REGION}.browserless.io?token=${TOKEN}`;

const TF_MAP = {
  M1: "1", M3: "3", M5: "5", M15: "15", M30: "30",
  H1: "60", H2: "120", H4: "240",
  D: "D", W: "W", MN: "M",
};

const clamp = (v, min, max, d) => {
  const n = Number.parseInt(v ?? d, 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : d;
};

function buildUrl(chartId, ticker, tf) {
  const interval = TF_MAP[(tf || "").toUpperCase()] || "60";
  const base = `https://www.tradingview.com/chart/${chartId}/`;
  return `${base}?symbol=${encodeURIComponent(ticker)}&interval=${interval}`;
}

async function setCookieAndPrime(page) {
  await page.goto("https://www.tradingview.com", { waitUntil: "domcontentloaded" });
  await page.setCookie({
    name: "sessionid",
    value: TV_SESSIONID,
    domain: ".tradingview.com",
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
  });
  await page.goto("https://www.tradingview.com", { waitUntil: "domcontentloaded" });
}

async function focusChart(page) {
  const sels = [
    "canvas[data-name='pane']",
    "div[data-name='pane'] canvas",
    "div[class*='chart-container'] canvas",
    "canvas",
    "body",
  ];
  for (const sel of sels) {
    try {
      const h = await page.$(sel);
      if (h) { await h.click(); return; }
    } catch {}
  }
}

async function setTimeframeHotkey(page, tf) {
  const interval = TF_MAP[(tf || "").toUpperCase()] || "60";
  await focusChart(page);
  if (["D", "W", "M"].includes(interval)) {
    await page.keyboard.press(interval);
  } else {
    for (const ch of interval) await page.keyboard.type(ch);
    await page.keyboard.press("Enter");
  }
}

/** ====== Pan 50 nến sang phải ====== */
async function panChartRight50(page) {
  await focusChart(page);
  for (let i = 0; i < 50; i++) {
    try { await page.keyboard.press("ArrowRight"); } catch {}
    await new Promise(r => setTimeout(r, 10));
  }
}

/** ====== Crop đúng vùng chart ====== */
async function findChartContainer(page) {
  const sels = [
    "div[class*='chart-container']",
    "[data-name='pane']",
    "div[data-name='pane']",
    "div[class*='chart-markup']",
  ];
  for (const sel of sels) {
    const h = await page.$(sel);
    if (h) return h;
  }
  return await page.$("canvas[data-name='pane']") || await page.$("canvas");
}

async function screenshotChartRegion(page) {
  const el = await findChartContainer(page);
  if (!el) return null;
  await el.evaluate(e => e.scrollIntoView({ block: "center", inline: "center" }));
  const box = await el.boundingBox();
  if (!box) return null;
  const pad = 2;
  const clip = {
    x: Math.max(0, box.x - pad),
    y: Math.max(0, box.y - pad),
    width: Math.max(1, box.width + pad * 2),
    height: Math.max(1, box.height + pad * 2),
  };
  return await page.screenshot({ type: "png", clip });
}

/** Ẩn crosshair/chuột trước khi chụp */
async function clearCrosshair(page) {
  try {
    const el = await findChartContainer(page);
    const box = el && await el.boundingBox();
    if (box) {
      await page.mouse.move(box.x + box.width + 8, box.y + 8);
    } else {
      await page.mouse.move(0, 0);
    }
  } catch {}

  await page.evaluate(() => {
    const root =
      document.querySelector('div[class*="chart-container"]') ||
      document.querySelector('[data-name="pane"]')?.parentElement ||
      document.body;

    if (!root) return;

    root.dispatchEvent(new MouseEvent("mouseleave", { bubbles: true }));
    root.style.cursor = "none";

    root.querySelectorAll("*").forEach(n => {
      const cls = (n.className || "").toString();
      if (/crosshair|Crosshair|cursor/i.test(cls)) {
        n.style.opacity = "0";
        n.style.pointerEvents = "none";
      }
    });
  });
}

// ================== Format filename ==================
function formatFilename(ticker, tf) {
  const now = new Date();
  const dd   = String(now.getDate()).padStart(2, "0");
  const mm   = String(now.getMonth() + 1).padStart(2, "0");
  const yy   = String(now.getFullYear()).slice(-2);
  const HH   = String(now.getHours()).padStart(2, "0");
  const MM   = String(now.getMinutes()).padStart(2, "0");

  const symbol = ticker.includes(":") ? ticker.split(":")[1] : ticker;
  return `${dd}${mm}${yy}_${HH}${MM}_${symbol}_${tf.toUpperCase()}.png`;
}

// ================== Routes ==================
app.get("/health", (req, res) => {
  return res.json({ ok: true, time: new Date().toISOString() });
});

app.get("/capture", async (req, res) => {
  const tfKey = (req.query.tf || "H1").toString().toUpperCase();
  const tf = TF_MAP[tfKey] ? tfKey : "H1";
  const w = clamp(req.query.w, 640, 2560, 1440);
  const h = clamp(req.query.h, 480, 1440, 900);
  const rawTicker = (req.query.ticker ?? "").toString().trim();
  const ticker = rawTicker !== "" ? rawTicker : DEFAULT_TICKER;

  let browser;
  const ABORT_MS = 45_000;
  const kill = setTimeout(() => {
    try { res.status(504).json({ ok:false, error:"timeout" }); } catch {}
  }, ABORT_MS);

  try {
    browser = await puppeteer.connect({ browserWSEndpoint: WS_ENDPOINT });
    const page = await browser.newPage();
    await page.setViewport({ width: w, height: h, deviceScaleFactor: 2 });

    await setCookieAndPrime(page);

    const url = buildUrl(CHART_ID, ticker, tf);
    try {
      await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
    } catch {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    }

 
    await setTimeframeHotkey(page, tf);
    await new Promise(r => setTimeout(r, 800));

    await page.addStyleTag({
      content: `
        .layout__area--left, .drawingToolbar, .tv-floating-toolbar,
        [class*="drawingToolbar"], [class*="left-toolbar"] {
          display:none !important;
        }
      `
    });

    await focusChart(page);
    await panChartRight50(page);

    // Ẩn crosshair trước khi chụp
    await clearCrosshair(page);
    await new Promise(r => setTimeout(r, 120));

    const bufCrop = await screenshotChartRegion(page);
    const fname = formatFilename(ticker, tf);

    res.setHeader("Content-Type", "image/png");
    res.setHeader("Content-Disposition", `inline; filename="${fname}"`);
    if (bufCrop) {
      res.send(bufCrop);
    } else {
      const buf = await page.screenshot({ type: "png", fullPage: true });
      res.send(buf);
    }

    await page.close();
    await browser.close();
  } catch (e) {
    try { if (browser) await browser.close(); } catch {}
    return res.status(500).json({ ok:false, error: e?.message || String(e) });
  } finally {
    clearTimeout(kill);
  }
});

const __dirname = fileURLToPath(new URL(".", import.meta.url));

app.get("/", async (req, res) => {
  try {
    const html = await readFile(join(__dirname, "index.html"), "utf8");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(html);
  } catch (e) {
    res.status(404).send("index.html not found");
  }
});

app.listen(PORT, () => {
  console.log(`[server] listening on :${PORT}`);
});
