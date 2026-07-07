# 케어루프 CRM — Supabase 실데이터 연동 가이드

프로토타입(`crm-dashboard.html`)을 목데이터가 아닌 실제 DB로 구동하는 절차입니다. 10분이면 됩니다.

## 1. Supabase 프로젝트 준비
- [supabase.com](https://supabase.com) → New Project (무료 플랜으로 충분)
- 기존 토큰게임 프로젝트를 재사용해도 됩니다 — 테이블 이름이 겹치지 않습니다.

## 2. 스키마 · 데모 데이터 생성
1. Supabase Dashboard → **SQL Editor** → New query
2. `db/schema.sql` 내용 전체 붙여넣기 → **Run** (테이블 6개 + 인덱스 + RLS 생성)
3. 같은 방법으로 `db/seed.sql` 실행 (데모 병원 1곳 + 환자 11명 + 오늘 내원/발송 기록)

## 3. 접속 정보 확인
- Dashboard → **Settings → API**
  - `Project URL` (예: `https://xxxx.supabase.co`)
  - `anon public` 키

## 4. 케어루프에 연결
1. `crm-dashboard.html`을 브라우저에서 열기 (⚠ 아티팩트 미리보기가 아닌 **파일 직접 열기 또는 GitHub Pages** — 아티팩트는 보안 정책상 외부 접속이 차단되어 항상 목데이터 모드입니다)
2. **병원관리 → 환경설정 → 데이터 연동** 카드에 URL과 anon 키 입력 → **[연결 테스트]**
3. 성공하면 상단 태그가 `DEMO · 가상 데이터` → `LIVE · 실데이터`로 바뀌고, 환자DB·내원목록·발송내역이 DB에서 로드됩니다. (대시보드 집계 차트는 이번 단계에서는 목데이터 유지 — 다음 단계에서 집계 쿼리 연결)
4. 실패하면 상단에 오류 배너가 뜨고 자동으로 목데이터로 돌아갑니다.

## 5. ⚠ 보안 주의 (실환자 데이터 전)
- `schema.sql`의 RLS 정책은 **데모용(전체 허용)** 입니다. 데모 seed 데이터까지만 이 상태로 쓰세요.
- 실제 환자 정보를 넣기 전에 반드시: ① 데모 정책 삭제 ② Supabase Auth 로그인 도입 ③ `clinic_id` 필터 + 역할별(원장/데스크) 정책으로 교체. (기획서 8장·10.6 데이터 정책 참고)

## 6. 다음 단계
- Make.com 시나리오가 같은 테이블에 기록하도록 연결 (문진 웹훅 → `patients`, 수납 완료 → `visits`, 발송 → `sends`)
- 대시보드 집계(KPI·채널 분석)를 Supabase 뷰/RPC로 전환
- 오늘의 액션 큐를 데이터 파생으로 전환 (현재는 데모 시나리오)
