// app.js — Browserless Function API (không cần puppeteer cục bộ)
// Endpoint: /health và /capture (Browserless -> Cloudinary)

import express from "express";
import cors from "cors";
import { v2 as cloudinary } from "cloudinary";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

// ====== HARDCODE ======
// Browserless / TradingView
const TOKEN              = "2T3pecgTuZd5bOCc222501c80fb1028904a85a373f3163dcd"; // Browserless token
const TV_SESSIONID       = "o1hixcbxh1cvz59ri1u6d9juggsv9jko";                   // TradingView sessionid
const CHART_ID           = "fCLTltqk";
const DEFAULT_TICKER     = "OANDA:XAUUSD";
const BROWSERLESS_REGION = "production-sfo";
const FN_ENDPOINT        = `https://${BROWSERLESS_REGION}.browserless.io/function?token=${TOKEN}`;

// Cloudinary (HARDCODE)
cloudinary.config({
  cloud_name: "dxi9ensjq",
  api_key:    "784331526282828",
  api_secret: "9rbzDsR-tj87ao_NfDeX3lBoWPE",
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
function formatFilename(ticker, tf) {
  const now = new Date();
  const dd = String(now.getDate()).padStart(2, "0");
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const yy = String(now.getFullYear()).slice(-2);
  const HH = String(now.getHours()).padStart(2, "0");
  const MM = String(now.getMinutes()).padStart(2, "0");
  const symbol = ticker.includes(":") ? ticker.split(":")[1] : ticker;
  return `${dd}${mm}${yy}_${HH}${MM}_${symbol}_${tf.toUpperCase()}`;
}

// ==== App ====
const app = express();
app.disable("x-powered-by");
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "1mb" }));

// resolve __dirname (ESM)
const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

// (tuỳ chọn) phục vụ file tĩnh nếu bạn có /public
// app.use(express.static(join(__dirname, "public")));

app.get("/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// Trang chủ: trả index.html nếu có
app.get("/", (req, res) => {
  try {
    res.sendFile(join(__dirname, "index.html"));
  } catch {
    res.type("text/plain").send("OK");
  }
});

// Capture → Browserless Function → Upload Cloudinary → trả JSON có secure_url
app.get("/capture", async (req, res) => {
  const tfKey = (req.query.tf || "H1").toString().toUpperCase();
  const tf = TF_MAP[tfKey] ? tfKey : "H1";
  const w = clamp(req.query.w, 640, 2560, 1440);
  const h = clamp(req.query.h, 480, 1440, 900);
  const rawTicker = (req.query.ticker ?? "").toString().trim();
  const ticker = rawTicker !== "" ? rawTicker : DEFAULT_TICKER;
  const interval = TF_MAP[tf] || "60";

  // Code chạy TRÊN Browserless (wrap trong ngoặc để trả về function hợp lệ)
  const functionCode = `
(async ({ page, context }) => {
  const { tvSessionId, chartId, ticker, interval, width, height } = context;

  await page.setViewport({ width, height, deviceScaleFactor: 2 });

  // Set cookie trước khi vào chart
  await page.setCookie({
    name: 'sessionid',
    value: tvSessionId,
    url: 'https://www.tradingview.com',
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'Lax'
  });

  const url = 'https://www.tradingview.com/chart/' + chartId +
              '/?symbol=' + encodeURIComponent(ticker) +
              '&interval=' + interval;

  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
  } catch {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  }

  // Ẩn toolbar
  await page.addStyleTag({
    content: '.layout__area--left, .drawingToolbar, .tv-floating-toolbar, [class*="drawingToolbar"], [class*="left-toolbar"] { display:none !important; }'
  });

  // Tìm vùng chart để crop
  const sels = [
    'div[class*="chart-container"]',
    '[data-name="pane"]',
    'div[data-name="pane"]',
    'div[class*="chart-markup"]',
    'canvas[data-name="pane"]',
    'canvas'
  ];
  let el = null;
  for (const s of sels) { el = await page.$(s); if (el) break; }

  let clip = null;
  if (el) {
    await el.evaluate(e => e.scrollIntoView({ block: 'center', inline: 'center' }));
    const box = await el.boundingBox();
    if (box) {
      const pad = 2;
      clip = { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: Math.max(1, box.width + pad*2), height: Math.max(1, box.height + pad*2) };
    }
  }

  // Ẩn crosshair
  try { if (clip) await page.mouse.move(clip.x + clip.width + 8, clip.y + 8); else await page.mouse.move(0,0); } catch {}

  const buf = await page.screenshot(clip ? { type:'png', clip } : { type:'png', fullPage:true });
  return { ok:true, screenshot: buf.toString('base64') };
})
`.trim();

  try {
    const r = await fetch(FN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code: functionCode,
        context: {
          tvSessionId: TV_SESSIONID,
          chartId: CHART_ID,
          ticker,
          interval,
          width: w,
          height: h,
        }
      }),
    });

    const text = await r.text();
    if (!r.ok) {
      return res.status(r.status).json({ ok: false, error: `Browserless HTTP ${r.status}`, detail: text });
    }

    let data;
    try { data = JSON.parse(text); }
    catch { return res.status(502).json({ ok: false, error: "Invalid JSON from Browserless", detail: text }); }

    if (!data?.ok || !data?.screenshot) {
      return res.status(500).json({ ok: false, error: data?.error || "No screenshot in response", detail: data });
    }

    const buf = Buffer.from(data.screenshot, "base64");
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

    res.json({
      ok: true,
      url: uploaded.secure_url,
      public_id: uploaded.public_id,
      width: uploaded.width,
      height: uploaded.height,
      bytes: uploaded.bytes
    });

  } catch (e) {
    res.status(500).json({ ok:false, error: e?.message || String(e) });
  }
});

app.listen(PORT, () => {
  console.log(`[server] listening on :${PORT}`);
});
