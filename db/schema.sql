-- =============================================================
-- 케어루프 CRM — Supabase(PostgreSQL) 스키마 v1.0
-- 기획서 v3.0 데이터 모델(6장) 기반 · 멀티테넌트(clinic_id)
-- 실행: Supabase Dashboard → SQL Editor → 전체 붙여넣기 → Run
-- =============================================================

-- 병원 (테넌트)
create table if not exists clinics (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  spec text not null,                          -- 한의원/재활의학과/정형외과/치과/피부과/성형외과/일반의원
  doctor text not null,                        -- 대표 원장명 (메시지 변수)
  brand_color int not null default 0,
  phone text,
  created_at timestamptz not null default now()
);

-- 환자 마스터 (기획서 DB1)
create table if not exists patients (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  chart_no text not null,
  name text not null,
  phone text,
  phone_norm text,                             -- 숫자만 — 웹훅 매칭용 보조 키
  send_token text unique default encode(gen_random_bytes(9),'hex'),  -- 클릭 추적 난수 토큰
  -- 관여도 (Make가 계산·기록 — Formula 금지 원칙)
  grp text not null default '중' check (grp in ('상','중','하')),
  grp_override text check (grp_override in ('상','중','하')),        -- 원장 수동지정(null=자동)
  score int not null default 0,
  pot int not null default 0,                  -- 잠재성(문진표)
  act int not null default 0,                  -- 활성도(최근 90일 — 배치가 재계산)
  -- 상태 (점수와 분리된 독립 필드들)
  consent boolean not null default false,      -- 마케팅 수신동의
  consent_at timestamptz,
  blocked boolean not null default false,      -- 발송중단(법적 차단 — 점수로 절대 풀리지 않음)
  blocked_reason text,
  blocked_at timestamptz,
  crisis text not null default '정상' check (crisis in ('정상','위기','대응중','회복','이탈')),
  crisis_at timestamptz,
  treat_status text not null default '치료중' check (treat_status in ('치료중','중단추정','완료','이탈')),
  unsendable text,                             -- 발송부적합: 사망/장기부재/가족공유폰 (null=해당없음)
  -- 유입 채널 (대시보드 채널 분석의 원천)
  channel text default '기타',                 -- 네이버 검색/카카오톡 채널/유튜브/인스타그램/지인 소개/재방문/기타
  referrer_id uuid references patients(id),    -- 소개자 (self-relation)
  -- 마이그레이션 (기존 환자)
  patient_type text not null default '신규' check (patient_type in ('신규','기존')),
  carried_visits int not null default 0,       -- 이월 방문횟수
  visit_count int not null default 0,          -- = 이월 + '완료' 레코드 수 (Make/앱이 갱신)
  last_visit_at date,
  next_send_at timestamptz,                    -- 다음 예정 액션 (환자 360)
  next_send_label text,
  symptoms jsonb not null default '[]',        -- 다른/걱정/가족 증상 — 콘텐츠 태그 코드로 저장(최소수집)
  created_at timestamptz not null default now(),
  unique (clinic_id, chart_no)
);

-- 진료 기록 (DB2 — 자동화의 주 트리거)
create table if not exists visits (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  patient_id uuid not null references patients(id) on delete cascade,
  at timestamptz not null,
  item text not null,                          -- 진료항목 (프리셋)
  main_symptom text,                           -- 주증상 태그 (환자 마스터가 아닌 방문에 저장)
  status text not null default '예약' check (status in ('예약','완료','노쇼')),
  staff text,
  created_at timestamptz not null default now()
);

-- 처방/프로그램 (DB3)
create table if not exists programs (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  patient_id uuid not null references patients(id) on delete cascade,
  name text not null,                          -- 예: 15일 집중
  days int not null,                           -- 처방일수(숫자 참조 — 명칭 변경에 견고)
  start_date date not null,
  d5_response text check (d5_response in ('좋음','보통','불편함')),
  d1_sent boolean not null default false,      -- 단계별 발송 완료
  d5_sent boolean not null default false,
  renew_sent boolean not null default false,   -- 재안내(= 시작일+days-3)
  outcome text check (outcome in ('재시작','미전환')),
  created_at timestamptz not null default now()
);

-- 발송 로그 (DB4 — 성과 집계 + 중복 방지의 원천)
create table if not exists sends (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  patient_id uuid not null references patients(id) on delete cascade,
  scenario text not null,                      -- 01~12
  template text not null,                      -- 템플릿 코드/이름
  content_tag text,
  channel text not null check (channel in ('알림톡','친구톡','LMS')),
  status text not null default '예약' check (status in ('예약','성공','실패','차단')),
  message_id text,                             -- 솔라피 메시지ID
  reaction text,                               -- 클릭/긍정버튼/응답-좋음/응답-보통/응답-불편함
  reacted_at timestamptz,
  score_delta int not null default 0,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  unique (patient_id, scenario, content_tag)   -- 멱등키 — 중복 발송 방지
);

-- 관여도 이력 (DB5 — 승격/강등 흐름·점수 추이)
create table if not exists score_history (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  patient_id uuid not null references patients(id) on delete cascade,
  at timestamptz not null default now(),
  reason text not null,                        -- 문진/클릭/버튼/방문/결제/감쇠/수동
  delta int not null,
  after_score int not null,
  after_grp text not null
);

-- 인덱스
create index if not exists idx_patients_clinic on patients(clinic_id);
create index if not exists idx_patients_phone on patients(clinic_id, phone_norm);
create index if not exists idx_visits_day on visits(clinic_id, at);
create index if not exists idx_programs_start on programs(clinic_id, start_date);
create index if not exists idx_sends_patient on sends(patient_id, sent_at);
create index if not exists idx_history_patient on score_history(patient_id, at);

-- =============================================================
-- RLS (Row Level Security)
-- ⚠ 데모/개발 단계: anon 전체 접근 허용 정책 (아래).
-- ⚠ 실환자 데이터 투입 전 반드시 인증 기반 정책으로 교체할 것:
--    clinic_id = auth.jwt()->>'clinic_id' 필터 + 역할별(원장/데스크) 권한.
-- =============================================================
alter table clinics enable row level security;
alter table patients enable row level security;
alter table visits enable row level security;
alter table programs enable row level security;
alter table sends enable row level security;
alter table score_history enable row level security;

-- 데모용 정책 (실서비스 전 삭제·교체)
create policy demo_all_clinics  on clinics  for all using (true) with check (true);
create policy demo_all_patients on patients for all using (true) with check (true);
create policy demo_all_visits   on visits   for all using (true) with check (true);
create policy demo_all_programs on programs for all using (true) with check (true);
create policy demo_all_sends    on sends    for all using (true) with check (true);
create policy demo_all_history  on score_history for all using (true) with check (true);
