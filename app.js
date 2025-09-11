import express from "express";
import cors from "cors";
import puppeteer from "puppeteer-core";
import { v2 as cloudinary } from "cloudinary";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

// ====== HARDCODE ======
// Browserless / TradingView
const TOKEN              = "2SNEoq2by4gxiCk0a5f541b86a7b35f16883c01d0e808ed67"; // Browserless token
const TV_SESSIONID       = "o1hixcbxh1cvz59ri1u6d9juggsv9jko";                   // TradingView sessionid
const CHART_ID           = "fCLTltqk";
const DEFAULT_TICKER     = "OANDA:XAUUSD";
const BROWSERLESS_REGION = "production-sfo";
const WS_ENDPOINT        = `wss://${BROWSERLESS_REGION}.browserless.io?token=${TOKEN}`;

// Cloudinary (HARDCODE)
cloudinary.config({
  cloud_name: "YOUR_CLOUD_NAME",
  api_key:    "YOUR_API_KEY",
  api_secret: "YOUR_API_SECRET",
});

const PORT = process.env.PORT || 8080;

// ==== Map TF ====
const TF_MAP = {
  M1: "1", M3: "3", M5: "5", M15: "15", M30: "30",
  H1: "60", H2: "120", H4: "240",
  D: "D", W: "W", MN: "M",
};

// ==== Helpers ====
function clamp(v, min, max, d) {
  const n = Number.parseInt(v ?? d, 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : d;
}

function buildUrl(chartId, ticker, tf) {
  const interval = TF_MAP[(tf || "").toUpperCase()] || "60";
  return `https://www.tradingview.com/chart/${chartId}/?symbol=${encodeURIComponent(ticker)}&interval=${interval}`;
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

function formatFilename(ticker, tf) {
  const now = new Date();
  const dd   = String(now.getDate()).padStart(2, "0");
  const mm   = String(now.getMonth() + 1).padStart(2, "0");
  const yy   = String(now.getFullYear()).slice(-2);
  const HH   = String(now.getHours()).padStart(2, "0");
  const MM   = String(now.getMinutes()).padStart(2, "0");
  const symbol = ticker.includes(":") ? ticker.split(":")[1] : ticker;
  return `${dd}${mm}${yy}_${HH}${MM}_${symbol}_${tf.toUpperCase()}`;
}

// ==== App ====
const app = express();
app.disable("x-powered-by");
app.use(cors({ origin: "*" }));

// resolve __dirname (ESM)
const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

// Serve static (optional). Nếu muốn để html ở /public thì dùng dòng dưới:
// app.use(express.static(join(__dirname, "public")));

app.get("/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// Trang chủ: trả index.html (đặt cùng thư mục với app.js)
app.get("/", (req, res) => {
  res.sendFile(join(__dirname, "index.html"));
});

// Capture → Upload Cloudinary → trả JSON có secure_url
app.get("/capture", async (req, res) => {
  const tfKey = (req.query.tf || "H1").toString().toUpperCase();
  const tf = TF_MAP[tfKey] ? tfKey : "H1";
  const w = clamp(req.query.w, 640, 2560, 1440);
  const h = clamp(req.query.h, 480, 1440, 900);
  const rawTicker = (req.query.ticker ?? "").toString().trim();
  const ticker = rawTicker !== "" ? rawTicker : DEFAULT_TICKER;

  let browser;

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

    // Giấu toolbar trái etc.
    await page.addStyleTag({
      content: `
        .layout__area--left, .drawingToolbar, .tv-floating-toolbar,
        [class*="drawingToolbar"], [class*="left-toolbar"] {
          display:none !important;
        }
      `
    });

    // Pan 50 nến sang phải
    await focusChart(page);
    for (let i = 0; i < 50; i++) {
      try { await page.keyboard.press("ArrowRight"); } catch {}
      await new Promise(r => setTimeout(r, 10));
    }

    // Ẩn crosshair
    try {
      const el = await findChartContainer(page);
      const box = el && await el.boundingBox();
      if (box) {
        await page.mouse.move(box.x + box.width + 8, box.y + 8);
      } else {
        await page.mouse.move(0, 0);
      }
    } catch {}

    const bufCrop = await screenshotChartRegion(page);
    const buf = bufCrop || await page.screenshot({ type: "png", fullPage: true });
    const fname = formatFilename(ticker, tf).replace(".png", "");

    // Upload Cloudinary
    const uploaded = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          resource_type: "image",
          folder: "tradingview",
          public_id: fname,
          overwrite: true,
          format: "png",
        },
        (error, result) => error ? reject(error) : resolve(result)
      );
      stream.end(buf);
    });

    await page.close();
    await browser.close();

    res.json({
      ok: true,
      url: uploaded.secure_url,
      public_id: uploaded.public_id,
      width: uploaded.width,
      height: uploaded.height,
      bytes: uploaded.bytes
    });

  } catch (e) {
    try { if (browser) await browser.close(); } catch {}
    res.status(500).json({ ok:false, error: e?.message || String(e) });
  }
});

app.listen(PORT, () => {
  console.log(`[server] listening on :${PORT}`);
});
