/**
 * yt-worker.js — Cloudflare Worker v2
 * ══════════════════════════════════════════════════════════════
 * Endpoints:
 *   GET  /yt/search?q=...&n=10     ← بحث YouTube
 *   GET  /yt/info?v=VIDEO_ID       ← معلومات فيديو
 *   GET  /yt/stream?v=ID&t=audio   ← يجلب روابط التحميل المباشرة
 *   GET  /?url=<encoded_url>       ← proxy عام (لجلب ملفات الميديا)
 * ══════════════════════════════════════════════════════════════
 */

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
// 🔍  بحث YouTube
// ════════════════════════════════════════════════════════════
async function ytSearch(query, limit = 10) {
  const res = await fetch(
    `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&hl=en`,
    { headers: BROWSER_HEADERS }
  );
  if (!res.ok) throw new Error(`YouTube HTTP ${res.status}`);
  const html = await res.text();
  const match = html.match(/var ytInitialData\s*=\s*(\{.+?\});\s*<\/script>/s);
  if (!match) throw new Error("ytInitialData غير موجود في الصفحة");
  const data = JSON.parse(match[1]);
  const contents =
    data?.contents?.twoColumnSearchResultsRenderer?.primaryContents
      ?.sectionListRenderer?.contents?.[0]?.itemSectionRenderer?.contents || [];
  const results = [];
  for (const item of contents) {
    const v = item?.videoRenderer;
    if (!v?.videoId) continue;
    results.push({
      id:       v.videoId,
      title:    v.title?.runs?.[0]?.text || "بدون عنوان",
      url:      `https://www.youtube.com/watch?v=${v.videoId}`,
      duration: v.lengthText?.simpleText || "",
      uploader: v.ownerText?.runs?.[0]?.text || "",
      views:    v.viewCountText?.simpleText || "",
      thumb:    `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
    });
    if (results.length >= limit) break;
  }
  return results;
}

// ════════════════════════════════════════════════════════════
// 🎵  استخراج روابط التحميل المباشرة من صفحة الفيديو
//     يُعيد: { audioUrl, videoUrl, title, duration, uploader }
// ════════════════════════════════════════════════════════════
async function ytStream(videoId) {
  const pageUrl = `https://www.youtube.com/watch?v=${videoId}&hl=en`;
  const res = await fetch(pageUrl, { headers: BROWSER_HEADERS });
  if (!res.ok) throw new Error(`YouTube HTTP ${res.status}`);
  const html = await res.text();

  // استخرج ytInitialPlayerResponse
  const match = html.match(/var ytInitialPlayerResponse\s*=\s*(\{.+?\});\s*(?:var|<\/script>)/s);
  if (!match) throw new Error("ytInitialPlayerResponse غير موجود");

  const player = JSON.parse(match[1]);
  const status = player?.playabilityStatus?.status;
  if (status !== "OK") throw new Error(`الفيديو غير متاح: ${status}`);

  const details   = player?.videoDetails || {};
  const formats   = player?.streamingData?.formats           || [];
  const adaptives = player?.streamingData?.adaptiveFormats   || [];
  const allFmts   = [...formats, ...adaptives];

  // ── أفضل رابط صوت فقط (m4a/mp4 ← webm) ─────────────────
  const audioFmts = adaptives
    .filter(f => f.mimeType?.startsWith("audio/") && f.url)
    .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

  // ── أفضل رابط فيديو ≤360p مع صوت (mp4) ──────────────────
  const videoFmts = formats
    .filter(f => f.url && f.height && f.height <= 360 && f.mimeType?.includes("mp4"))
    .sort((a, b) => (b.height || 0) - (a.height || 0));

  // ── fallback: أي فيديو ≤360p ─────────────────────────────
  const videoFallback = allFmts
    .filter(f => f.url && f.height && f.height <= 360)
    .sort((a, b) => (b.height || 0) - (a.height || 0));

  const audioUrl = audioFmts[0]?.url || null;
  const videoUrl = (videoFmts[0] || videoFallback[0])?.url || null;

  if (!audioUrl && !videoUrl) throw new Error("لا توجد روابط تحميل متاحة (قد يكون الفيديو محمياً)");

  return {
    audioUrl,
    videoUrl,
    title:    details.title    || videoId,
    duration: parseInt(details.lengthSeconds || "0"),
    uploader: details.author   || "",
    videoId,
  };
}

// ════════════════════════════════════════════════════════════
// 🌐  Proxy عام — يمرّر أي URL مسموح عبر Worker
// ════════════════════════════════════════════════════════════
async function proxyUrl(targetUrl, originalRequest) {
  const headers = new Headers(BROWSER_HEADERS);
  const contentType = originalRequest.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);

  const init = {
    method:  originalRequest.method,
    headers,
    redirect: "follow",
  };
  if (["POST", "PUT", "PATCH"].includes(originalRequest.method)) {
    init.body = await originalRequest.arrayBuffer();
  }

  const res = await fetch(targetUrl, init);
  const resHeaders = new Headers(res.headers);
  Object.entries(CORS).forEach(([k, v]) => resHeaders.set(k, v));
  resHeaders.delete("x-frame-options");
  resHeaders.delete("content-security-policy");

  return new Response(res.body, { status: res.status, headers: resHeaders });
}

// ════════════════════════════════════════════════════════════
// Router
// ════════════════════════════════════════════════════════════
export default {
  async fetch(request, env, ctx) {
    const url    = new URL(request.url);
    const path   = url.pathname;
    const method = request.method;

    if (method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    try {

      // ── /yt/search?q=...&n=10 ─────────────────────────
      if (path === "/yt/search") {
        const q = url.searchParams.get("q") || "";
        const n = Math.min(parseInt(url.searchParams.get("n") || "10"), 15);
        if (!q) return json({ error: "q مطلوب" }, 400);
        const results = await ytSearch(q, n);
        return json({ results });
      }

      // ── /yt/stream?v=VIDEO_ID ─────────────────────────
      // يُعيد روابط التحميل المباشرة من YouTube
      // yt.py يستدعيه ثم يحمّل الملف عبر /?url=
      if (path === "/yt/stream") {
        const v = url.searchParams.get("v") || "";
        if (!v) return json({ error: "v مطلوب" }, 400);
        const stream = await ytStream(v);
        return json(stream);
      }

      // ── /?url=<encoded> — proxy عام ───────────────────
      const targetUrl = url.searchParams.get("url");
      if (targetUrl) {
        const allowed = [
          "youtube.com", "youtu.be", "googlevideo.com",
          "ytimg.com", "ggpht.com", "googleusercontent.com", "googleapis.com",
        ];
        const targetHost = new URL(targetUrl).hostname;
        const ok = allowed.some(d => targetHost === d || targetHost.endsWith(`.${d}`));
        if (!ok) return json({ error: "الدومين غير مسموح" }, 403);
        return await proxyUrl(targetUrl, request);
      }

      // ── / — صفحة الحالة ──────────────────────────────
      if (path === "/") {
        return json({
          status: "✅ yt-worker v2 يعمل",
          endpoints: [
            "GET /yt/search?q=...&n=10   ← بحث",
            "GET /yt/stream?v=VIDEO_ID   ← روابط تحميل مباشرة",
            "GET /?url=<encoded_url>     ← proxy عام للميديا",
          ],
        });
      }

      return json({ error: "مسار غير موجود" }, 404);

    } catch (err) {
      return json({ error: err.message || "خطأ داخلي" }, 500);
    }
  },
};
