// =============================================================
// 케어루프 CRM — 문자 자동 발송 Edge Function (솔라피)
// 배포: Supabase Dashboard → Edge Functions → Deploy a new function
//       이름: send-sms → 이 파일 내용 붙여넣기 → Deploy
// 시크릿: Edge Functions → Secrets 에 3개 추가
//   SOLAPI_KEY    = 솔라피 콘솔 → API Key
//   SOLAPI_SECRET = 솔라피 콘솔 → API Secret
//   SOLAPI_SENDER = 솔라피에 등록·심사된 발신번호 (예: 0507xxxxxxx)
// 동작: 로그인 사용자(병원 소속)만 호출 가능 · 21~08시(KST)는 익일 09:00 예약 발송
//       90바이트 이하 SMS / 초과 시 LMS 자동 선택
// =============================================================
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(o: unknown) {
  return new Response(JSON.stringify(o), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    // 1) 호출자 검증 — 앱 로그인 사용자만
    const supa = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } },
    );
    const { data: { user } } = await supa.auth.getUser();
    if (!user) return json({ error: "로그인이 필요합니다" });
    const { data: mem } = await supa.from("clinic_members").select("clinic_id").eq("user_id", user.id).maybeSingle();
    if (!mem) return json({ error: "병원 소속 계정이 아닙니다" });

    // 2) 입력 검증
    const { to, text } = await req.json();
    const toNorm = String(to ?? "").replace(/[^0-9]/g, "");
    if (toNorm.length < 10 || !text) return json({ error: "수신번호 또는 문안이 비어 있습니다" });

    const KEY = Deno.env.get("SOLAPI_KEY");
    const SECRET = Deno.env.get("SOLAPI_SECRET");
    const FROM = (Deno.env.get("SOLAPI_SENDER") ?? "").replace(/[^0-9]/g, "");
    if (!KEY || !SECRET || !FROM) {
      return json({ error: "솔라피 시크릿이 설정되지 않았습니다 (SOLAPI_KEY / SOLAPI_SECRET / SOLAPI_SENDER)" });
    }

    // 3) 야간(KST 21:00~08:00) → 익일 09:00 예약
    const kst = new Date(Date.now() + 9 * 3600_000);
    const h = kst.getUTCHours();
    let scheduledDate: string | undefined;
    if (h >= 21 || h < 8) {
      const d = new Date(kst);
      d.setUTCHours(9, 0, 0, 0);
      if (h >= 21) d.setUTCDate(d.getUTCDate() + 1);
      scheduledDate = new Date(d.getTime() - 9 * 3600_000).toISOString();
    }

    // 4) SMS/LMS 자동 판별 (한글 2바이트 기준 90바이트)
    const bytes = [...String(text)].reduce((a, c) => a + (c.charCodeAt(0) > 127 ? 2 : 1), 0);
    const type = bytes <= 90 ? "SMS" : "LMS";

    // 5) 솔라피 HMAC-SHA256 서명
    const date = new Date().toISOString();
    const salt = crypto.randomUUID().replace(/-/g, "");
    const enc = new TextEncoder();
    const hkey = await crypto.subtle.importKey("raw", enc.encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = await crypto.subtle.sign("HMAC", hkey, enc.encode(date + salt));
    const signature = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");

    const body: Record<string, unknown> = {
      messages: [{
        to: toNorm,
        from: FROM,
        text: String(text),
        type,
        ...(type === "LMS" ? { subject: "병원 안내" } : {}),
      }],
    };
    if (scheduledDate) body.scheduledDate = scheduledDate;

    const res = await fetch("https://api.solapi.com/messages/v4/send-many/detail", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `HMAC-SHA256 apiKey=${KEY}, date=${date}, salt=${salt}, signature=${signature}`,
      },
      body: JSON.stringify(body),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) {
      return json({ error: (out as Record<string, string>)?.errorMessage ?? `솔라피 오류 (HTTP ${res.status})` });
    }
    const groupId = (out as { groupInfo?: { groupId?: string }; groupId?: string })?.groupInfo?.groupId ??
      (out as { groupId?: string })?.groupId ?? null;
    return json({ ok: true, type, scheduled: !!scheduledDate, scheduledDate: scheduledDate ?? null, groupId });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) });
  }
});
