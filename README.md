# MedStudy (React + Vite + Supabase)

Claude Artifact 기반 코드를 실제 웹앱 구조로 옮긴 버전입니다.

## Tech Stack
- React + Vite
- Supabase JS SDK (`@supabase/supabase-js`)
- Vercel 배포 설정 포함

## 로컬 실행
```bash
npm install
cp .env.example .env
# .env에 VITE_SUPABASE_URL / VITE_SUPABASE_KEY 입력
npm run dev
```

## 환경변수
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_KEY`

## Supabase 스키마 (초안)
`supabase/schema.sql`을 실행하면 `app_storage` key-value 테이블이 생성됩니다.

이 프로젝트는 기존 `window.storage`를 다음으로 치환했습니다.
- `sGet(key)` → Supabase `select`
- `sSet(key, value)` → Supabase `upsert`
- `sDeleteMany(keys)` → Supabase `delete ... in (...)`

## Vercel 배포
- `vercel.json` 포함
- Vercel 프로젝트 환경변수에 아래 2개를 설정하세요.
  - `VITE_SUPABASE_URL`
  - `VITE_SUPABASE_KEY`
- Build Command: `npm run build`
- Output Directory: `dist`
