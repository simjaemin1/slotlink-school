# Slotlink — 운정고 설명회 신청 시스템

800명 정원의 학교 설명회를 위한 선착순 신청 시스템. 오픈 45초 만에 마감되는 폭주 트래픽 환경에서 **정원을 단 한 명도 초과하지 않고 신청 번호를 정확히 발급하는 것**을 목표로 설계했습니다.

**운영 URL**: [form-a1f4b.web.app](https://form-a1f4b.web.app)

## 문제

구글 폼으로는 정원 초과를 막을 수 없습니다. 응답을 순서대로 받아 적을 뿐이라, 800석에 응답이 900개 들어와도 아무 일도 일어나지 않고 마감 처리는 사람이 뒤늦게 손으로 해야 합니다. 신청자 입장에서도 자기가 몇 번째인지, 자리가 남았는지 알 수 없습니다.

선착순 신청의 본질은 폼이 아니라 **동시 쓰기 경합에서의 정합성**입니다. 수백 명이 같은 초에 제출 버튼을 누르는 순간, 순진한 read-modify-write는 반드시 깨집니다.

```
A: count 읽음 (799) ──┐
B: count 읽음 (799) ──┤  둘 다 "799 < 800" 이라 판단
A: count = 800 씀   ──┤
B: count = 800 씀   ──┘  → 실제 신청자는 801명
```

## 운영 결과

- 정원 정확 마감 (800/800)
- 모든 등록 1차 시도 성공 (`attempts: 1`)
- 카운터-실데이터 정합성 100%

## 기술 스택

Firebase Cloud Functions v2 (asia-northeast3) · Firestore · React 19 · Vite 6 · Tailwind CSS 3

## 핵심 설계

### 트랜잭션 기반 정합성

여석 확인, 카운터 증가, 등록 문서 생성, 번호 발급을 **단일 Firestore 트랜잭션**으로 원자화했습니다. Firestore 트랜잭션은 낙관적 동시성 제어를 쓰기 때문에, 읽은 문서를 다른 트랜잭션이 먼저 커밋하면 `ABORTED`로 실패합니다. 즉 "읽은 시점의 count가 커밋 시점까지 유효했음"을 DB가 보장해 줍니다. 정원 초과와 번호 중복 발급이 시스템적으로 차단됩니다.

모든 쓰기는 Callable Function을 통과합니다. 클라이언트는 Firestore에 직접 쓰지 않습니다.

### 외부 재시도 + 지수 백오프

낙관락이 폭주 환경에서 충돌할 가능성에 대비해 SDK 내부 재시도 외에 외부 재시도 루프를 추가했습니다. 최대 5회, 500ms~5s 백오프, 0~1s 지터.

지터가 핵심입니다. 재시도를 즉시 하면 충돌한 요청들이 같은 타이밍에 다시 몰려 경합이 되풀이되므로, 재시도 시점을 무작위로 흩뜨렸습니다.

재시도 가능 에러(`ABORTED`, `DEADLINE_EXCEEDED`, `UNAVAILABLE`)와 비즈니스 로직 에러(`HttpsError`)를 분리해, 정원 초과처럼 몇 번을 다시 해도 결과가 같은 영구 실패는 즉시 종료합니다.

### 중복 신청 차단

등록 문서의 ID를 연락처(`010-XXXX-XXXX`)로 사용합니다. 같은 사람의 중복 제출은 애플리케이션 검사 이전에 **같은 문서를 건드리게 되므로** 트랜잭션이 직렬화해 줍니다. 버튼을 연타해도 자리가 두 번 나가지 않고, 중복 검증도 O(1) lookup으로 끝납니다.

### 적응형 폴링

잔여 자리 수에 따라 프론트엔드 폴링 주기를 동적으로 조정합니다.

| 잔여 | 주기 |
|---|---|
| 200명 초과 | 20s |
| 200명 이하 | 8s |
| 50명 이하 | 3s |
| 오픈 전 | 30s |
| 오프라인 | 60s |

마감 임박 구간에만 빠르게 갱신해 평소 비용을 줄였습니다. 여기에 제출 쿨다운(3s)과 최소 제출 간격(2s) 이중 가드, 탭이 백그라운드일 때 폴링 중단, 온라인 복귀 시 즉시 재조회를 더했습니다.

## 데이터 모델

| 컬렉션 | 용도 | 키 |
|---|---|---|
| `registrations` | 신청자 데이터 | 전화번호 (PK) |
| `counters` | 정원 카운터 (단일 문서) | `registrationTotal` |
| `registrationLogs` | 액션 로그 | auto-id |

```
registrations/{contact}
  name, school, contact, people,
  startNumber, endNumber, registrationId, checksum,
  status, timestamp, attempts, userAgent, ip

counters/registrationTotal        ← 모든 경합이 모이는 단일 문서
  count, version, lastUpdated, lastRegistration
```

`checksum`(`contact-people-start-end`)은 마감 후 순번 분쟁이 생겼을 때의 검증 근거입니다.

## API (Callable Functions)

| 함수 | 용도 |
|---|---|
| `registerWithLimit` | 신청 — 핵심 트랜잭션 |
| `getRegistrationStatus` | 현재 인원 · 잔여석 · 오픈 여부 · 서버 시각 |
| `checkRegistration` | 연락처로 본인 신청 내역 조회 |

시간 판정은 항상 서버 기준이며, 응답에 `serverTime`을 함께 내려 보내 기기 시계가 틀어져도 카운트다운이 어긋나지 않게 했습니다.

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
├── firebase.json                          Hosting(SPA) + Functions 설정
└── CODE_REVIEW.md                         전체 코드 리뷰 리포트
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

`firebase.json`의 predeploy는 lint만 실행합니다. 프론트엔드 빌드는 자동화되어 있지 않으므로 `npm run build`를 먼저 돌려야 합니다.

정원(`LIMIT`)과 오픈 시각(`OPEN_TIME`)은 `functions/index.js` 상단에 상수로 선언되어 있습니다. 1인당 최대 신청 인원은 2명입니다.

## 알려진 한계

전체 리뷰는 [`CODE_REVIEW.md`](./CODE_REVIEW.md)에 있습니다. 그중 아직 해결하지 않은 것들:

- **`checkRegistration`의 개인정보 노출.** 인증 없이 연락처 하나로 신청자의 이름·학교를 반환합니다. `010-0000-0000`부터 자동 열거하면 등록자 명부를 수집할 수 있습니다. App Check 적용, 이름+연락처 2요소 매칭, 응답 마스킹, rate limit이 필요합니다. **가장 시급한 항목입니다.**
- **`setTimeout` 기반 로그 기록.** `safeAsyncLog` 자체는 구현되어 있지만 `setTimeout(…, 100)` 안에서 호출됩니다. Cloud Functions v2는 응답 반환 직후 인스턴스가 freeze될 수 있어 콜백 실행이 보장되지 않습니다. 로그가 유실될 수 있으므로 `await`로 바꾸거나 Scheduled Function으로 분리해야 합니다.
- **정원과 오픈 시각이 하드코딩되어 있습니다.** 이 행사 전용이라 다른 행사에 재사용할 수 없습니다.
- **`firestore.rules`가 저장소에 없습니다.** 클라이언트 직접 읽기가 차단되어 있는지 코드만으로 확인할 수 없습니다.
- **`RegistrationForm.jsx`가 1,078줄 단일 컴포넌트입니다.** useEffect 6개, 내부 서브컴포넌트 3개가 한 파일에 있어 컴포넌트·훅 단위 분해가 필요합니다.
- **자동화 테스트가 없습니다.** 특히 동시성 시나리오는 Emulator 기반 통합 테스트와 부하 테스트로 회귀를 막아야 할 영역입니다.
- **`index.html`이 Vite 기본 템플릿 그대로입니다.** `lang="en"`, `title`이 "Vite + React"로 남아 있어 접근성·SEO·공유 미리보기에 영향이 있습니다.
