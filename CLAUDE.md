# CLAUDE.md — MedStudy AI

## 프로젝트 개요
의과대학생용 개인 AI 학습 앱. 플래시카드 SRS, 퀴즈, 개념 허브, 기출 분석, 시험 플래너 등을 제공한다.
**평가 기준**: 시험 점수 향상 — 모든 기능 결정은 이 기준으로 판단.

## 기술 스택
- **Frontend**: React + Vite (JSX), 단일 파일 중심 (`src/MedStudyApp.jsx` — 5200줄)
- **Backend**: Supabase (`app_storage` 테이블 namespace/key/value JSONB)
- **이미지 저장**: Supabase Storage (`card-images` 버킷)
- **배포**: Vercel (정적 + Python 서버리스)
- **AI**: Gemini (PDF 파싱/개념추출), Claude (아키텍처/프롬프트)

## 파일 구조
```
medstudy/
├── src/
│   └── MedStudyApp.jsx          ← 메인 앱 (모든 페이지/컴포넌트)
├── lib/
│   └── storage.js               ← Supabase 래퍼 (sGet, sSet, sDeleteMany)
├── api/
│   └── process-pdf.py           ← Python 서버리스 (PyMuPDF + Gemini)
├── card-injector.jsx            ← 데이터 주입 도구 (통합 예정)
├── supabase/                    ← Supabase 설정
├── index.html
├── package.json
├── vercel.json
├── vite.config.js
└── requirements.txt             ← Python 의존성 (PyMuPDF 등)
```

## 하드 제약 (절대 위반 금지)
1. **npm 설치 불가**: Codex 환경에서 registry 403. 기존 의존성만 사용할 것.
   - 과거 실패: D3 → 순수 React/SVG로 대체, pdfjs-dist → PyMuPDF로 대체
2. **환경변수 구분**: `VITE_SUPABASE_URL` (클라이언트) ≠ `SUPABASE_URL` (서버리스)
3. **수술적 편집**: str_replace 기반 정밀 수정. 전체 파일 재작성 금지 (회귀 위험).
4. **UI 언어**: 한국어. 코드/변수명은 영어.

## Supabase 스키마

### app_storage 테이블
```sql
CREATE TABLE app_storage (
  id SERIAL PRIMARY KEY,
  namespace TEXT NOT NULL,     -- 항상 'medstudy'
  key TEXT NOT NULL,           -- SK 상수 참조
  value JSONB NOT NULL,
  UNIQUE(namespace, key)
);
```

### Storage Key (SK) 상수
```js
const SK = {
  cards: "medstudy:cards",
  questions: "medstudy:questions",
  professors: "medstudy:professors",
  srs: "medstudy:srs",
  reviewLog: "medstudy:review-log",
  quizHistory: "medstudy:quiz-history",
  exams: "medstudy:exams",
  concepts: "medstudy:concepts",
  sources: "medstudy:sources",
  confusionClusters: "medstudy:confusion-clusters",
};
```

### 이미지 Storage 경로
```
card-images/{subject}/{exam_unit}/{source_type}/{source_detail}/images/{image_ref}.png
image_ref 예: p003_i01 → 3페이지 첫 번째 이미지
```

## 주요 데이터 구조

### 카드 (Flashcard)
```
id, front, back, subject, chapter, exam_unit, source_type, source_detail,
image_ref, image_url, image_present, primary_concept_id, linkedConceptIds,
tier (active/passive/dormant/search-only), occurrence_key, source_signature,
ingestion_batch_id, confirmed_source, status
```

### 문제 (Question)
```
id, question (raw_question), options [{text, correct}], canonicalAnswer,
type (objective/subjective), subject, exam_unit, question_intent (7종),
question_family_id, image_ref, image_url, image_present,
source_signature, ingestion_batch_id, confidence (HIGH/MEDIUM/NONE)
```

### 7가지 정규 question_intent
```
definition, mechanism, symptom_or_result, comparison,
location_or_structure, sequence_or_step, identification
```

## 앱 모듈 맵 (MedStudyApp.jsx 내부)

| 모듈 | 기능 |
|------|------|
| Flashcard SRS | 간격반복 학습, 잊었어요/기억해요 |
| Quiz Engine | 3모드 퀴즈, 범위 필터링 |
| Concept Hub | 개념 연결, SVG 마인드맵 |
| Exam Planner | D-day 역산, scope 필터 (direct/foundation) |
| Compression Review | 압축 복습 |
| Decision Training | 혼동 클러스터 감별 훈련 |
| Stats Dashboard | 학습 통계 |
| ManagePage | 이미지 수리, 데이터 초기화, 카드/문제 주입, JSON 벌크 |
| CardImage | 이미지 표시 컴포넌트 (fallback 포함) |

## PDF 처리 파이프라인 (/api/process-pdf.py)
1. PyMuPDF로 PDF 페이지 렌더링
2. Gemini에 이미지로 전송 (3-phase 프롬프트)
   - Phase 1: 문서 구조 파악
   - Phase 2: 공유 리소스 수집
   - Phase 3: 문제별 추출 (JSON 배열)
3. maxOutputTokens: 65536
4. 교수 자동 감지 (별도 Gemini 호출)
5. 개념 자동 추출 (ingestion 후 최대 30개)

## 테마/디자인 토큰
- 다크 테마: amber gold `#a07850` 악센트, cream `#f8f3ea` 플래시카드
- 폰트: `Gowun Batang`, `Playfair Display`, `Noto Sans KR`
- THEMES 객체에 light/dark 정의됨

## 로컬 개발
```bash
npm install
cp .env.example .env
# .env에 VITE_SUPABASE_URL, VITE_SUPABASE_KEY 입력
npm run dev
```

서버리스 함수 테스트:
```bash
vercel dev
```

## 빌드 & 배포
```bash
npm run build        # Vite 빌드
vercel --prod        # 프로덕션 배포 (또는 git push → 자동 배포)
```

## 코드 스타일
- 함수 컴포넌트 + hooks
- uid() 함수로 ID 생성 (Date.now base36 + random)
- sGet/sSet으로 Supabase 읽기/쓰기 (lib/storage.js)
- 에러 시 showToast(message, "error") 사용
- 스타일: 인라인 스타일 객체 (S, C, T 토큰 사용)

## 현재 상태
- 앱 배포 완료, 기능적으로 동작 중
- 7개 미해결 이미지 매핑 (ImageRepairPanel로 처리 가능)
- CardInjectorApp의 ManagePage 통합 보류 중
- 프리프로덕션 데이터 리셋 대기 중
