-- =============================================================
-- 케어루프 CRM — v2 인증·멀티테넌트 (schema.sql 실행 후 실행)
-- 로그인(Supabase Auth) + 병원별 데이터 격리(RLS)
-- =============================================================

-- 병원 소유자
alter table clinics add column if not exists owner_id uuid references auth.users(id);

-- 병원 구성원 (역할: owner=원장 전체권한 / desk=데스크 실무화면)
create table if not exists clinic_members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  clinic_id uuid not null references clinics(id) on delete cascade,
  role text not null default 'owner' check (role in ('owner','desk')),
  created_at timestamptz not null default now()
);
alter table clinic_members enable row level security;

-- 헬퍼 (security definer — RLS 재귀 없이 내 소속/역할 조회)
create or replace function my_clinic() returns uuid
language sql stable security definer set search_path = public as
$$ select clinic_id from clinic_members where user_id = auth.uid() $$;

create or replace function my_role() returns text
language sql stable security definer set search_path = public as
$$ select role from clinic_members where user_id = auth.uid() $$;

-- ===== 데모 전체허용 정책 제거 =====
drop policy if exists demo_all_clinics  on clinics;
drop policy if exists demo_all_patients on patients;
drop policy if exists demo_all_visits   on visits;
drop policy if exists demo_all_programs on programs;
drop policy if exists demo_all_sends    on sends;
drop policy if exists demo_all_history  on score_history;

-- ===== 병원별 격리 정책 =====
create policy member_select_clinics on clinics for select using (id = my_clinic());
create policy owner_update_clinics  on clinics for update using (id = my_clinic() and my_role() = 'owner');

create policy member_all_patients on patients for all
  using (clinic_id = my_clinic()) with check (clinic_id = my_clinic());
create policy member_all_visits on visits for all
  using (clinic_id = my_clinic()) with check (clinic_id = my_clinic());
create policy member_all_programs on programs for all
  using (clinic_id = my_clinic()) with check (clinic_id = my_clinic());
create policy member_all_sends on sends for all
  using (clinic_id = my_clinic()) with check (clinic_id = my_clinic());
create policy member_all_history on score_history for all
  using (clinic_id = my_clinic()) with check (clinic_id = my_clinic());

create policy self_select_members on clinic_members for select using (user_id = auth.uid());
create policy owner_insert_members on clinic_members for insert
  with check (my_role() = 'owner' and clinic_id = my_clinic());
create policy owner_delete_members on clinic_members for delete
  using (my_role() = 'owner' and clinic_id = my_clinic() and user_id <> auth.uid());

-- ===== 가입 직후 병원 생성 RPC (본인을 owner로 등록) =====
create or replace function create_clinic(p_name text, p_spec text, p_doctor text, p_color int)
returns uuid language plpgsql security definer set search_path = public as $$
declare cid uuid;
begin
  if auth.uid() is null then raise exception '로그인이 필요합니다'; end if;
  if exists (select 1 from clinic_members where user_id = auth.uid()) then
    raise exception '이미 병원에 소속된 계정입니다';
  end if;
  insert into clinics (name, spec, doctor, brand_color, owner_id)
    values (p_name, p_spec, p_doctor, coalesce(p_color, 0), auth.uid())
    returning id into cid;
  insert into clinic_members (user_id, clinic_id, role) values (auth.uid(), cid, 'owner');
  return cid;
end $$;
grant execute on function create_clinic(text, text, text, int) to authenticated;

-- 직원(데스크) 추가: 직원이 먼저 회원가입 → 원장이 SQL Editor에서 1줄 실행
--   insert into clinic_members (user_id, clinic_id, role)
--   values ('<직원 user_id — Auth > Users에서 복사>', my_clinic(), 'desk');
-- (이메일 초대 UI는 추후 단계)
