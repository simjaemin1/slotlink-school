const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

// 🔥 아시아 리전 설정
setGlobalOptions({ region: 'asia-northeast3' });

initializeApp();

// 🔥 설정
const LIMIT = 800;
const OPEN_TIME = new Date('2025-08-27T10:00:00+09:00');

const db = getFirestore();
const isDev = process.env.NODE_ENV === 'development';

// 🔥 시간 체크 함수
const isRegistrationOpen = () => {
  const now = new Date();
  return now >= OPEN_TIME;
};

// 🔥 상수 정의
const ERROR_CODES = {
  TRANSACTION_ABORTED: 10,
  DEADLINE_EXCEEDED: 4,
  RESOURCE_EXHAUSTED: 8,
  UNAVAILABLE: 14
};

const RETRY_CONFIG = {
  MAX_ATTEMPTS: 5,
  BASE_DELAY: 500,
  MAX_DELAY: 5000,
  BACKOFF_MULTIPLIER: 2
};

// 🔥 유틸리티 함수
const generateRegistrationId = (contact, attempts = 0) => {
  return `${contact}_${Date.now()}_${attempts}_${Math.random().toString(36).substr(2, 9)}`;
};

const logError = (message, error, context = {}) => {
  if (isDev) {
    console.error(message, { error, context });
  } else {
    console.error(message, {
      code: error?.code,
      message: error?.message?.substring(0, 100),
      context
    });
  }
};

const validateInput = (data) => {
  const { name, school, contact, people } = data;

  if (!name?.trim() || !school?.trim() || !contact?.trim() || !people) {
    throw new HttpsError("invalid-argument", "모든 필드를 올바르게 입력해주세요.");
  }

  if (name.trim().length > 50) {
    throw new HttpsError("invalid-argument", "이름은 50자 이하여야 합니다.");
  }

  if (school.trim().length > 100) {
    throw new HttpsError("invalid-argument", "학교명은 100자 이하여야 합니다.");
  }

  if (![1, 2].includes(people)) {
    throw new HttpsError("invalid-argument", "신청 인원은 1명 또는 2명만 가능합니다.");
  }

  const cleanContact = contact.trim().replace(/[^\d-]/g, '');
  if (!/^010-\d{4}-\d{4}$/.test(cleanContact)) {
    throw new HttpsError("invalid-argument", "올바른 연락처 형식을 입력해주세요. (010-XXXX-XXXX)");
  }

  return {
    name: name.trim(),
    school: school.trim(),
    contact: cleanContact,
    people
  };
};

// 🔥 재시도 가능한 에러인지 확인
const isRetryableError = (error) => {
  if (!error) return false;

  const retryableCodes = [
    ERROR_CODES.TRANSACTION_ABORTED,
    ERROR_CODES.DEADLINE_EXCEEDED,
    ERROR_CODES.UNAVAILABLE
  ];

  return retryableCodes.includes(error.code) ||
         error.message?.includes('aborted') ||
         error.message?.includes('deadline') ||
         error.message?.includes('unavailable');
};

// 🔥 백오프 지연 계산
const calculateBackoffDelay = (attempt) => {
  const delay = RETRY_CONFIG.BASE_DELAY * Math.pow(RETRY_CONFIG.BACKOFF_MULTIPLIER, attempt - 1);
  const jitter = Math.random() * 1000;
  return Math.min(delay + jitter, RETRY_CONFIG.MAX_DELAY);
};

// 🔥 안전한 비동기 로깅 함수
const safeAsyncLog = async (logData, context = {}) => {
  try {
    await db.runTransaction(async (transaction) => {
      const logRef = db.collection('registrationLogs').doc();
      transaction.set(logRef, {
        ...logData,
        timestamp: FieldValue.serverTimestamp(),
        context
      });
    });
  } catch (logError) {
    if (isDev) {
      console.error('로그 작성 실패:', logError);
    }
  }
};

// 🔥 등록 함수
exports.registerWithLimit = onCall(async (request) => {
  if (!isRegistrationOpen()) {
    const koreanOpenTime = OPEN_TIME.toLocaleString('ko-KR', {
      timeZone: 'Asia/Seoul',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      weekday: 'long'
    });
    throw new HttpsError("permission-denied", `신청은 ${koreanOpenTime}부터 가능합니다.`);
  }

  const validatedData = validateInput(request.data);
  const { name, school, contact, people } = validatedData;

  const userAgent = request.rawRequest?.headers?.['user-agent']?.substring(0, 200) || 'unknown';
  const ip = request.rawRequest?.ip || 'unknown';
  const baseTimestamp = Date.now();

  const contactRef = db.collection('registrations').doc(contact);
  const counterRef = db.collection('counters').doc('registrationTotal');

  let attempts = 0;
  let lastError = null;

  while (attempts < RETRY_CONFIG.MAX_ATTEMPTS) {
    attempts++;

    try {
      const result = await db.runTransaction(async (transaction) => {
        const contactDoc = await transaction.get(contactRef);
        if (contactDoc.exists && contactDoc.data().status === 'confirmed') {
          throw new HttpsError("already-exists", "이미 등록된 연락처입니다.");
        }

        const counterDoc = await transaction.get(counterRef);
        const currentTotal = counterDoc.exists ? (counterDoc.data().count || 0) : 0;

        if (currentTotal >= LIMIT) {
          throw new HttpsError("resource-exhausted", "신청이 마감되었습니다.");
        }

        if (currentTotal + people > LIMIT) {
          const remaining = LIMIT - currentTotal;
          throw new HttpsError("invalid-argument",
            `남은 자리는 ${remaining}명입니다. ${remaining}명 이하로 신청해주세요.`);
        }

        const newTotal = currentTotal + people;
        const startNumber = currentTotal + 1;
        const endNumber = currentTotal + people;
        const registrationId = generateRegistrationId(contact, attempts);

        const registrationData = {
          name,
          school,
          contact,
          people,
          startNumber,
          endNumber,
          timestamp: FieldValue.serverTimestamp(),
          registrationId,
          status: 'confirmed',
          checksum: `${contact}-${people}-${startNumber}-${endNumber}`,
          version: 1,
          userAgent,
          ip,
          attempts
        };

        transaction.set(contactRef, registrationData);

        const counterData = {
          count: newTotal,
          lastUpdated: FieldValue.serverTimestamp(),
          lastRegistration: registrationId,
          version: counterDoc.exists ? FieldValue.increment(1) : 1
        };

        if (counterDoc.exists) {
          transaction.update(counterRef, counterData);
        } else {
          transaction.set(counterRef, counterData);
        }

        return {
          success: true,
          currentTotal: newTotal,
          remaining: LIMIT - newTotal,
          yourNumbers: people === 1 ? `${startNumber}번` : `${startNumber}번, ${endNumber}번`,
          registrationId,
          timestamp: baseTimestamp,
          attempts
        };
      });

      // 🔥 성공 후 비동기 로그 작성
      setTimeout(() => {
        safeAsyncLog({
          action: 'register',
          contact,
          people,
          numbers: result.yourNumbers,
          registrationId: result.registrationId,
          success: true,
          attempts: result.attempts
        });
      }, 100);

      return result;

    } catch (error) {
      lastError = error;

      if (error instanceof HttpsError) {
        setTimeout(() => {
          safeAsyncLog({
            action: 'register_failed',
            contact,
            people,
            errorCode: error.code,
            errorMessage: error.message,
            attempts
          });
        }, 100);
        throw error;
      }

      if (!isRetryableError(error)) {
        logError(`재시도 불가능한 에러 (시도 ${attempts})`, error, { contact, people });
        throw new HttpsError("internal", "서버 오류가 발생했습니다. 잠시 후 다시 시도해주세요.");
      }

      if (attempts >= RETRY_CONFIG.MAX_ATTEMPTS) {
        logError('최대 재시도 횟수 초과', lastError, { contact, attempts });
        throw new HttpsError("unavailable", "동시 접속자가 많습니다. 잠시 후 다시 시도해주세요.");
      }

      const backoffMs = calculateBackoffDelay(attempts);
      await new Promise(resolve => setTimeout(resolve, backoffMs));

      logError(`재시도 예정 (${attempts}/${RETRY_CONFIG.MAX_ATTEMPTS})`, error, {
        contact,
        backoffMs,
        nextAttempt: attempts + 1
      });
    }
  }

  throw new HttpsError("internal", "예상치 못한 오류가 발생했습니다.");
});

// 🔥 상태 조회
exports.getRegistrationStatus = onCall(async (_request) => {
  try {
    const isOpen = isRegistrationOpen();
    const now = new Date();

    const counterRef = db.collection('counters').doc('registrationTotal');
    const counterDoc = await counterRef.get();

    let currentTotal = 0;
    let lastUpdated = null;

    if (counterDoc.exists) {
      const data = counterDoc.data();
      currentTotal = data.count || 0;
      lastUpdated = data.lastUpdated;
    }

    const remaining = Math.max(0, LIMIT - currentTotal);

    return {
      currentTotal,
      remaining,
      isFull: currentTotal >= LIMIT,
      maxAllowedPeople: Math.min(2, remaining),
      lastUpdated,
      serverTime: now.getTime(),
      limit: LIMIT,
      isOpen,
      openTime: OPEN_TIME.getTime(),
      timeUntilOpen: isOpen ? 0 : Math.max(0, OPEN_TIME.getTime() - now.getTime())
    };
  } catch (error) {
    logError("상태 조회 오류", error);
    throw new HttpsError("internal", "상태 조회 중 오류가 발생했습니다.");
  }
});

// 🔥 신청 확인 함수
exports.checkRegistration = onCall(async (request) => {
  const { contact } = request.data;

  if (!contact?.trim()) {
    throw new HttpsError("invalid-argument", "연락처를 입력해주세요.");
  }

  const cleanContact = contact.trim().replace(/[^\d-]/g, '');
  if (!/^010-\d{4}-\d{4}$/.test(cleanContact)) {
    throw new HttpsError("invalid-argument", "올바른 연락처 형식을 입력해주세요.");
  }

  try {
    const doc = await db.collection('registrations').doc(cleanContact).get();

    if (!doc.exists || doc.data().status !== 'confirmed') {
      throw new HttpsError("not-found", "해당 연락처로 신청된 정보가 없습니다.");
    }

    const data = doc.data();

    setTimeout(() => {
      safeAsyncLog({
        action: 'check',
        contact: cleanContact,
        registrationId: data.registrationId
      });
    }, 100);

    return {
      name: data.name,
      school: data.school,
      contact: data.contact,
      people: data.people,
      yourNumbers: data.people === 1 ? `${data.startNumber}번` : `${data.startNumber}번, ${data.endNumber}번`,
      timestamp: data.timestamp,
      registrationId: data.registrationId,
      checksum: data.checksum
    };
  } catch (error) {
    if (error instanceof HttpsError) {
      throw error;
    }
    logError("신청 확인 오류", error, { contact: cleanContact });
    throw new HttpsError("internal", "신청 확인 중 오류가 발생했습니다.");
  }
});
