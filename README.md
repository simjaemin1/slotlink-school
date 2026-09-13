# Slotlink — 운정고 설명회 신청 시스템

800명 정원의 학교 설명회를 위한 선착순 신청 시스템입니다. 오픈 45초 만에 마감되는 환경에서 정원을 초과하지 않고 신청 번호를 정확히 발급하는 것을 목표로 설계했습니다.

운영 URL: [form-a1f4b.web.app](https://form-a1f4b.web.app) (운영 종료 · 2025-08)

## 문제

구글 폼으로는 정원 초과를 차단할 수 없습니다. 응답을 순차적으로 수집할 뿐이므로, 800석에 응답이 900건 접수되어도 아무 조치가 이루어지지 않고 마감 처리는 운영자가 사후에 수작업으로 해야 합니다. 신청자 입장에서도 본인의 순번이나 잔여 좌석을 확인할 수 없습니다.

선착순 신청의 핵심 난점은 폼이 아니라 동시 쓰기 경합에서의 정합성입니다. 수백 명이 동일한 시점에 제출 버튼을 누르면 단순한 read-modify-write는 무너집니다.

```
A: count 읽음 (799) ──┐
B: count 읽음 (799) ──┤  둘 다 "799 < 800" 이라 판단
A: count = 800 씀   ──┤
B: count = 800 씀   ──┘  → 실제 신청자는 801명
```

## 운영 결과

- 정원 정확 마감 (800/800)
- 모든 등록이 1차 시도에 성공 (`attempts: 1`)
- 마감 후 신청 문서를 직접 대조하여 카운터와 실제 인원이 일치함을 확인

## 기술 스택

Firebase Cloud Functions v2 (asia-northeast3) · Firestore · React 19 · Vite 6 · Tailwind CSS 3

## 핵심 설계

### 트랜잭션 기반 정합성

여석 확인, 카운터 증가, 등록 문서 생성, 번호 발급을 단일 Firestore 트랜잭션으로 원자화했습니다. Firestore 트랜잭션은 낙관적 동시성 제어를 채택하고 있어, 읽은 문서를 다른 트랜잭션이 먼저 커밋하면 `ABORTED`로 실패합니다. 읽은 시점의 count가 커밋 시점까지 유효했음을 데이터베이스가 보장해 주는 구조입니다. 정원 초과와 번호 중복 발급이 구조적으로 차단됩니다.

모든 쓰기는 Callable Function을 경유합니다. 클라이언트는 Firestore에 직접 쓰지 않습니다.

### 외부 재시도와 지수 백오프

낙관락이 폭주 환경에서 충돌할 가능성에 대비하여 SDK 내부 재시도 외에 외부 재시도 루프를 추가했습니다. 최대 5회, 500ms~5s 백오프, 0~1s 지터입니다.

지터가 중요했습니다. 즉시 재시도할 경우 충돌한 요청들이 동일한 시점에 재차 집중되어 경합이 반복되므로, 재시도 시점을 무작위로 분산시켰습니다.

재시도 가능 에러(`ABORTED`, `DEADLINE_EXCEEDED`, `UNAVAILABLE`)와 비즈니스 로직 에러(`HttpsError`)를 분리하여, 정원 초과와 같이 반복해도 결과가 동일한 영구 실패는 즉시 종료합니다.

### 중복 신청 차단

등록 문서의 ID를 연락처(`010-XXXX-XXXX`)로 사용합니다. 동일인의 중복 제출은 애플리케이션 검증 이전에 같은 문서를 대상으로 하게 되므로 트랜잭션이 직렬화해 줍니다. 버튼을 연타하더라도 좌석이 두 번 이상 배정되지 않으며, 중복 검증 또한 O(1) lookup으로 종료됩니다.

### 적응형 폴링

서버만 방어해서는 부하 자체가 경감되지 않으므로, 잔여 좌석 수에 따라 프론트엔드 폴링 주기를 차등 적용했습니다.

| 잔여 | 주기 |
|---|---|
| 200명 초과 | 20s |
| 200명 이하 | 8s |
| 50명 이하 | 3s |
| 오픈 전 | 30s |
| 오프라인 | 60s |

마감 임박 구간에서만 갱신 빈도를 높여 평시 비용을 절감했습니다. 여기에 제출 쿨다운(3s)과 최소 제출 간격(2s) 이중 가드, 탭이 백그라운드일 때의 폴링 중단, 온라인 복귀 시 즉시 재조회를 추가했습니다.

## 데이터 모델

| 컬렉션 | 용도 | 키 |
|---|---|---|
| `registrations` | 신청자 데이터 | 전화번호 (PK) |
| `counters` | 정원 카운터 (단일 문서) | `registrationTotal` |
| `registrationLogs` | 액션 로그 | auto-id |

```
registrations/{contact}
  name, school, contact, people,
  startNumber, endNumber, registrationId,
  status, timestamp, attempts

counters/registrationTotal        ← 모든 경합이 집중되는 단일 문서
  count, lastUpdated
```

`registrationLogs`에는 신청 성공, 실패, 조회 액션이 기록됩니다. 응답을 반환하기 이전에 `await`로 기록하여 유실을 방지합니다. Cloud Functions v2는 응답 후 인스턴스를 freeze할 수 있어, 반환 이후로 지연시킨 비동기 작업은 실행이 보장되지 않기 때문입니다.

## API (Callable Functions)

| 함수 | 용도 |
|---|---|
| `registerWithLimit` | 신청 — 핵심 트랜잭션 |
| `getRegistrationStatus` | 현재 인원 · 잔여석 · 오픈 여부 · 서버 시각 |
| `checkRegistration` | 연락처로 본인 신청 내역 조회 |

시간 판정은 항상 서버 기준이며, 응답에 `serverTime`을 함께 전달하여 단말 시계가 부정확해도 카운트다운이 어긋나지 않도록 했습니다.

## 프로젝트 구조

```
explanation-form/
├── src/
│   ├── components/RegistrationForm.jsx   신청 폼 · 폴링 · 카운트다운 · 신청 조회
│   ├── lib/firebaseConfig.js             Firebase 클라이언트 초기화
│   ├── App.jsx
│   └── main.jsx
├── functions/
│   └── index.js                          Callable 3종 · 검증 · 재시도 정책 · 로깅
└── firebase.json                          Hosting(SPA) + Functions 설정
```

## 로컬 실행

```bash
npm install
npm run dev          # Vite 개발 서버

cd functions
npm install
npm run serve        # Functions 에뮬레이터
```

## 배포

```bash
npm run build                        # dist/ 생성 (호스팅 배포 전 필수)
firebase deploy --only hosting
firebase deploy --only functions
```

`firebase.json`의 predeploy는 lint만 실행합니다. 프론트엔드 빌드는 자동화되어 있지 않으므로 `npm run build`를 선행해야 합니다.

정원(`LIMIT`)과 오픈 시각(`OPEN_TIME`)은 `functions/index.js` 상단에 상수로 선언되어 있습니다. 1인당 최대 신청 인원은 2명입니다.

## 아쉬운 점

- 정합성 확인을 수작업으로 수행했습니다. 마감 후 신청 문서를 직접 집계하여 카운터와 대조했으나 스크립트로 자동화하지는 않았습니다. 합계 대조와 번호 구간의 중복·공백 검사를 주기적으로 수행했다면 행사 중에도 이상을 즉시 인지할 수 있었으리라 생각합니다. 다만 자동으로 카운터를 보정하는 방식은 트랜잭션 외부에서 쓰는 순간 동시 증가분을 덮어쓸 수 있어 적절하지 않으며, 탐지와 통보에서 멈춰야 한다고 판단합니다.
- `registrationLogs`를 조회할 수단이 없습니다. 신청, 실패, 조회 기록은 남지만 조회 API도 관리자 화면도 없어, 분쟁 대응에 실제로 활용하려면 조회 기능과 보관 기간 정책이 필요합니다.
- 자동화된 테스트가 없습니다. 특히 동시성 시나리오는 Emulator 기반 통합 테스트와 부하 테스트로 회귀를 방지해야 할 영역입니다.
