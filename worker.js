export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // استخراج الرابط المستهدف من Query Parameter المسمى "target"
    const targetUrl = url.searchParams.get("target");
    
    if (!targetUrl) {
      return new Response("Missing 'target' parameter.", { status: 400 });
    }

    // نسخ الـ Headers الأصلية القادمة من Hugging Face لتمريرها
    const newHeaders = new Headers(request.headers);
    newHeaders.delete("host"); // حذف الهوست الافتراضي للـ worker

    try {
      // إرسال الطلب من داخل شبكة Cloudflare لتبدو حركة المرور موثوقة
      const response = await fetch(targetUrl, {
        method: request.method,
        headers: newHeaders,
        body: request.body,
        redirect: "follow"
      });

      // إعادة النتيجة الصافية إلى Hugging Face
      const responseHeaders = new Headers(response.headers);
      responseHeaders.set("Access-Control-Allow-Origin", "*");

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders
      });
    } catch (error) {
      return new Response(`Worker Error: ${error.message}`, { status: 500 });
    }
  }
};