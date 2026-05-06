# Slotlink — 운정고 설명회 신청 시스템

800명 정원의 학교 설명회를 위한 신청 시스템. 45초 만에 마감되는 폭주 트래픽 환경에서 데이터 정합성을 보장하도록 설계했습니다.

**운영 URL**: [form-a1f4b.web.app](https://form-a1f4b.web.app)

## 운영 결과

- 정원 정확 마감 (800/800)
- 모든 등록 1차 시도 성공 (`attempts: 1`)
- 카운터-실데이터 정합성 100%

## 기술 스택

Firebase Cloud Functions (asia-northeast3), Firestore, React, Vite, Tailwind CSS

## 핵심 설계

### 트랜잭션 기반 정합성

여석 확인, 카운터 증가, 등록 문서 생성, 번호 발급을 단일 Firestore 트랜잭션으로 원자화했습니다. 정원 초과와 번호 중복 발급을 시스템적으로 차단합니다.

### 외부 재시도 + 지수 백오프

낙관락이 폭주 환경에서 충돌할 가능성에 대비해 SDK 내부 재시도 외에 외부 재시도 루프를 추가했습니다. 최대 5회, 500ms~5s 백오프, 0~1s 지터.

재시도 가능 에러(ABORTED, DEADLINE_EXCEEDED, UNAVAILABLE)와 비즈니스 로직 에러(HttpsError)를 분리해, 정원 초과 같은 영구 실패는 즉시 종료합니다.

### 적응형 폴링

잔여 자리 수에 따라 프론트엔드 폴링 주기를 동적으로 조정합니다.

| 잔여 | 주기 |
|---|---|
| 200명 초과 | 20s |
| 200명 이하 | 8s |
| 50명 이하 | 3s |
| 오픈 전 | 30s |
| 오프라인 | 60s |

마감 임박 구간에만 빠르게 갱신해 평소 비용을 줄였습니다.

## 데이터 모델

| 컬렉션 | 용도 | 키 |
|---|---|---|
| `registrations` | 신청자 데이터 | 전화번호 (PK) |
| `counters` | 정원 카운터 (단일 문서) | `registrationTotal` |
| `registrationLogs` | 액션 로그 | auto-id |

전화번호를 문서 ID로 사용해 중복 등록 검증을 O(1) lookup으로 처리합니다.

## 시스템 흐름

```
페이지 진입   → getRegistrationStatus → counters
신청 제출     → registerWithLimit     → 트랜잭션 (registrations + counters)
내 신청 확인  → checkRegistration     → registrations 직접 lookup
```

## 보강 포인트

- 5회 재시도 소진 케이스가 Cloud Logging에만 남고 Firestore에 영구 기록되지 않음. `safeAsyncLog` 추가 필요.
- 자동화 테스트 부재. Firebase Emulator + Jest 기반 동시성 통합 테스트, k6 기반 부하 테스트 필요.
