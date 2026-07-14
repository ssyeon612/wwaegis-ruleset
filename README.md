# WiseAegis · 완전판매 RuleSet 콘솔

금융소비자보호(완전판매) **룰셋을 관리·검증**하는 데모 애플리케이션.
상담 대화를 판정하는 파이프라인(STT → ST → **RuleSet** → iTrix)에서 **룰북(RuleSet) 모듈**을 담당한다.

- **백엔드** — Express + SQLite(better-sqlite3) REST API · `:4000`
- **프론트** — Vite + React · `:5173`
- **모노레포** — 루트에서 `concurrently` 로 동시 실행

```
├── backend/                Express + better-sqlite3 REST API (:4000)
│   ├── server.js           라우트 (관리 CRUD · ST 연동 · 온톨로지)
│   ├── db.js               스키마 + 시드 + 멱등 마이그레이션
│   ├── ontology.js         관계형 → 지식그래프/RDF 변환
│   └── data/
│       ├── seed.json          rules·knowledge 초기 데이터
│       ├── categories.json    카테고리(=룰셋) 마스터
│       ├── principles.json    판매원칙 마스터
│       ├── products.json      상품 마스터
│       ├── taxonomy.json      의미태그·speech_act
│       ├── rule_tags.json     룰↔태그 초기 매핑
│       └── rule_mgnt.db        런타임 SQLite (gitignore, 편집 영속화)
├── frontend/               Vite + React (:5173)
│   └── src/
│       ├── api.js             REST 클라이언트
│       └── RulesetConsole.jsx UI 전체 (데이터는 API 로드)
└── docs/                   근거자료 · 기능요구사항 · 샘플 업로드 파일
```

---

## 설치 · 실행

```bash
npm install            # 루트 devDeps (concurrently)
npm run install:all    # backend + frontend 의존성 설치
npm run dev            # 백엔드(:4000) + 프론트(:5173) 동시 실행
```

- 프론트: http://localhost:5173  · 백엔드 헬스체크: http://localhost:4000/api/health
- 개별 실행: `npm run dev:backend` / `npm run dev:frontend`
- 최초 실행 시 `backend/data/rule_mgnt.db` 가 없으면 `seed.json` 등으로 자동 시딩된다.
- 이후 서버 재기동마다 `db.js` 의 **멱등 마이그레이션**이 기존 DB에 자동 적용된다.

---

## 주요 기능 (메뉴)

| 메뉴 | 설명 |
|---|---|
| **룰북** | 룰 목록·검색·편집. **① 파일로 룰 추가**(업로드→분석→검토→적용 위저드) · **② 직접 입력**(폼) |
| **근거 조항** | 룰의 판정 근거가 되는 법령·규정·내규 원문(knowledge) CRUD |
| **의미태그** | 매칭용 표준 태그(tags) 관리 |
| **규정 관계도** | 룰·근거·태그·카테고리·상품을 타입드 지식그래프로 시각화 + RDF(Turtle/JSON-LD) 내보내기 |
| **ST ↔ RuleSet** | 상품을 선택해 `loadRuleSet`(RS-2)을 호출, 해당 상품에 적용되는 룰셋 본문·판정 페이로드 확인 |

### 파일로 룰 추가 (4단계)
1. **업로드** — 마크다운(.md)·텍스트(.txt)
2. **분석** — 파일을 파싱해 현재 DB 구조에 맞춘 **룰 후보** 생성 *(현재는 규칙기반 목업 — `analyzeRules` 함수만 교체하면 AI 엔진 연동 가능)*
3. **검토** — 후보를 카드로 표시, 룰마다 점검문·카테고리·원칙·조건·위반유형·태그·근거를 **수정·삭제·추가**
4. **적용** — 검토 완료분만 룰로 반영
> 입력 형식·샘플은 [`docs/샘플_룰업로드/`](docs/샘플_룰업로드/) 참고.

---

## 데이터 모델

정규화된 **9개 테이블**. 마스터 3종(categories·tags·principles)은 `짧은 code(PK) + 표시명(label)` 패턴이며, **DB엔 code 저장 / API·화면엔 label** 로 노출한다.

```
                    ┌─────────────┐        ┌──────────────┐
    products ──FK──▶│ categories  │◀──FK── │    rules     │──FK──▶ principles
 (상품→카테고리)     │ (=룰셋)      │        │ (룰=점검항목) │      (판매원칙 마스터)
                    └─────────────┘        └──────────────┘
                                            │           │
                                    (N:M) rule_tags   rule_knowledge (N:M)
                                            │           │
                                          tags       knowledge
                                       (의미태그)     (근거 조항 원문)
```

| 테이블 | 핵심 컬럼 | 설명 |
|---|---|---|
| **rules** | `rule_id`, `statement`, `category`(FK), `sales_principle`(FK), `customer_condition`, `violation_type` | 룰(점검 항목). `statement`=점검 문장 |
| **knowledge** | `knowledge_id`, `document_type`, `title`, `content` | 근거 조항 원문(법령·규정·내규) |
| **rule_tags** | `rule_id`(FK), `tag_code`(FK) | 룰 ↔ 의미태그 (N:M) |
| **rule_knowledge** | `rule_id`(FK), `knowledge_id`(FK) | 룰 ↔ 근거 조항 (N:M, 하나의 근거를 여러 룰이 공유) |
| **categories** | `category`(PK), `label` | 카테고리 마스터 = **룰셋 단위** (common·isa·irp) |
| **tags** | `tag_code`(PK), `label` | 의미태그 마스터 |
| **principles** | `code`(PK), `label`, `article` | 판매원칙 마스터 (금소법 6대 원칙 + 절차/사후) |
| **products** | `product_id`, `product_name`, `product_category`(FK) | 상품 마스터 (상품은 단일 카테고리 보유) |

### 핵심 개념
- **룰셋 = 카테고리.** 룰셋은 상품이 아닌 **카테고리 단위**로 정의된다. 룰은 `rules.category` 로 소속 카테고리를 가진다.
- **분류 축.** 룰은 `판매원칙(sales_principle)` · `고객조건(customer_condition: 모든 고객/고령자/초고령자)` · `위반유형(violation_type: 누락형/감점형/비계량형)` · `의미태그(rule_tags)` 로 분류된다.
- **매칭 vs 판정.** 대화↔룰 매칭은 `의미태그`, 위반 판정은 iTrix가 `judge_payload`(점검문 + 근거 원문)로 수행한다.

---

## RS-2 · loadRuleSet (ST ↔ RuleSet)

ST가 `product_id`(+선택적 매칭 태그)를 넘기면, RuleSet이 **상품 → 카테고리 → 룰**로 변환해 반환한다.

```
GET /api/ruleset/load?product_id=PROD_001[&tags=CUST_TYPE,...]

product_id → product_category → 적용 룰 = (공통 common 룰) + (해당 카테고리 룰)
          → 각 룰의 판정 페이로드(judge_payload = [체크] statement / [근거] 조항)
```

- 응답의 `ruleset_identity` 는 **상품 정보 없이** 카테고리 기준으로 식별된다.
- 태그를 함께 넘기면 해당 태그를 요구하는 룰만 필터링한다.

---

## API 요약

| 메서드·경로 | 용도 |
|---|---|
| `GET/POST /api/knowledge`, `PUT/DELETE /api/knowledge/:id` | 근거 조항 CRUD (사용 중이면 삭제 차단) |
| `GET /api/rules`, `GET /api/rules/:id` | 룰 조회 (태그·근거는 배열로 파생) |
| `POST/PUT/DELETE /api/rules/:id` | 룰 생성·수정·삭제 |
| `POST /api/rules/import` | 룰 일괄 임포트 (파일 업로드 위저드) |
| `GET /api/taxonomy`, `POST/PUT/DELETE /api/taxonomy/tags[/:code]` | 의미태그 마스터 CRUD |
| `GET /api/categories` · `GET /api/principles` · `GET /api/products` | 마스터 조회 |
| `GET /api/rulesets` (RS-1) · `POST /api/rulesets` | 룰셋(=카테고리) 목록·등록 |
| `GET /api/ruleset/load` (RS-2) | 상품별 룰셋 본문 로드 |
| `GET /api/ontology/graph` · `GET /api/ontology/export?format=turtle\|jsonld` | 지식그래프·RDF |
| `GET /api/health` | 헬스체크 |

> API는 내부 정규화와 무관하게 **일관된 형태**를 유지한다 — 룰의 `semantic_tags`·`knowledge_ids` 는 조인에서 배열로, `sales_principle` 은 code→label 로 파생 노출된다. (쓰기 시 label·code 모두 허용)

---

## 데이터 · 마이그레이션

- **시드 소스**: `backend/data/*.json` (룰·근거·카테고리·원칙·상품·태그). DB가 비어 있을 때 1회 시딩.
- **런타임 DB**: `backend/data/rule_mgnt.db` (gitignore) — UI 편집이 여기에 영속화된다. 삭제하면 다음 실행 시 재시딩된다.
- **마이그레이션**: `db.js` 가 서버 시작 시 스키마 차이를 감지해 **멱등**하게 보강(컬럼 rename·조인 테이블 이관·FK 재작성 등). 배포 서버는 **재기동만으로** 최신 스키마로 정렬된다.

---

## 배포

- `Dockerfile` / `render.yaml` 포함. 루트 `npm run serve` = 프론트 빌드 후 백엔드 실행.
- 사내 서버 배포 시: 레포 `git pull` → (프론트 변경 시) `frontend` 빌드 → 백엔드 서비스 재기동(마이그레이션 자동 적용).

## 문서 (`docs/`)
- `근거자료/` — 판정기준 근거(법령·감독규정·가이드라인·분쟁조정/제재/판례) 정리
- `기능요구사항/` — STT·InterLock·RuleSet·ST·Audit·iTrix 등 모듈별 요구정의
- `샘플_룰업로드/` — 파일 룰 추가 테스트용 샘플(.md/.txt) + 형식 설명
