-- =============================================================
-- 케어루프 CRM — v3 병원별 커스터마이즈 (schema.sql · v2 실행 후 실행)
-- 진료과 프리셋 오버라이드(진료항목·문진 증상·프로그램) + 대표 전화
-- =============================================================

alter table clinics add column if not exists custom jsonb;   -- {items,sym,worry,programs}
alter table clinics add column if not exists phone text;     -- 대표 전화 (v1에 이미 있으면 무시됨)
