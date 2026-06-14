/**
 * Cloudflare Worker — Proxy Server
 * ===================================================
 * يستقبل طلبات HTTP القادمة من HF Space ويمررها
 * للموقع المستهدف عبر شبكة Cloudflare النظيفة.
 *
 * طريقة الرفع:
 *   1. اذهب إلى https://dash.cloudflare.com
 *   2. Workers & Pages → Create → Worker
 *   3. الصق هذا الكود → Deploy
 *   4. انسخ رابط الـ Worker مثال: https://proxy-abc.workers.dev
 *   5. ضعه في متغير البيئة CF_WORKER_URL داخل HF Space
 *
 * حماية الـ Worker بـ Secret Token (اختياري لكن مُوصى به):
 *   - أضف متغير بيئة في Worker باسم: PROXY_SECRET
 *   - ضع نفس القيمة في HF Space باسم: CF_WORKER_SECRET
 * ===================================================
 */

// ─── إعدادات قابلة للتعديل ──────────────────────────────────
const CONFIG = {
  // قائمة النطاقات المسموح بالوصول إليها (فارغة = الكل مسموح)
  ALLOWED_DOMAINS: [],

  // قائمة النطاقات المحظورة دائماً
  BLOCKED_DOMAINS: [
    "localhost",
    "127.0.0.1",
    "0.0.0.0",
    "169.254.169.254", // AWS metadata
    "metadata.google.internal",
  ],

  // الحد الأقصى لحجم الاستجابة (10 MB)
  MAX_RESPONSE_SIZE: 10 * 1024 * 1024,

  // مهلة الطلب بالميلي ثانية
  REQUEST_TIMEOUT_MS: 30000,

  // headers التي لا تُمرَّر للموقع المستهدف
  STRIP_REQUEST_HEADERS: [
    "cf-connecting-ip",
    "cf-ipcountry",
    "cf-ray",
    "cf-visitor",
    "cf-worker",
    "x-forwarded-for",
    "x-forwarded-proto",
    "x-real-ip",
    "host",
  ],

  // headers التي لا تُعاد للعميل
  STRIP_RESPONSE_HEADERS: [
    "content-encoding",
    "transfer-encoding",
    "connection",
    "keep-alive",
    "te",
    "trailers",
    "upgrade",
  ],

  // كلمة السر (يمكن تغييرها هنا مباشرة أو تركها فارغة)
  PROXY_SECRET: "",
};

// ─── Service Worker Format (متوافق مع جميع Workers) ─────────
addEventListener("fetch", (event) => {
  if (event.request.method === "OPTIONS") {
    event.respondWith(corsPreflightResponse());
    return;
  }
  event.respondWith(
    handleRequest(event.request).catch(
      (err) => jsonError(500, `Worker Error: ${err.message}`)
    )
  );
});

// ─── المعالج الرئيسي ─────────────────────────────────────────
async function handleRequest(request) {
  // 1. التحقق من الـ Secret Token إن كان مضبوطاً
  const secret = CONFIG.PROXY_SECRET || (typeof PROXY_SECRET !== "undefined" ? PROXY_SECRET : "");
  if (secret) {
    const clientSecret = request.headers.get("X-Proxy-Secret") || "";
    if (clientSecret !== secret) {
      return jsonError(401, "Unauthorized: Invalid proxy secret.");
    }
  }

  // 2. استخراج رابط الهدف من query param ?url=...
  const { searchParams } = new URL(request.url);
  const targetUrl = searchParams.get("url");

  if (!targetUrl) {
    return jsonError(400, "Missing required query parameter: ?url=<encoded_target_url>");
  }

  // 3. التحقق من صحة الـ URL
  let parsedUrl;
  try {
    parsedUrl = new URL(decodeURIComponent(targetUrl));
  } catch (_) {
    return jsonError(400, `Invalid target URL: ${targetUrl}`);
  }

  // 4. فحص النطاقات المحظورة
  const hostname = parsedUrl.hostname.toLowerCase();
  for (const blocked of CONFIG.BLOCKED_DOMAINS) {
    if (hostname === blocked || hostname.endsWith(`.${blocked}`)) {
      return jsonError(403, `Forbidden: Domain '${hostname}' is blocked.`);
    }
  }

  // 5. فحص النطاقات المسموحة (إن كانت القائمة غير فارغة)
  if (CONFIG.ALLOWED_DOMAINS.length > 0) {
    const isAllowed = CONFIG.ALLOWED_DOMAINS.some(
      (d) => hostname === d || hostname.endsWith(`.${d}`)
    );
    if (!isAllowed) {
      return jsonError(403, `Forbidden: Domain '${hostname}' is not in the allowed list.`);
    }
  }

  // 6. بناء الـ headers النظيفة للطلب الخارجي
  const outboundHeaders = new Headers();

  for (const [key, value] of request.headers.entries()) {
    const lowerKey = key.toLowerCase();
    if (!CONFIG.STRIP_REQUEST_HEADERS.includes(lowerKey) && !lowerKey.startsWith("cf-")) {
      outboundHeaders.set(key, value);
    }
  }

  outboundHeaders.set("Host", parsedUrl.host);

  if (!outboundHeaders.has("User-Agent")) {
    outboundHeaders.set(
      "User-Agent",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0"
    );
  }
  if (!outboundHeaders.has("Accept")) {
    outboundHeaders.set(
      "Accept",
      "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    );
  }
  if (!outboundHeaders.has("Accept-Language")) {
    outboundHeaders.set("Accept-Language", "en-US,en;q=0.9");
  }

  // 7. إعداد جسم الطلب (للـ POST)
  let requestBody = null;
  if (request.method !== "GET" && request.method !== "HEAD") {
    requestBody = await request.arrayBuffer();
  }

  // 8. إرسال الطلب للموقع المستهدف مع timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CONFIG.REQUEST_TIMEOUT_MS);

  let targetResponse;
  try {
    targetResponse = await fetch(parsedUrl.toString(), {
      method: request.method,
      headers: outboundHeaders,
      body: requestBody,
      signal: controller.signal,
      redirect: "follow",
    });
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === "AbortError") {
      return jsonError(504, `Gateway Timeout: Target did not respond within ${CONFIG.REQUEST_TIMEOUT_MS}ms`);
    }
    return jsonError(502, `Bad Gateway: ${err.message}`);
  } finally {
    clearTimeout(timeoutId);
  }

  // 9. قراءة جسم الاستجابة
  const responseBuffer = await targetResponse.arrayBuffer();

  if (responseBuffer.byteLength > CONFIG.MAX_RESPONSE_SIZE) {
    return jsonError(413, `Response too large: ${responseBuffer.byteLength} bytes (max: ${CONFIG.MAX_RESPONSE_SIZE})`);
  }

  // 10. بناء headers الاستجابة المرجعة للعميل
  const responseHeaders = new Headers();

  for (const [key, value] of targetResponse.headers.entries()) {
    const lowerKey = key.toLowerCase();
    if (!CONFIG.STRIP_RESPONSE_HEADERS.includes(lowerKey)) {
      responseHeaders.set(key, value);
    }
  }

  responseHeaders.set("Access-Control-Allow-Origin", "*");
  responseHeaders.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS, HEAD");
  responseHeaders.set("Access-Control-Allow-Headers", "*");
  responseHeaders.set("Access-Control-Expose-Headers", "*");
  responseHeaders.set("X-Proxy-Status", "success");
  responseHeaders.set("X-Proxied-URL", parsedUrl.toString());
  responseHeaders.set("X-Original-Status", String(targetResponse.status));

  return new Response(responseBuffer, {
    status: targetResponse.status,
    statusText: targetResponse.statusText,
    headers: responseHeaders,
  });
}

// ─── دوال مساعدة ─────────────────────────────────────────────
function jsonError(status, message) {
  return new Response(
    JSON.stringify({ error: true, status, message }),
    {
      status,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    }
  );
}

function corsPreflightResponse() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS, HEAD",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Max-Age": "86400",
    },
  });
}
