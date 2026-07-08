// =============================================================
// 케어루프 CRM — AI 직원 오케스트레이션 Edge Function
// 배포: Supabase Dashboard → Edge Functions → Deploy a new function
//       이름: ai-employee → 이 파일 내용 붙여넣기 → Deploy
// 시크릿: Edge Functions → Secrets 에 1개 추가
//   ANTHROPIC_API_KEY = Anthropic 콘솔(console.anthropic.com) → API Keys
// 구조: 오케스트레이터(AI 실장)가 병원 데이터를 조회하고
//       4명의 전문 AI 직원에게 업무를 위임해 결과를 종합한다.
//   · writer     — 메시지 작가 (환자 케어 문안 초안)
//   · compliance — 컴플라이언스 검수관 (의료법·정보통신망법 검수)
//   · analyst    — 데이터 분석가 (재내원·이탈·KPI 해석)
//   · briefer    — 브리핑 비서 (진료 전 환자 브리핑·오늘 현황)
// 안전: AI는 발송 권한이 없다 — 모든 문안은 초안이며 발송은 사람이 누른다.
//       전화번호·발송토큰은 조회 컬럼에서 제외 (개인정보 최소화).
// 호출: sb.functions.invoke('ai-employee', { body: { task, employee?, patientId? } })
//       { ping: true } 는 키 유효성만 확인 (과금 없는 모델 조회)
// =============================================================
import { createClient } from "npm:@supabase/supabase-js@2";
import Anthropic from "npm:@anthropic-ai/sdk";

const MODEL = "claude-opus-4-8";       // 필요 시 모델만 교체
const MAX_ROUNDS = 6;                  // 오케스트레이터 도구 사용 왕복 상한 (엣지 함수 시간 보호)

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(o: unknown) {
  return new Response(JSON.stringify(o), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
}

// 개인정보 최소화 — 전화번호·발송토큰은 AI에게 절대 넘기지 않는다
const PATIENT_COLS =
  "id,chart_no,name,grp,grp_override,score,pot,act,consent,blocked,blocked_reason,crisis,treat_status,unsendable,channel,patient_type,visit_count,last_visit_at,next_send_at,next_send_label,symptoms";

/* ================= AI 직원 프로필 (시스템 프롬프트) ================= */
type EmployeeKey = "writer" | "compliance" | "analyst" | "briefer";

const EMPLOYEES: Record<EmployeeKey, { title: string; system: (c: ClinicInfo) => string }> = {
  writer: {
    title: "메시지 작가",
    system: (c) => `당신은 ${c.name}(${c.spec}, 대표원장 ${c.doctor})의 CRM 메시지 작가 AI 직원입니다.
환자 1:1 밀착 케어 철학에 맞는 개인화 케어 문안 '초안'을 작성합니다. 발송은 사람이 합니다.

[문체 원칙]
- 원장(${c.doctor}) 명의 1인칭, 진심이 느껴지는 따뜻하고 담백한 말투. 과장·호들갑 금지.
- 짧은 문장, 자연스러운 줄바꿈. 환자 이름은 #{환자명} 변수로 표기.
- 스팸처럼 보이는 이모지 남발·전체 대문자·연속 느낌표 금지.

[컴플라이언스 기본 수칙 — 초안 단계부터 준수]
- 광고성(재내원 유도·건강팁·이벤트) 문안: 첫 줄 "(광고)" + 발신자명, 말미에 무료수신거부 안내 자리 표시.
- 정보성(예약·복약지도·경과체크) 문안: (광고) 표기 불필요.
- 치료효과 보장·과장 표현 금지: "완치", "100%", "최고", "부작용 없음" 등.
- 소개 리워드·할인·금품 제공 언급 금지 (의료법 27조 환자 유인).
- 치료경험담(환자 후기) 형식·치료 전후 비교 표현 금지 (의료법 56조 의료광고 규제).
- 민감 병명은 완곡 표현: 치매→기억력·뇌 건강, 중풍→혈관 건강, 암→정기 검진.
- 관여도 등급(상/중/하)·점수 등 내부 용어를 문안에 노출 금지.

[출력 형식]
1) 문안 (그대로 복사해 쓸 수 있게)
2) 제안 채널: 알림톡/친구톡/LMS 중 택1 + 이유 한 줄
3) 발송 전 확인사항 (있다면)`,
  },
  compliance: {
    title: "컴플라이언스 검수관",
    system: (c) => `당신은 ${c.name}(${c.spec})의 컴플라이언스 검수관 AI 직원입니다.
환자에게 나갈 메시지 문안과 CRM 운영 행위를 의료법·의료광고·정보통신망법 관점에서 검수합니다.

[검수 체크리스트]
① 의료법 27조 유인·알선 — 소개 리워드, 본인부담금 할인·면제, 금품 제공 표현
② 의료광고 위반 — 치료효과 보장("완치", "100%"), 비교·최상급 표현, 근거 없는 효능
③ 광고성 메시지 요건 — "(광고)" 표기 + 발신자명 + 무료수신거부 안내 (정보성 메시지는 예외)
④ 야간 전송 — 21:00~08:00 광고성 전송 금지 (시스템이 익일 예약 처리함을 안내)
⑤ 민감 병명 직접 언급 — 치매·중풍·암 등은 완곡 표현으로
⑥ 발송 대상 적정성 — 마케팅 미동의·발송중단·발송부적합·위기 상태 환자에게 광고성 발송 불가
⑦ 내부 용어 노출 — 관여도 등급·점수·세그먼트 명칭이 문안에 보이면 안 됨
⑧ 개인정보 과다 — 문안에 불필요한 진료 상세·민감정보 포함 여부
⑨ 치료경험담·전후 비교 금지(의료법 56조) — 환자 후기·치료 전후 사진/비교 형식의 문안·콘텐츠
⑩ 의료광고 사전심의(의료법 57조) — 불특정 다수에게 노출되는 온라인 광고성 콘텐츠(유튜브·SNS·블로그·홈페이지)는
   자율심의기구(의사회·한의사회 등) 사전심의 대상일 수 있음 — 해당 여부와 미심의 리스크를 판정에 명시.
   (1:1 개인 메시지는 성격이 다르지만 치료효과 보장 등 표현 규제는 동일하게 적용)
⑪ 부작용·개인차 고지 — 치료·시술의 효능을 언급할 때 중요 정보 누락 여부

[출력 형식]
- 판정: ✅ 통과 / ⚠ 수정 필요 / ⛔ 발송 불가
- 항목별 지적 (해당 항목 번호와 근거)
- 수정 필요 시: 바로 쓸 수 있는 수정안 제시
과잉 검열은 하지 않되, 애매하면 안전측으로 판정합니다.`,
  },
  analyst: {
    title: "데이터 분석가",
    system: (c) => `당신은 ${c.name}(${c.spec})의 CRM 데이터 분석가 AI 직원입니다.
전달받은 병원 데이터(환자·내원·프로그램·발송 기록)를 근거로 해석과 실행 제안을 만듭니다.

[분석 원칙]
- 전달받은 데이터에 있는 숫자만 사용합니다. 없는 수치는 "데이터에 없음"이라고 말하고 지어내지 않습니다.
- 표본이 작으면 반드시 명시합니다 (n=). 단정 대신 "신호" 수준으로 표현합니다.
- 해석은 반드시 "그래서 무엇을 할지"로 끝납니다 — 데스크가 오늘 실행할 수 있는 우선순위 1~3개.
- 재내원·이탈 관점: 마지막 방문 경과일, 치료상태(중단추정/완료), 위기 이력, 관여도 흐름을 중심으로.

[출력 형식]
1) 핵심 발견 (2~3줄)
2) 근거 숫자
3) 오늘의 실행 제안 (우선순위 순)`,
  },
  briefer: {
    title: "브리핑 비서",
    system: (c) => `당신은 ${c.name}(${c.spec}, 대표원장 ${c.doctor})의 브리핑 비서 AI 직원입니다.
진료 사이 2~3분밖에 없는 원장을 위해 "10초 안에 읽히는" 브리핑을 만듭니다.

[브리핑 원칙]
- 결론 먼저. 가장 중요한 한 줄이 맨 위.
- 임상 정보(방문 이력·주증상·프로그램 경과)가 먼저, CRM 지표(관여도·발송)는 뒤.
- 위기·발송중단·특이사항은 눈에 띄게 ⚠ 로 표시.
- 전달받은 데이터에 없는 내용은 추측하지 않습니다.

[환자 브리핑 출력 형식]
· 한 줄 요약 (누구, 왜 왔고, 지금 뭐가 중요한지)
· 임상 흐름: 방문 n회 · 마지막 방문 · 주증상 · 진행 중 프로그램/체크포인트
· 주의: 위기/중단/미동의 등 플래그
· 오늘 포인트: 원장이 진료실에서 한 마디 하면 좋은 것`,
  },
};

type ClinicInfo = { name: string; spec: string; doctor: string };

const ORCH_SYSTEM = (c: ClinicInfo) => `당신은 '케어루프 CRM'의 AI 실장입니다.
${c.name}(${c.spec}, 대표원장 ${c.doctor})의 CRM 실무를 총괄하는 오케스트레이터로서,
병원 데이터 조회 도구와 4명의 전문 AI 직원(ask_specialist)을 지휘해 원장·데스크의 요청을 처리합니다.

[팀 구성 — ask_specialist(employee=...)로 위임]
- writer(메시지 작가): 환자 개인화 케어 문안 초안 작성
- compliance(컴플라이언스 검수관): 문안·운영 행위의 의료법/정보통신망법 검수
- analyst(데이터 분석가): 숫자 해석, 재내원·이탈 분석, 실행 우선순위 제안
- briefer(브리핑 비서): 진료 전 환자 브리핑, 오늘 현황 요약

[업무 원칙]
1. 먼저 도구로 실제 데이터를 조회한 뒤 일합니다. 환자 정보를 추측으로 지어내지 않습니다.
2. 도구 호출은 필요한 최소한으로. 여러 조회가 필요하면 한 턴에 병렬로 요청합니다.
3. 환자에게 나갈 문안은 writer에게 작성시키고, 최종 제시 전 compliance 검수를 거칩니다.
   검수에서 수정 필요가 나오면 수정안을 반영한 최종본을 제시합니다.
4. 당신과 AI 직원 모두 발송 권한이 없습니다. 모든 문안은 '초안'이고 발송 버튼은 사람이 누릅니다.
   문안을 제시할 때 이 사실을 한 줄로 명시합니다.
5. 발송중단(blocked)·발송부적합(unsendable)·마케팅 미동의(consent=false) 환자에게 광고성 문안을
   제안하지 않습니다. 위기(crisis='위기'/'대응중') 환자는 위기 대응 외 발송을 보류합니다.
6. 개인정보 최소화 — 전화번호 등은 아예 조회되지 않으며, 답변에 불필요한 민감정보를 싣지 않습니다.
   관여도 등급(상/중/하)은 내부 운영 용어이므로 환자 노출 문안에 쓰지 않습니다.
7. 최종 답변은 한국어로, 데스크 직원이 읽고 바로 실행할 수 있게 결론부터 간결하게 씁니다.
8. 요청이 병원 CRM 업무와 무관하면 정중히 범위를 안내하고 처리하지 않습니다.`;

/* ================= 도구 정의 ================= */
const TOOLS: Anthropic.Tool[] = [
  {
    name: "get_today_snapshot",
    description:
      "오늘(KST) 병원 현황 스냅샷 — 오늘 내원 목록, 위기 환자, 진행 중 프로그램의 체크포인트(D+1 복약지도/D+5 경과체크/종료 3일 전 재안내 도래 여부), 치료 중단추정 환자, 발송중단 인원. 오늘 브리핑·액션 정리에 먼저 호출.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "search_patients",
    description: "이름 또는 차트번호로 환자 검색 (최대 15명). 환자를 특정해야 하는 모든 업무의 시작점.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "환자 이름 또는 차트번호 (부분 일치)" } },
      required: ["query"],
    },
  },
  {
    name: "get_patient_360",
    description: "환자 1명의 360 뷰 — 마스터 정보 + 최근 내원 10건 + 프로그램 + 최근 발송 10건 + 관여도 이력. 브리핑·개인화 문안 작성 전 필수.",
    input_schema: {
      type: "object",
      properties: { patient_id: { type: "string", description: "환자 UUID (search_patients 결과의 id)" } },
      required: ["patient_id"],
    },
  },
  {
    name: "ask_specialist",
    description: "전문 AI 직원에게 업무 위임. 문안 작성=writer, 문안 검수=compliance, 데이터 해석=analyst, 브리핑 작성=briefer. task에 지시를, context에 도구로 조회한 관련 데이터를 그대로 넘긴다.",
    input_schema: {
      type: "object",
      properties: {
        employee: { type: "string", enum: ["writer", "compliance", "analyst", "briefer"], description: "위임할 AI 직원" },
        task: { type: "string", description: "구체적인 업무 지시" },
        context: { type: "string", description: "업무에 필요한 데이터·문안 등 맥락 (조회 결과를 요약하지 말고 그대로 전달)" },
      },
      required: ["employee", "task"],
    },
  },
];

/* ================= 유틸 ================= */
function kstToday(): { day: string; next: string } {
  const kst = new Date(Date.now() + 9 * 3600_000);
  const day = kst.toISOString().slice(0, 10);
  const n = new Date(kst.getTime() + 24 * 3600_000);
  return { day, next: n.toISOString().slice(0, 10) };
}

function daysBetween(from: string, to: string): number {
  return Math.round((new Date(to).getTime() - new Date(from).getTime()) / 86_400_000);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    // 1) 호출자 검증 — 앱 로그인 사용자만 (send-sms와 동일)
    const supa = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } },
    );
    const { data: { user } } = await supa.auth.getUser();
    if (!user) return json({ error: "로그인이 필요합니다" });
    const { data: mem } = await supa.from("clinic_members").select("clinic_id").eq("user_id", user.id).maybeSingle();
    if (!mem) return json({ error: "병원 소속 계정이 아닙니다" });
    const clinicId = mem.clinic_id as string;

    // 2) 시크릿 확인
    const KEY = Deno.env.get("ANTHROPIC_API_KEY");
    if (!KEY) return json({ error: "ANTHROPIC_API_KEY 시크릿이 설정되지 않았습니다 (Edge Functions → Secrets)" });
    const anthropic = new Anthropic({ apiKey: KEY });

    // 3) 입력
    const body = await req.json().catch(() => ({}));

    // 3-1) 연동 테스트 — 모델 조회만 (과금 없음)
    if (body?.ping) {
      const m = await anthropic.models.retrieve(MODEL);
      return json({ ok: true, ping: true, model: m.id });
    }

    const task = String(body?.task ?? "").trim().slice(0, 2000);
    const employee = String(body?.employee ?? "auto");
    const patientId = body?.patientId ? String(body.patientId) : null;
    if (!task) return json({ error: "업무 내용(task)이 비어 있습니다" });

    // 4) 병원 정보 (프롬프트 컨텍스트)
    const { data: clinicRow } = await supa.from("clinics").select("name,spec,doctor").eq("id", clinicId).maybeSingle();
    const clinic: ClinicInfo = {
      name: clinicRow?.name ?? "병원",
      spec: clinicRow?.spec ?? "의원",
      doctor: clinicRow?.doctor ?? "원장",
    };

    // 5) 실행 트레이스 + 토큰 사용량 집계
    const trace: Array<{ actor: string; action: string; detail: string }> = [];
    const usage = { input_tokens: 0, output_tokens: 0, calls: 0 };
    const addUsage = (u: Anthropic.Usage) => {
      usage.input_tokens += u.input_tokens;
      usage.output_tokens += u.output_tokens;
      usage.calls++;
    };

    /* ---------- 전문 AI 직원 1명 호출 ---------- */
    async function runSpecialist(key: EmployeeKey, specTask: string, context?: string): Promise<string> {
      const emp = EMPLOYEES[key];
      trace.push({ actor: emp.title, action: "consult", detail: specTask.slice(0, 120) });
      const res = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 8000,
        thinking: { type: "adaptive" },
        system: emp.system(clinic),
        messages: [{ role: "user", content: context ? `${specTask}\n\n[관련 데이터·문안]\n${context}` : specTask }],
      });
      addUsage(res.usage);
      if (res.stop_reason === "refusal") return "(요청이 정책상 처리되지 않았습니다)";
      return res.content.filter((b) => b.type === "text").map((b) => (b as Anthropic.TextBlock).text).join("\n");
    }

    /* ---------- 데이터 조회 도구 (clinic_id 스코프 고정) ---------- */
    async function toolTodaySnapshot(): Promise<string> {
      const { day, next } = kstToday();
      const [visits, crisis, programs, dropouts, blocked] = await Promise.all([
        supa.from("visits").select("at,item,main_symptom,status,patients(name,chart_no)")
          .eq("clinic_id", clinicId).gte("at", `${day}T00:00:00+09:00`).lt("at", `${next}T00:00:00+09:00`).order("at"),
        supa.from("patients").select(PATIENT_COLS).eq("clinic_id", clinicId).in("crisis", ["위기", "대응중"]).limit(20),
        supa.from("programs").select("id,patient_id,name,days,start_date,d5_response,d1_sent,d5_sent,renew_sent,patients(name)")
          .eq("clinic_id", clinicId).is("outcome", null).gte("start_date", new Date(Date.now() - 70 * 86_400_000).toISOString().slice(0, 10)),
        supa.from("patients").select("id,name,chart_no,treat_status,last_visit_at").eq("clinic_id", clinicId).eq("treat_status", "중단추정").limit(20),
        supa.from("patients").select("id", { count: "exact", head: true }).eq("clinic_id", clinicId).eq("blocked", true),
      ]);
      // 프로그램 체크포인트 계산: D+1 복약지도 / D+5 경과체크 / 종료 3일 전 재안내
      const checkpoints = (programs.data ?? []).map((pr) => {
        const d = daysBetween(pr.start_date as string, day);
        const due: string[] = [];
        if (d >= 1 && !pr.d1_sent) due.push("D+1 복약지도 미발송");
        if (d >= 5 && !pr.d5_sent) due.push("D+5 경과체크 미발송");
        if (d >= (pr.days as number) - 3 && !pr.renew_sent) due.push(`종료 3일 전(D+${(pr.days as number) - 3}) 재안내 도래`);
        return { program: pr.name, patient: (pr.patients as { name?: string } | null)?.name, day: `D+${d}`, d5_response: pr.d5_response, due };
      }).filter((c) => c.due.length > 0 || c.d5_response === "불편함");
      return JSON.stringify({
        today: day,
        today_visits: visits.data ?? [],
        crisis_patients: crisis.data ?? [],
        program_checkpoints: checkpoints,
        dropout_suspects: dropouts.data ?? [],
        blocked_count: blocked.count ?? 0,
      });
    }

    async function toolSearchPatients(q: string): Promise<string> {
      const safe = q.replace(/[,()%]/g, "").trim();
      if (!safe) return "검색어가 비어 있습니다";
      const { data, error } = await supa.from("patients").select(PATIENT_COLS)
        .eq("clinic_id", clinicId)
        .or(`name.ilike.%${safe}%,chart_no.ilike.%${safe}%`)
        .limit(15);
      if (error) return `조회 오류: ${error.message}`;
      return JSON.stringify(data ?? []);
    }

    async function toolPatient360(pid: string): Promise<string> {
      const [p, visits, programs, sends, hist] = await Promise.all([
        supa.from("patients").select(PATIENT_COLS).eq("clinic_id", clinicId).eq("id", pid).maybeSingle(),
        supa.from("visits").select("at,item,main_symptom,status").eq("patient_id", pid).order("at", { ascending: false }).limit(10),
        supa.from("programs").select("name,days,start_date,d5_response,d1_sent,d5_sent,renew_sent,outcome").eq("patient_id", pid).order("start_date", { ascending: false }).limit(5),
        supa.from("sends").select("scenario,template,channel,status,reaction,sent_at").eq("patient_id", pid).order("created_at", { ascending: false }).limit(10),
        supa.from("score_history").select("at,reason,delta,after_score,after_grp").eq("patient_id", pid).order("at", { ascending: false }).limit(10),
      ]);
      if (!p.data) return "해당 환자를 찾을 수 없습니다";
      return JSON.stringify({ patient: p.data, visits: visits.data ?? [], programs: programs.data ?? [], sends: sends.data ?? [], score_history: hist.data ?? [] });
    }

    async function runTool(name: string, input: Record<string, unknown>): Promise<string> {
      try {
        switch (name) {
          case "get_today_snapshot":
            trace.push({ actor: "AI 실장", action: "tool", detail: "오늘 현황 조회" });
            return await toolTodaySnapshot();
          case "search_patients":
            trace.push({ actor: "AI 실장", action: "tool", detail: `환자 검색: ${String(input.query ?? "")}` });
            return await toolSearchPatients(String(input.query ?? ""));
          case "get_patient_360":
            trace.push({ actor: "AI 실장", action: "tool", detail: "환자 360 조회" });
            return await toolPatient360(String(input.patient_id ?? ""));
          case "ask_specialist": {
            const key = String(input.employee ?? "") as EmployeeKey;
            if (!EMPLOYEES[key]) return "employee는 writer/compliance/analyst/briefer 중 하나여야 합니다";
            return await runSpecialist(key, String(input.task ?? ""), input.context ? String(input.context) : undefined);
          }
          default:
            return `알 수 없는 도구: ${name}`;
        }
      } catch (e) {
        return `도구 실행 오류: ${String((e as Error)?.message ?? e)}`;
      }
    }

    /* ---------- 직접 지명 모드: 전문 직원 1명에게 바로 위임 ---------- */
    if (employee !== "auto") {
      if (!EMPLOYEES[employee as EmployeeKey]) return json({ error: "employee는 auto/writer/compliance/analyst/briefer 중 하나여야 합니다" });
      let context: string | undefined;
      if (patientId) {
        trace.push({ actor: "AI 실장", action: "tool", detail: "환자 360 조회" });
        context = await toolPatient360(patientId);
      }
      const out = await runSpecialist(employee as EmployeeKey, task, context);
      return json({ ok: true, employee, result: out, trace, usage });
    }

    /* ---------- 오케스트레이션 모드: AI 실장 에이전트 루프 ---------- */
    const messages: Anthropic.MessageParam[] = [{
      role: "user",
      content: patientId ? `${task}\n\n(대상 환자 id: ${patientId} — get_patient_360으로 조회 가능)` : task,
    }];

    const call = () => anthropic.messages.create({
      model: MODEL,
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      system: ORCH_SYSTEM(clinic),
      tools: TOOLS,
      messages,
    });

    let response = await call();
    addUsage(response.usage);

    let rounds = 0;
    while (response.stop_reason === "tool_use" && rounds < MAX_ROUNDS) {
      rounds++;
      messages.push({ role: "assistant", content: response.content });
      const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      // 병렬 도구 호출은 동시에 실행하고, 결과는 한 user 메시지로 되돌린다
      const results: Anthropic.ToolResultBlockParam[] = await Promise.all(
        toolUses.map(async (tu) => ({
          type: "tool_result" as const,
          tool_use_id: tu.id,
          content: await runTool(tu.name, tu.input as Record<string, unknown>),
        })),
      );
      messages.push({ role: "user", content: results });
      response = await call();
      addUsage(response.usage);
    }

    if (response.stop_reason === "refusal") {
      return json({ error: "요청이 정책상 처리되지 않았습니다. 업무 내용을 바꿔 다시 시도해 주세요.", trace, usage });
    }
    if (response.stop_reason === "tool_use") {
      return json({ error: `작업이 너무 복잡해 ${MAX_ROUNDS}회 왕복 내에 끝나지 않았습니다. 업무를 나눠서 지시해 주세요.`, trace, usage });
    }

    const finalText = response.content.filter((b) => b.type === "text").map((b) => (b as Anthropic.TextBlock).text).join("\n");
    return json({ ok: true, employee: "auto", result: finalText, trace, usage });
  } catch (e) {
    const err = e as { status?: number; message?: string };
    if (err?.status === 401) return json({ error: "ANTHROPIC_API_KEY가 올바르지 않습니다 — Anthropic 콘솔에서 키를 다시 확인해 주세요" });
    if (err?.status === 429) return json({ error: "Anthropic API 사용량 한도에 걸렸습니다 — 잠시 후 다시 시도해 주세요" });
    return json({ error: String(err?.message ?? e) });
  }
});
