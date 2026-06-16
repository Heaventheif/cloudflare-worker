/**
 * yt-worker.js — Cloudflare Worker
 * ══════════════════════════════════════════════════════════════
 * يستقبل طلبات من HF Space ويوجّهها لـ YouTube بـ IP نظيف
 *
 * نشر Worker:
 *   1. cloudflare.com → Workers & Pages → Create Worker
 *   2. الصق هذا الكود → Deploy
 *   3. انسخ الرابط: https://yt-proxy.YOUR-NAME.workers.dev
 *   4. أضفه في HF Space Secrets:  CF_WORKER_URL = https://...
 *
 * Endpoints:
 *   GET  /?url=<encoded_url>          ← proxy عام (للـ yt-dlp)
 *   POST /yt/search?q=<query>&n=10    ← بحث YouTube
 *   GET  /yt/info?v=<video_id>        ← معلومات فيديو
 *   GET  /yt/stream?v=<id>&t=audio    ← رابط تحميل مباشر
 * ══════════════════════════════════════════════════════════════
 */

// ─── headers تقليد متصفح حقيقي ───────────────────────────────
const BROWSER_HEADERS = {
  "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Encoding": "gzip, deflate, br",
  "Sec-Fetch-Mode":  "navigate",
  "Sec-Fetch-Site":  "none",
  "Sec-Fetch-Dest":  "document",
  "Sec-Ch-Ua":       '"Chromium";v="124", "Google Chrome";v="124"',
  "Sec-Ch-Ua-Mobile":"?0",
  "DNT":             "1",
};

// ─── CORS headers ────────────────────────────────────────────
const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

// ════════════════════════════════════════════════════════════
// 🔍  بحث YouTube — يجلب HTML صفحة النتائج ويحلّله
// ════════════════════════════════════════════════════════════
async function ytSearch(query, limit = 10) {
  const searchUrl =
    `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&hl=en`;

  const res = await fetch(searchUrl, { headers: BROWSER_HEADERS });
  if (!res.ok) throw new Error(`YouTube HTTP ${res.status}`);

  const html = await res.text();

  // yt_initial_data يحتوي كل نتائج البحث كـ JSON
  const match = html.match(/var ytInitialData\s*=\s*(\{.+?\});\s*<\/script>/s);
  if (!match) throw new Error("ytInitialData غير موجود في الصفحة");

  const data = JSON.parse(match[1]);

  // مسار البيانات داخل ytInitialData
  const contents =
    data?.contents
      ?.twoColumnSearchResultsRenderer
      ?.primaryContents
      ?.sectionListRenderer
      ?.contents?.[0]
      ?.itemSectionRenderer
      ?.contents || [];

  const results = [];
  for (const item of contents) {
    const v = item?.videoRenderer;
    if (!v || !v.videoId) continue;

    const durationText =
      v.lengthText?.simpleText ||
      v.lengthText?.accessibility?.accessibilityData?.label || "";

    results.push({
      id:       v.videoId,
      title:    v.title?.runs?.[0]?.text || "بدون عنوان",
      url:      `https://www.youtube.com/watch?v=${v.videoId}`,
      duration: durationText,
      uploader: v.ownerText?.runs?.[0]?.text || v.shortBylineText?.runs?.[0]?.text || "",
      views:    v.viewCountText?.simpleText || "",
      thumb:    `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
    });

    if (results.length >= limit) break;
  }

  return results;
}

// ════════════════════════════════════════════════════════════
// ℹ️  معلومات فيديو — يجلب صفحة الفيديو ويحلّلها
// ════════════════════════════════════════════════════════════
async function ytInfo(videoId) {
  const url = `https://www.youtube.com/watch?v=${videoId}&hl=en`;
  const res = await fetch(url, { headers: BROWSER_HEADERS });
  if (!res.ok) throw new Error(`YouTube HTTP ${res.status}`);

  const html = await res.text();
  const match = html.match(/var ytInitialData\s*=\s*(\{.+?\});\s*<\/script>/s);
  if (!match) throw new Error("ytInitialData غير موجود");

  const data = JSON.parse(match[1]);
  const vd =
    data?.contents
      ?.twoColumnWatchNextResults
      ?.results
      ?.results
      ?.contents?.[0]
      ?.videoPrimaryInfoRenderer;

  const vd2 =
    data?.contents
      ?.twoColumnWatchNextResults
      ?.results
      ?.results
      ?.contents?.[1]
      ?.videoSecondaryInfoRenderer;

  return {
    id:          videoId,
    title:       vd?.title?.runs?.[0]?.text || "",
    views:       vd?.viewCount?.videoViewCountRenderer?.viewCount?.simpleText || "",
    uploadDate:  vd?.dateText?.simpleText || "",
    uploader:    vd2?.owner?.videoOwnerRenderer?.title?.runs?.[0]?.text || "",
    url:         `https://www.youtube.com/watch?v=${videoId}`,
  };
}

// ════════════════════════════════════════════════════════════
// 🌐  Proxy عام — يمرّر أي URL عبر الـ Worker
// يستخدمه yt-dlp عبر --proxy أو مباشرة
// ════════════════════════════════════════════════════════════
async function proxyUrl(targetUrl, originalRequest) {
  // أعد بناء الـ headers مع إزالة headers الـ Worker
  const headers = new Headers(BROWSER_HEADERS);

  // أضف headers مخصصة من الطلب الأصلي إذا احتجنا
  const contentType = originalRequest.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);

  const init = {
    method:  originalRequest.method,
    headers,
    redirect: "follow",
  };

  // مرّر الـ body لطلبات POST
  if (["POST", "PUT", "PATCH"].includes(originalRequest.method)) {
    init.body = await originalRequest.arrayBuffer();
  }

  const res = await fetch(targetUrl, init);

  // أعد بناء Response مع CORS headers
  const resHeaders = new Headers(res.headers);
  Object.entries(CORS).forEach(([k, v]) => resHeaders.set(k, v));
  // مهم: أزل header الأمان الذي يمنع iframe
  resHeaders.delete("x-frame-options");
  resHeaders.delete("content-security-policy");

  return new Response(res.body, {
    status:  res.status,
    headers: resHeaders,
  });
}

// ════════════════════════════════════════════════════════════
// Router الرئيسي
// ════════════════════════════════════════════════════════════
export default {
  async fetch(request, env, ctx) {
    const url    = new URL(request.url);
    const path   = url.pathname;
    const method = request.method;

    // OPTIONS (CORS preflight)
    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    try {

      // ── /yt/search?q=...&n=10 ──────────────────────────
      if (path === "/yt/search") {
        const q = url.searchParams.get("q") || "";
        const n = Math.min(parseInt(url.searchParams.get("n") || "10"), 15);
        if (!q) return json({ error: "q مطلوب" }, 400);

        const results = await ytSearch(q, n);
        return json({ results });
      }

      // ── /yt/info?v=VIDEO_ID ───────────────────────────
      if (path === "/yt/info") {
        const v = url.searchParams.get("v") || "";
        if (!v) return json({ error: "v مطلوب" }, 400);

        const info = await ytInfo(v);
        return json(info);
      }

      // ── /?url=<encoded> — proxy عام ───────────────────
      const targetUrl = url.searchParams.get("url");
      if (targetUrl) {
        // تحقق أن الرابط مسموح (YouTube فقط للأمان)
        const allowed = [
          "youtube.com", "youtu.be", "googlevideo.com",
          "ytimg.com", "ggpht.com", "googleusercontent.com",
          "googleapis.com",
        ];
        const targetHost = new URL(targetUrl).hostname;
        const ok = allowed.some(d => targetHost === d || targetHost.endsWith(`.${d}`));
        if (!ok) return json({ error: "الدومين غير مسموح" }, 403);

        return await proxyUrl(targetUrl, request);
      }

      // ── / — صفحة الحالة ──────────────────────────────
      if (path === "/" && !targetUrl) {
        return json({
          status:    "✅ yt-worker يعمل",
          endpoints: [
            "GET  /?url=<encoded_url>       ← proxy عام",
            "GET  /yt/search?q=...&n=10     ← بحث",
            "GET  /yt/info?v=VIDEO_ID        ← معلومات فيديو",
          ],
        });
      }

      return json({ error: "مسار غير موجود" }, 404);

    } catch (err) {
      return json({ error: err.message || "خطأ داخلي" }, 500);
    }
  },
};
