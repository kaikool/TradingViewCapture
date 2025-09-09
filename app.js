// app.js
// TradingView capture via Browserless 
// Code Backup+ Pan 50 nến + crop chart

import express from "express";
import puppeteer from "puppeteer-core";

const app = express();

// ====== HARDCODE ======
const TOKEN              = "2SNEoq2by4gxiCk0a5f541b86a7b35f16883c01d0e808ed67"; // Browserless token
const TV_SESSIONID       = "o1hixcbxh1cvz59ri1u6d9juggsv9jko";                   // TradingView sessionid
const CHART_ID           = "fCLTltqk";
const DEFAULT_TICKER     = "OANDA:XAUUSD";
const BROWSERLESS_REGION = "production-sfo"; // có thể đổi sang production-lhr, production-syd nếu muốn
const PORT               = process.env.PORT || 10000; // Render bắt buộc dùng $PORT

const WS_ENDPOINT = `wss://${BROWSERLESS_REGION}.browserless.io?token=${TOKEN}`;

const TF_MAP = {
  M1: "1", M3: "3", M5: "5", M15: "15", M30: "30",
  H1: "60", H2: "120", H4: "240",
  D: "D", W: "W", MN: "M",
};

function buildUrl(chartId, ticker, tf) {
  const interval = TF_MAP[(tf || "").toUpperCase()] || "60"; // default H1
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

async function pressAltSAndReadClipboard(page) {
  const readClip = async () => {
    try { return await page.evaluate(() => navigator.clipboard.readText()); }
    catch { return ""; }
  };

  for (let i = 0; i < 8; i++) {
    try {
      await page.keyboard.down("Alt");
      await page.keyboard.press("S");
      await page.keyboard.up("Alt");
    } catch {}
    await new Promise(r => setTimeout(r, 1200 + i * 400));
    const clip = await readClip();
    if (clip && clip.trim()) return clip.trim();
  }

  return null;
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
  // đưa chuột ra ngoài vùng chart để TV tắt crosshair
  try {
    const el = await findChartContainer(page);
    const box = el && await el.boundingBox();
    if (box) {
      await page.mouse.move(box.x + box.width + 8, box.y + 8);
    } else {
      await page.mouse.move(0, 0);
    }
  } catch {}

  // phát sự kiện mouseleave + ẩn mọi lớp crosshair/cursor còn sót
  await page.evaluate(() => {
    const root =
      document.querySelector('div[class*="chart-container"]') ||
      document.querySelector('[data-name="pane"]')?.parentElement ||
      document.body;

    if (!root) return;

    root.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
    root.style.cursor = 'none';

    // một số lớp UI vẽ crosshair/cursor (tên có thể thay đổi theo build)
    root.querySelectorAll('*').forEach(n => {
      const cls = (n.className || '').toString();
      if (/crosshair|Crosshair|cursor/i.test(cls)) {
        n.style.opacity = '0';
        n.style.pointerEvents = 'none';
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

  // ticker dạng OANDA:XAUUSD => lấy phần sau dấu :
  const symbol = ticker.includes(":") ? ticker.split(":")[1] : ticker;

  return `${dd}${mm}${yy}_${HH}${MM}_${symbol}_${tf.toUpperCase()}.png`;
}

// ================== Routes ==================
app.get("/health", (req, res) => {
  return res.json({ ok: true, time: new Date().toISOString() });
});

app.get("/capture", async (req, res) => {
  const mode = (req.query.mode || "png").toString(); // png | url
  const tf = (req.query.tf || "H1").toString();
  const w = parseInt(req.query.w || "1440", 10);
  const h = parseInt(req.query.h || "900", 10);
  const rawTicker = (req.query.ticker ?? "").toString().trim();
  const ticker = rawTicker !== "" ? rawTicker : DEFAULT_TICKER;
  let browser;
  try {
    browser = await puppeteer.connect({ browserWSEndpoint: WS_ENDPOINT });
    const page = await browser.newPage();
    await page.setViewport({ width: w, height: h });

    await setCookieAndPrime(page);
    const url = buildUrl(CHART_ID, ticker, tf);
    await page.goto(url, { waitUntil: "networkidle2" }).catch(async () => {
      await page.goto(url, { waitUntil: "domcontentloaded" });
    });

    await setTimeframeHotkey(page, tf);
    await new Promise(r => setTimeout(r, 800));
    // Inject CSS ẩn thanh favourite tool
    await page.addStyleTag({
      content: `
        /* Toolbar vẽ dọc trái */
        .layout__area--left,
        .drawingToolbar,
        .tv-floating-toolbar,
        [class*="drawingToolbar"],
        [class*="left-toolbar"] {
          display: none !important;
        }
      `
    });
    /** Luôn pan 50 nến sang phải trước khi chụp/copy URL */
    await panChartRight50(page);
    /** Ẩn 
    await clearCrosshair(page);
    await new Promise(r => setTimeout(r, 120));
      /** Crop chart (fallback fullPage nếu không định vị được chart) */
    const bufCrop = await screenshotChartRegion(page);
    const fname = formatFilename(ticker, tf);

    if (bufCrop) {
      res.setHeader("Content-Type", "image/png");
      res.setHeader("Content-Disposition", `inline; filename="${fname}"`);
      res.send(bufCrop);
    } else {
      const buf = await page.screenshot({ type: "png", fullPage: true });
      res.setHeader("Content-Type", "image/png");
      res.setHeader("Content-Disposition", `inline; filename="${fname}"`);
      res.send(buf);
    }

    await page.close();
    await browser.close();
  } catch (e) {
    try { if (browser) await browser.close(); } catch {}
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL('.', import.meta.url));

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
