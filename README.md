# Aegis RuleSet App

룰셋 관리 데모 — **백엔드(API + DB) / 프론트엔드 분리** 구조.

```
├── backend/     Express + SQLite(better-sqlite3) REST API  (:4000)
│   └── data/
│       ├── seed.json        마이그레이션 스냅샷 (초기 데이터)
│       └── rule_mgnt.db      런타임 생성 SQLite DB (편집 영속화, gitignore)
├── frontend/    Vite + React                                 (:5173)
│   └── src/
│       ├── api.js            REST 클라이언트
│       └── RulesetConsole.jsx UI (관리 + ST 연동 · 데이터는 API 로드)
└── package.json 루트: concurrently 로 동시 실행
```

## 설치

```bash
npm install                # 루트 devDeps (concurrently)
npm run install:all        # backend + frontend 의존성 설치
```

## 실행

```bash
npm run dev                # 백엔드(:4000) + 프론트(:5173) 동시 실행
```

- 프론트: http://localhost:5173
- API:    http://localhost:4000/api/health

개별 실행: `npm run dev:backend` / `npm run dev:frontend`

## API

### ST 인터페이스 (정본 RS-1 / RS-2 / RS-3 · 표준 봉투)

| Method | Path | 설명 |
|---|---|---|
| GET | `/api/rulesets` | **RS-1 listRuleSets** — 룰셋 식별정보 목록 (옵션 `?ruleset_category=`) |
| GET | `/api/ruleset/load?product_id=` | **RS-2 loadRuleSet** — 상품 식별자로 룰셋 **본문 전체 일괄** 반환 |
| GET | `/api/health` | **RS-3 health_check** |

모든 ST 응답은 표준 봉투(`module_id`·`responded_at`·`result` / `error_category`·`error_message`)를 포함한다.

**RS-2 loadRuleSet** — ST 는 `product_id` 만 보내고, 상품 `categories` 와 일치하는 `ruleset_category` 의 **모든 룰셋(N:M)** 을 Rule 집합 + 버전으로 통째로 반환한다. 매칭(대화↔Rule)은 ST·매칭AI, 판정은 iTrix(배심원 패널) 담당.

```jsonc
// 응답
{ "module_id": "ruleset", "responded_at": "...", "result": "success",
  "product": { "product_id": "PRODisa000000001", "product_name": "ISA 중개형", "product_categories": ["ISA","공통"] },
  "ruleset_count": 2, "total_rules": 78,
  "matched_rulesets": [
    { "ruleset_identity": { "ruleset_id": "RSETisa000000001", "ruleset_name": "...", "ruleset_version": "1.0.0", "ruleset_category": "ISA" },
      "ruleset_content": { "ruleset_version": "1.0.0", "rules": [ /* Rule 항목들 (required_tags, speech_act, jury_panel_id, threshold, judge_prompt ...) */ ] } }
  ] }
```

### 관리 사용자 인터페이스

| Method | Path | 설명 |
|---|---|---|
| GET | `/api/provisions` | 조항 목록 |
| GET | `/api/rules` · `/api/rules/:id` | 룰 목록 / 단일 룰 |
| PUT | `/api/rules/:id` | 룰 수정 (required_tags, speech_act, jury_panel_id, threshold, judge_prompt 등) — 변경 이력 append |
| GET | `/api/rules/:id/history` | 룰 변경 이력 (append-only) |
| GET | `/api/products` | 상품 마스터 (카테고리 N:M) |
| GET | `/api/vocabulary` · `/api/taxonomy` | 코드값 어휘 / 태그·발화행위·배심원 패널 사전 |

### 룰 메타 구조 (원칙 1)

- **매칭 메타**: `required_tags`(태그, 복수) + `speech_act`(발화행위) — 매칭AI 표준 태그. (`keywords` 는 폴백)
- **판정 메타**: `jury_panel_id`(5배심원 패널) + `threshold`(5 중 위반 인정 수) + `judge_prompt`.

마스터/사전 데이터: `backend/data/{seed,rule_tags,rulesets,products,taxonomy}.json`.

> 태그 사전(taxonomy)은 현재 51종 placeholder이며, 실제로는 매칭AI(`matching_engine_v2`)의 **표준 82태그**로 교체해야 정합됩니다.

## 데이터 초기화

`backend/data/rule_mgnt.db` 를 삭제하면 다음 실행 시 `seed.json` 으로 다시 시딩됩니다.
