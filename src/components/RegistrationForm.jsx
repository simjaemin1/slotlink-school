import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { httpsCallable } from "firebase/functions";
import { functions } from "../lib/firebaseConfig";

// 🔥 상수 정의
const SUBMIT_COOLDOWN = 3000;
const MIN_SUBMIT_INTERVAL = 2000;
const MAX_RETRY_COUNT = 5;
const RETRY_DELAYS = [1500, 3000, 5000, 8000, 12000];

// 🔥 유틸리티 컴포넌트들
const LoadingSpinner = ({ size = 'md', message = '' }) => {
  const sizeClasses = {
    sm: 'h-4 w-4',
    md: 'h-6 w-6',
    lg: 'h-8 w-8'
  };
  
  return (
    <div className="flex items-center justify-center space-x-2">
      <div className={`animate-spin rounded-full border-2 border-gray-300 border-t-blue-600 ${sizeClasses[size]}`}></div>
      {message && <span className="text-sm text-gray-600">{message}</span>}
    </div>
  );
};

const ProgressBar = ({ progress, phase }) => {
  const phaseColors = {
    validating: 'bg-yellow-500',
    submitting: 'bg-blue-500',
    success: 'bg-green-500',
    error: 'bg-red-500'
  };
  
  return (
    <div className="w-full bg-gray-200 rounded-full h-2 mb-2">
      <div 
        className={`h-2 rounded-full transition-all duration-300 ${phaseColors[phase] || 'bg-gray-400'}`}
        style={{ width: `${progress}%` }}
      ></div>
    </div>
  );
};

// 🔥 카운트다운 컴포넌트
const CountdownTimer = ({ targetTime }) => {
  const [timeLeft, setTimeLeft] = useState(0);
  
  useEffect(() => {
    const calculateTimeLeft = () => {
      const now = new Date().getTime();
      const target = typeof targetTime === 'number' ? targetTime : new Date(targetTime).getTime();
      return Math.max(0, target - now);
    };
    
    setTimeLeft(calculateTimeLeft());
    
    const timer = setInterval(() => {
      const remaining = calculateTimeLeft();
      setTimeLeft(remaining);
      
      if (remaining <= 0) {
        clearInterval(timer);
        // 시간이 되면 페이지 새로고침하여 상태 업데이트
        setTimeout(() => window.location.reload(), 1000);
      }
    }, 1000);
    
    return () => clearInterval(timer);
  }, [targetTime]);
  
  const formatTime = useMemo(() => {
    const days = Math.floor(timeLeft / (1000 * 60 * 60 * 24));
    const hours = Math.floor((timeLeft % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((timeLeft % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((timeLeft % (1000 * 60)) / 1000);
    
    if (days > 0) {
      return `${days}일 ${hours}시간 ${minutes}분 ${seconds}초`;
    } else if (hours > 0) {
      return `${hours}시간 ${minutes}분 ${seconds}초`;
    } else if (minutes > 0) {
      return `${minutes}분 ${seconds}초`;
    } else {
      return `${seconds}초`;
    }
  }, [timeLeft]);
  
  return (
    <div className="text-center">
      <div className="text-3xl font-bold text-blue-600 mb-2">{formatTime}</div>
      <div className="text-sm text-gray-600">남았습니다</div>
    </div>
  );
};

export default function RegistrationForm() {
  // 🔥 기본 폼 상태
  const [name, setName] = useState("");
  const [school, setSchool] = useState("");
  const [contact, setContact] = useState("");
  const [people, setPeople] = useState(1);
  
  // 🔥 개선된 제출 상태 관리
  const [submitPhase, setSubmitPhase] = useState('idle'); // 'idle', 'validating', 'submitting', 'success', 'error'
  const [submitProgress, setSubmitProgress] = useState(0);
  const [submitMessage, setSubmitMessage] = useState('');
  
  // 🔥 실시간 입력 검증
  const [fieldErrors, setFieldErrors] = useState({});
  const [isFormValid, setIsFormValid] = useState(false);
  
  // 신청 확인 모드
  const [isCheckMode, setIsCheckMode] = useState(false);
  const [checkContact, setCheckContact] = useState("");
  const [checkResult, setCheckResult] = useState(null);
  const [isChecking, setIsChecking] = useState(false);
  
  // 실시간 등록 상태
  const [registrationStatus, setRegistrationStatus] = useState({
    currentTotal: 0,
    remaining: 800, // 800으로 변경
    isFull: false,
    maxAllowedPeople: 2,
    limit: 800, // 800으로 변경
    isOpen: false, // 🔥 새로 추가
    openTime: null, // 🔥 새로 추가
    timeUntilOpen: 0 // 🔥 새로 추가
  });
  
  const [isLoading, setIsLoading] = useState(true);
  
  // 🔥 개선된 연결 및 네트워크 상태
  const [lastUpdateTime, setLastUpdateTime] = useState(null);
  const [isRealTimeActive, setIsRealTimeActive] = useState(true);
  const [retryCount, setRetryCount] = useState(0);
  const [connectionStatus, setConnectionStatus] = useState('connecting');
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  
  // 🔥 Refs for cleanup and state management
  const submitCooldownRef = useRef(null);
  const intervalRef = useRef(null);
  const mountedRef = useRef(true);
  const lastSubmitTimeRef = useRef(0);
  const validationTimeoutRef = useRef(null);
  const retryTimeoutRef = useRef(null);
  const messageTimeoutRef = useRef(null);

  // 🔥 접근성 함수
  const announceToScreenReader = useCallback((message) => {
    const announcement = document.createElement('div');
    announcement.setAttribute('aria-live', 'polite');
    announcement.setAttribute('aria-atomic', 'true');
    announcement.style.position = 'absolute';
    announcement.style.left = '-10000px';
    announcement.textContent = message;
    
    document.body.appendChild(announcement);
    setTimeout(() => {
      if (document.body.contains(announcement)) {
        document.body.removeChild(announcement);
      }
    }, 1000);
  }, []);

  // 🔥 개선된 전화번호 포맷팅
  const formatPhoneNumber = useCallback((value) => {
    const numbers = value.replace(/[^\d]/g, '');
    
    if (numbers.length <= 3) {
      return numbers;
    } else if (numbers.length <= 7) {
      return `${numbers.slice(0, 3)}-${numbers.slice(3)}`;
    } else if (numbers.length <= 11) {
      return `${numbers.slice(0, 3)}-${numbers.slice(3, 7)}-${numbers.slice(7)}`;
    } else {
      return `${numbers.slice(0, 3)}-${numbers.slice(3, 7)}-${numbers.slice(7, 11)}`;
    }
  }, []);

  // 🔥 실시간 필드 검증
  const validateField = useCallback((field, value) => {
    setFieldErrors(prev => {
      const errors = { ...prev };
      
      switch (field) {
        case 'name':
          if (!value.trim()) {
            errors.name = '이름을 입력해주세요';
          } else if (value.length > 50) {
            errors.name = '이름은 50자 이하여야 합니다';
          } else {
            delete errors.name;
          }
          break;
          
        case 'contact':
          if (!value.trim()) {
            errors.contact = '연락처를 입력해주세요';
          } else if (!/^010-\d{4}-\d{4}$/.test(value)) {
            errors.contact = '올바른 연락처 형식이 아닙니다 (010-XXXX-XXXX)';
          } else {
            delete errors.contact;
          }
          break;
          
        case 'school':
          if (!value.trim()) {
            errors.school = '학교명을 입력해주세요';
          } else if (value.length > 100) {
            errors.school = '학교명은 100자 이하여야 합니다';
          } else {
            delete errors.school;
          }
          break;
      }
      
      return errors;
    });
  }, []);

  // 🔥 폼 유효성 체크 (useMemo로 최적화)
  const formValidation = useMemo(() => {
    const hasErrors = Object.keys(fieldErrors).length > 0;
    const allFieldsFilled = name.trim() && school.trim() && contact.trim();
    return !hasErrors && allFieldsFilled;
  }, [fieldErrors, name, school, contact]);

  // 🔥 유효성 상태 동기화
  useEffect(() => {
    setIsFormValid(formValidation);
  }, [formValidation]);

  // 🔥 디바운스된 검증
  const debouncedValidation = useCallback((field, value) => {
    if (validationTimeoutRef.current) {
      clearTimeout(validationTimeoutRef.current);
    }
    
    validationTimeoutRef.current = setTimeout(() => {
      if (mountedRef.current) {
        validateField(field, value);
      }
    }, 300);
  }, [validateField]);

  // 🔥 개선된 에러 메시지 처리
  const getErrorMessage = useCallback((error) => {
    const errorMessages = {
      "functions/already-exists": "이미 이 연락처로 신청하셨습니다.",
      "functions/resource-exhausted": "신청이 마감되었습니다.",
      "functions/invalid-argument": error.message || "입력 정보를 확인해주세요.",
      "functions/unavailable": "동시 접속자가 많습니다. 잠시 후 다시 시도해주세요.",
      "functions/deadline-exceeded": "요청 시간이 초과되었습니다. 다시 시도해주세요.",
      "functions/permission-denied": error.message || "권한이 없습니다."
    };
    
    return errorMessages[error.code] || "신청 중 오류가 발생했습니다. 다시 시도해주세요.";
  }, []);

  // 🔥 안전한 상태 업데이트 함수
  const safeSetState = useCallback((setter, value) => {
    if (mountedRef.current) {
      setter(value);
    }
  }, []);

  // 🔥 개선된 상태 조회 (재시도 로직 강화)
  const fetchRegistrationStatus = useCallback(async (isBackground = false) => {
    if (!mountedRef.current) return;
    
    try {
      if (!isBackground) {
        safeSetState(setConnectionStatus, 'connecting');
      }
      
      const getStatus = httpsCallable(functions, "getRegistrationStatus");
      const result = await getStatus();
      
      if (!mountedRef.current) return;
      
      safeSetState(setRegistrationStatus, result.data);
      safeSetState(setLastUpdateTime, new Date());
      safeSetState(setRetryCount, 0);
      safeSetState(setConnectionStatus, 'connected');
      
      if (!isBackground) {
        safeSetState(setIsLoading, false);
      }
      
      // 성공 시 재시도 타이머 클리어
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current);
        retryTimeoutRef.current = null;
      }
      
    } catch (error) {
      if (!mountedRef.current) return;
      
      console.error("상태 조회 오류:", error);
      safeSetState(setConnectionStatus, 'error');
      
      if (retryCount < MAX_RETRY_COUNT) {
        const nextRetry = retryCount + 1;
        safeSetState(setRetryCount, nextRetry);
        
        const delay = RETRY_DELAYS[nextRetry - 1] || RETRY_DELAYS[RETRY_DELAYS.length - 1];
        
        retryTimeoutRef.current = setTimeout(() => {
          if (mountedRef.current) {
            fetchRegistrationStatus(isBackground);
          }
        }, delay);
      } else if (!isBackground) {
        safeSetState(setSubmitPhase, 'error');
        safeSetState(setSubmitProgress, 0);
        safeSetState(setSubmitMessage, '서버 연결에 문제가 있습니다. 페이지를 새로고침해주세요.');
        safeSetState(setIsLoading, false);
      }
    }
  }, [retryCount, safeSetState]);

  // 🔥 개선된 제출 처리 (Race Condition 해결)
  const handleSubmit = useCallback(async (e) => {
    e.preventDefault();
    
    const now = Date.now();
    if (submitPhase !== 'idle' || submitCooldownRef.current || 
        (now - lastSubmitTimeRef.current < MIN_SUBMIT_INTERVAL)) {
      return;
    }
    
    if (!isFormValid) {
      safeSetState(setSubmitPhase, 'error');
      safeSetState(setSubmitProgress, 0);
      safeSetState(setSubmitMessage, '모든 필드를 올바르게 입력해주세요.');
      return;
    }
    
    lastSubmitTimeRef.current = now;

    try {
      // 1단계: 검증
      safeSetState(setSubmitPhase, 'validating');
      safeSetState(setSubmitProgress, 20);
      safeSetState(setSubmitMessage, '입력 정보 검증 중...');

      // 쿨다운 설정
      submitCooldownRef.current = setTimeout(() => {
        if (mountedRef.current) {
          submitCooldownRef.current = null;
        }
      }, SUBMIT_COOLDOWN);

      // 2단계: 서버 요청
      safeSetState(setSubmitPhase, 'submitting');
      safeSetState(setSubmitProgress, 50);
      safeSetState(setSubmitMessage, '서버에 요청 중...');

      const register = httpsCallable(functions, "registerWithLimit");
      const result = await register({ 
        name: name.trim(), 
        school: school.trim(), 
        contact: contact.trim(), 
        people 
      });
      
      if (!mountedRef.current) return;
      
      if (result.data.success) {
        // 3단계: 성공
        safeSetState(setSubmitPhase, 'success');
        safeSetState(setSubmitProgress, 100);
        safeSetState(setSubmitMessage, `신청 완료! 번호: ${result.data.yourNumbers}`);
        
        // 접근성 알림
        announceToScreenReader(`신청이 완료되었습니다. 신청 번호는 ${result.data.yourNumbers}입니다.`);
        
        // 🔥 안전한 낙관적 UI 업데이트
        safeSetState(setRegistrationStatus, prev => ({
          ...prev,
          currentTotal: result.data.currentTotal,
          remaining: result.data.remaining,
          isFull: result.data.remaining <= 0,
          maxAllowedPeople: Math.min(2, result.data.remaining)
        }));
        
        // 🔥 안전한 폼 리셋
        const resetTimer = setTimeout(() => {
          if (mountedRef.current) {
            setName("");
            setSchool("");
            setContact("");
            setPeople(1);
            setFieldErrors({});
            safeSetState(setSubmitPhase, 'idle');
            safeSetState(setSubmitProgress, 0);
            safeSetState(setSubmitMessage, '');
            
            // 정확한 상태 재조회
            fetchRegistrationStatus(true);
          }
        }, 3000);
        
        // cleanup에 추가할 타이머 등록
        return () => clearTimeout(resetTimer);
      }
    } catch (error) {
      if (!mountedRef.current) return;
      
      console.error("신청 오류:", error);
      
      const errorMessage = getErrorMessage(error);
      safeSetState(setSubmitPhase, 'error');
      safeSetState(setSubmitProgress, 0);
      safeSetState(setSubmitMessage, errorMessage);
      
      // 접근성 알림
      announceToScreenReader(`오류가 발생했습니다. ${errorMessage}`);
      
      // 특정 오류들에 대해서는 상태 재조회
      const shouldRefresh = ['functions/resource-exhausted', 'functions/invalid-argument'];
      if (shouldRefresh.includes(error.code)) {
        fetchRegistrationStatus(true);
      }
    }
  }, [submitPhase, isFormValid, name, school, contact, people, announceToScreenReader, getErrorMessage, fetchRegistrationStatus, safeSetState]);

  // 🔥 개선된 신청 확인 처리
  const handleCheckRegistration = useCallback(async (e) => {
    e.preventDefault();
    
    safeSetState(setIsChecking, true);
    safeSetState(setCheckResult, null);

    try {
      const checkReg = httpsCallable(functions, "checkRegistration");
      const result = await checkReg({ contact: checkContact.trim() });
      
      if (mountedRef.current) {
        safeSetState(setCheckResult, result.data);
        announceToScreenReader("신청 정보가 확인되었습니다.");
      }
    } catch (error) {
      if (!mountedRef.current) return;
      
      console.error("신청 확인 오류:", error);
      
      let errorMessage = "신청 확인 중 오류가 발생했습니다.";
      if (error.code === "functions/not-found") {
        errorMessage = "해당 연락처로 신청된 정보가 없습니다.";
      } else if (error.code === "functions/invalid-argument") {
        errorMessage = "연락처를 올바르게 입력해주세요.";
      }
      
      safeSetState(setCheckResult, { error: errorMessage });
      announceToScreenReader(`오류가 발생했습니다. ${errorMessage}`);
    } finally {
      if (mountedRef.current) {
        safeSetState(setIsChecking, false);
      }
    }
  }, [checkContact, announceToScreenReader, safeSetState]);

  // 🔥 개선된 동적 폴링 시스템
  const getPollingInterval = useCallback(() => {
    if (!isOnline) return 60000; // 오프라인시 1분마다
    if (!registrationStatus.isOpen) return 30000; // 오픈 전에는 30초마다
    if (registrationStatus.remaining <= 50) return 3000;  // 3초
    if (registrationStatus.remaining <= 200) return 8000; // 8초
    return 20000; // 20초
  }, [isOnline, registrationStatus.remaining, registrationStatus.isOpen]);

  const startPolling = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
    }
    
    const interval = getPollingInterval();
    
    intervalRef.current = setInterval(() => {
      if (isRealTimeActive && mountedRef.current && isOnline) {
        fetchRegistrationStatus(true);
      }
    }, interval);
  }, [getPollingInterval, isRealTimeActive, fetchRegistrationStatus, isOnline]);

  // 🔥 네트워크 상태 감지
  useEffect(() => {
    const handleOnline = () => {
      safeSetState(setIsOnline, true);
      safeSetState(setConnectionStatus, 'connecting');
      if (mountedRef.current) {
        fetchRegistrationStatus(true);
      }
    };
    
    const handleOffline = () => {
      safeSetState(setIsOnline, false);
      safeSetState(setConnectionStatus, 'offline');
    };
    
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [fetchRegistrationStatus, safeSetState]);

  // 🔥 페이지 가시성 감지
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden) {
        safeSetState(setIsRealTimeActive, false);
      } else {
        safeSetState(setIsRealTimeActive, true);
        if (mountedRef.current && isOnline) {
          fetchRegistrationStatus(true);
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [fetchRegistrationStatus, isOnline, safeSetState]);

  // 🔥 폴링 간격 변경 감지 및 재시작
  useEffect(() => {
    startPolling();
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [startPolling]);

  // 🔥 초기 로딩
  useEffect(() => {
    fetchRegistrationStatus();
  }, [fetchRegistrationStatus]);

  // 🔥 컴포넌트 언마운트 정리
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      
      // 모든 타이머와 인터벌 정리
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
      if (submitCooldownRef.current) {
        clearTimeout(submitCooldownRef.current);
      }
      if (validationTimeoutRef.current) {
        clearTimeout(validationTimeoutRef.current);
      }
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current);
      }
      if (messageTimeoutRef.current) {
        clearTimeout(messageTimeoutRef.current);
      }
    };
  }, []);

  // 🔥 인원 수 제한 체크
  useEffect(() => {
    if (people > registrationStatus.maxAllowedPeople && registrationStatus.maxAllowedPeople > 0) {
      setPeople(registrationStatus.maxAllowedPeople);
    }
  }, [registrationStatus.maxAllowedPeople, people]);

  // 🔥 제출 상태 메시지 자동 클리어
  useEffect(() => {
    if (submitPhase === 'error' && submitMessage) {
      if (messageTimeoutRef.current) {
        clearTimeout(messageTimeoutRef.current);
      }
      
      messageTimeoutRef.current = setTimeout(() => {
        if (mountedRef.current) {
          safeSetState(setSubmitMessage, '');
        }
      }, 8000);
      
      return () => {
        if (messageTimeoutRef.current) {
          clearTimeout(messageTimeoutRef.current);
        }
      };
    }
  }, [submitPhase, submitMessage, safeSetState]);

  // 🔥 입력 핸들러들
  const handleNameChange = useCallback((e) => {
    const value = e.target.value;
    setName(value);
    debouncedValidation('name', value);
  }, [debouncedValidation]);

  const handleSchoolChange = useCallback((e) => {
    const value = e.target.value;
    setSchool(value);
    debouncedValidation('school', value);
  }, [debouncedValidation]);

  const handleContactChange = useCallback((e) => {
    const formatted = formatPhoneNumber(e.target.value);
    setContact(formatted);
    debouncedValidation('contact', formatted);
  }, [formatPhoneNumber, debouncedValidation]);

  // 🔥 연결 상태 표시 (useMemo로 최적화)
  const connectionDisplay = useMemo(() => {
    if (!isOnline) return { text: "오프라인", color: "text-red-500", icon: "🔴" };
    if (connectionStatus === 'connecting') return { text: "연결 중...", color: "text-yellow-500", icon: "🟡" };
    if (connectionStatus === 'error') return { text: "연결 오류", color: "text-red-500", icon: "🔴" };
    if (connectionStatus === 'offline') return { text: "오프라인", color: "text-red-500", icon: "🔴" };
    
    if (!lastUpdateTime) return { text: "연결 중...", color: "text-yellow-500", icon: "🟡" };
    
    const diffSeconds = Math.floor((new Date() - lastUpdateTime) / 1000);
    if (diffSeconds < 10) return { text: "실시간", color: "text-green-500", icon: "🟢" };
    if (diffSeconds < 60) return { text: `${diffSeconds}초 전`, color: "text-yellow-500", icon: "🟡" };
    return { text: "연결 확인 중", color: "text-red-500", icon: "🔴" };
  }, [isOnline, connectionStatus, lastUpdateTime]);

  // 🔥 시간 포맷팅 함수
  const formatTimestamp = useCallback((timestamp) => {
    if (!timestamp) return '정보 없음';
    
    let date;
    try {
      if (timestamp.seconds) {
        date = new Date(timestamp.seconds * 1000);
      } else if (timestamp._seconds) {
        date = new Date(timestamp._seconds * 1000);
      } else if (typeof timestamp === 'string') {
        date = new Date(timestamp);
      } else if (timestamp.toDate && typeof timestamp.toDate === 'function') {
        date = timestamp.toDate();
      } else {
        return '시간 형식 오류';
      }
      
      if (isNaN(date.getTime())) {
        return '잘못된 시간 정보';
      }
      
      return new Intl.DateTimeFormat('ko-KR', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        hour12: false
      }).format(date);
    } catch (error) {
      console.error('시간 파싱 오류:', error);
      return '시간 정보 오류';
    }
  }, []);

  // 🔥 오픈 시간 포맷팅
  const formatOpenTime = useCallback((openTime) => {
    if (!openTime) return '';
    
    const date = new Date(openTime);
    return new Intl.DateTimeFormat('ko-KR', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      weekday: 'long',
      timeZone: 'Asia/Seoul'
    }).format(date);
  }, []);

  // 🔥 로딩 상태
  if (isLoading) {
    return (
      <div className="max-w-md mx-auto mt-10 p-4 border rounded-xl shadow bg-white">
        <div className="text-center">
          <LoadingSpinner size="lg" message="로딩 중..." />
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-md mx-auto mt-10 p-4 border rounded-xl shadow bg-white space-y-4">
      <h1 className="text-2xl font-bold text-center">
        {isCheckMode ? "신청 확인" : "운정고 설명회 신청"}
      </h1>
      
      {/* 🔥 오픈 전 대기 화면 */}
      {!registrationStatus.isOpen && !isCheckMode ? (
        <>
          <div className="bg-blue-50 border border-blue-200 p-6 rounded-lg text-center">
            <div className="text-blue-800 font-semibold text-lg mb-4">
              🕐 신청 오픈 예정
            </div>
            <div className="text-blue-700 mb-6">
              {formatOpenTime(registrationStatus.openTime)}
            </div>
            
            {registrationStatus.timeUntilOpen > 0 && (
              <CountdownTimer targetTime={registrationStatus.openTime} />
            )}
            
            <div className="mt-6 text-sm text-blue-600 bg-blue-100 p-3 rounded">
              <div className="font-semibold mb-2">📋 신청 안내</div>
              <div className="space-y-1 text-left">
                <div>• 정원: {registrationStatus.limit}명</div>
                <div>• 신청 인원: 1명 또는 2명</div>
                <div>• 선착순 접수</div>
                <div>• 중복 신청 불가</div>
              </div>
            </div>
          </div>
          
          {/* 🔥 연결 상태 표시 */}
          <div className="text-center text-xs flex items-center justify-center">
            <span className="mr-1">{connectionDisplay.icon}</span>
            <span className={connectionDisplay.color}>{connectionDisplay.text}</span>
          </div>
          
          {/* 🔥 신청 확인 버튼 */}
          <button
            onClick={() => setIsCheckMode(true)}
            className="w-full py-2 text-sm text-blue-600 hover:text-blue-800 transition-colors border border-blue-200 rounded"
          >
            📋 신청 확인 (이미 신청한 경우)
          </button>
        </>
      ) : !isCheckMode ? (
        <>
          {/* 🔥 현재 신청 현황 */}
          <div className="bg-gray-50 p-3 rounded-lg text-center relative">
            <div className="text-sm text-gray-600">현재 신청 현황</div>
            <div className="text-lg font-semibold">
              {registrationStatus.currentTotal} / {registrationStatus.limit}명
            </div>
            <div className="text-sm">
              {registrationStatus.isFull ? (
                <span className="text-red-600 font-semibold">⚠️ 신청 마감</span>
              ) : (
                <span className="text-green-600">
                  {registrationStatus.remaining}명 남음
                </span>
              )}
            </div>
            
            {/* 🔥 연결 상태 표시 */}
            <div className="absolute top-2 right-2 text-xs flex items-center">
              <span className="mr-1">{connectionDisplay.icon}</span>
              <span className={connectionDisplay.color}>{connectionDisplay.text}</span>
            </div>
          </div>

          {/* 🔥 오프라인 알림 */}
          {!isOnline && (
            <div className="bg-red-50 border border-red-200 p-3 rounded-lg">
              <div className="text-red-700 font-semibold text-center">
                🔴 인터넷 연결이 끊어졌습니다. 연결을 확인해주세요.
              </div>
            </div>
          )}

          {/* 🔥 마감 임박 알림 */}
          {registrationStatus.remaining <= 50 && registrationStatus.remaining > 0 && (
            <div className="bg-orange-50 border border-orange-200 p-3 rounded-lg animate-pulse">
              <div className="text-orange-700 font-semibold text-center">
                🔥 마감 임박! 서둘러 신청하세요 (잔여: {registrationStatus.remaining}명)
              </div>
            </div>
          )}

          {/* 🔥 제출 상태 표시 */}
          {submitPhase !== 'idle' && (
            <div className={`p-3 rounded-lg border ${
              submitPhase === 'success' ? "bg-green-50 border-green-200" :
              submitPhase === 'error' ? "bg-red-50 border-red-200" :
              "bg-blue-50 border-blue-200"
            }`}>
              {submitPhase !== 'idle' && submitPhase !== 'error' && (
                <ProgressBar progress={submitProgress} phase={submitPhase} />
              )}
              <div className={`text-center font-medium ${
                submitPhase === 'success' ? "text-green-700" :
                submitPhase === 'error' ? "text-red-700" :
                "text-blue-700"
              }`}>
                {submitMessage}
              </div>
            </div>
          )}

          {/* 🔥 마감된 경우 */}
          {registrationStatus.isFull ? (
            <div className="text-center p-6 bg-red-50 border border-red-200 rounded-lg">
              <div className="text-red-700 font-semibold text-lg mb-2">
                신청이 마감되었습니다
              </div>
              <div className="text-red-600 text-sm">
                정원 {registrationStatus.limit}명이 모두 찼습니다.
              </div>
            </div>
          ) : (
            /* 🔥 신청 폼 */
            <form onSubmit={handleSubmit} className="space-y-4" noValidate>
              <div>
                <label className="block font-semibold mb-1" htmlFor="name">
                  이름 <span className="text-red-500">*</span>
                </label>
                <input
                  id="name"
                  type="text"
                  value={name}
                  required
                  onChange={handleNameChange}
                  className={`w-full p-2 border rounded focus:border-blue-500 focus:outline-none transition-colors ${
                    fieldErrors.name ? 'border-red-500 bg-red-50' : 'border-gray-300'
                  }`}
                  placeholder="이름을 입력해주세요"
                  disabled={submitPhase === 'submitting' || submitPhase === 'validating'}
                  maxLength="50"
                  aria-describedby={fieldErrors.name ? "name-error" : undefined}
                />
                {fieldErrors.name && (
                  <div id="name-error" className="text-red-500 text-xs mt-1" role="alert">
                    {fieldErrors.name}
                  </div>
                )}
              </div>

              <div>
                <label className="block font-semibold mb-1" htmlFor="school">
                  학교명 <span className="text-red-500">*</span>
                </label>
                <input
                  id="school"
                  type="text"
                  value={school}
                  required
                  onChange={handleSchoolChange}
                  className={`w-full p-2 border rounded focus:border-blue-500 focus:outline-none transition-colors ${
                    fieldErrors.school ? 'border-red-500 bg-red-50' : 'border-gray-300'
                  }`}
                  placeholder="학교명을 입력해주세요 (예: 운정고등학교)"
                  disabled={submitPhase === 'submitting' || submitPhase === 'validating'}
                  maxLength="100"
                  aria-describedby={fieldErrors.school ? "school-error" : undefined}
                />
                {fieldErrors.school && (
                  <div id="school-error" className="text-red-500 text-xs mt-1" role="alert">
                    {fieldErrors.school}
                  </div>
                )}
              </div>

              <div>
                <label className="block font-semibold mb-1" htmlFor="contact">
                  연락처 <span className="text-red-500">*</span>
                </label>
                <input
                  id="contact"
                  type="tel"
                  value={contact}
                  required
                  onChange={handleContactChange}
                  className={`w-full p-2 border rounded focus:border-blue-500 focus:outline-none transition-colors ${
                    fieldErrors.contact ? 'border-red-500 bg-red-50' : 'border-gray-300'
                  }`}
                  placeholder="연락처를 입력해주세요 (예: 010-1234-5678)"
                  maxLength="13"
                  disabled={submitPhase === 'submitting' || submitPhase === 'validating'}
                  aria-describedby="contact-help"
                />
                {fieldErrors.contact && (
                  <div className="text-red-500 text-xs mt-1" role="alert">
                    {fieldErrors.contact}
                  </div>
                )}
                <div id="contact-help" className="text-xs text-gray-500 mt-1">
                  숫자만 입력하면 자동으로 하이픈(-)이 추가됩니다
                </div>
              </div>

              <div>
                <label className="block font-semibold mb-1" htmlFor="people">
                  신청 인원 <span className="text-red-500">*</span>
                </label>
                <select
                  id="people"
                  value={people}
                  onChange={(e) => setPeople(Number(e.target.value))}
                  className="w-full p-2 border border-gray-300 rounded focus:border-blue-500 focus:outline-none"
                  disabled={submitPhase === 'submitting' || submitPhase === 'validating'}
                >
                  {registrationStatus.maxAllowedPeople >= 1 && (
                    <option value={1}>1명</option>
                  )}
                  {registrationStatus.maxAllowedPeople >= 2 && (
                    <option value={2}>2명</option>
                  )}
                </select>
                
                {registrationStatus.remaining <= 2 && registrationStatus.remaining > 0 && (
                  <div className="text-sm text-orange-600 mt-1">
                    ⚠️ 남은 자리가 {registrationStatus.remaining}명이므로 최대 {registrationStatus.maxAllowedPeople}명까지만 신청 가능합니다.
                  </div>
                )}
              </div>

              {/* 🔥 제출 버튼 */}
              <button
                type="submit"
                disabled={!isFormValid || submitPhase !== 'idle' || !isOnline}
                className={`w-full py-3 rounded text-white font-semibold transition-all duration-200 ${
                  !isFormValid || submitPhase !== 'idle' || !isOnline
                    ? "bg-gray-400 cursor-not-allowed" 
                    : "bg-blue-600 hover:bg-blue-700 hover:shadow-lg active:scale-95"
                }`}
                aria-label={
                  !isOnline ? "오프라인 상태에서는 신청할 수 없습니다" :
                  !isFormValid ? "모든 필드를 올바르게 입력해주세요" :
                  submitPhase !== 'idle' ? "처리 중입니다" :
                  "신청하기"
                }
              >
                {submitPhase === 'validating' || submitPhase === 'submitting' ? (
                  <span className="flex items-center justify-center">
                    <LoadingSpinner size="sm" />
                    <span className="ml-2">
                      {submitPhase === 'validating' ? '검증 중...' : '제출 중...'}
                    </span>
                  </span>
                ) : !isOnline ? (
                  "오프라인"
                ) : !isFormValid ? (
                  "입력 완료 후 신청하기"
                ) : (
                  "신청하기"
                )}
              </button>
            </form>
          )}

          {/* 🔥 하단 버튼들 */}
          <div className="flex gap-2">
            <button
              onClick={() => fetchRegistrationStatus()}
              disabled={isLoading || connectionStatus === 'connecting' || !isOnline}
              className="flex-1 py-2 text-sm text-gray-600 hover:text-gray-800 transition-colors disabled:opacity-50 border border-gray-200 rounded"
            >
              🔄 현황 새로고침
            </button>
            <button
              onClick={() => setIsCheckMode(true)}
              className="flex-1 py-2 text-sm text-blue-600 hover:text-blue-800 transition-colors border border-blue-200 rounded"
            >
              📋 신청 확인
            </button>
          </div>
        </>
      ) : (
        /* 🔥 신청 확인 모드 */
        <>
          <div className="text-center text-sm text-gray-600 mb-4">
            연락처를 입력하여 신청 정보를 확인하세요
          </div>

          <form onSubmit={handleCheckRegistration} className="space-y-4">
            <div>
              <label className="block font-semibold mb-1" htmlFor="check-contact">연락처</label>
              <input
                id="check-contact"
                type="tel"
                value={checkContact}
                required
                onChange={(e) => setCheckContact(formatPhoneNumber(e.target.value))}
                className="w-full p-2 border border-gray-300 rounded focus:border-blue-500 focus:outline-none"
                placeholder="신청시 입력한 연락처를 입력해주세요"
                maxLength="13"
                disabled={isChecking}
              />
            </div>

            <button
              type="submit"
              disabled={isChecking || !checkContact.trim() || !isOnline}
              className={`w-full py-2 rounded text-white font-semibold transition-colors ${
                isChecking || !checkContact.trim() || !isOnline
                  ? "bg-gray-400 cursor-not-allowed" 
                  : "bg-blue-600 hover:bg-blue-700"
              }`}
            >
              {isChecking ? (
                <span className="flex items-center justify-center">
                  <LoadingSpinner size="sm" />
                  <span className="ml-2">확인 중...</span>
                </span>
              ) : !isOnline ? (
                "오프라인"
              ) : (
                "신청 정보 확인"
              )}
            </button>
          </form>

          {/* 🔥 확인 결과 */}
          {checkResult && (
            <div className="mt-4 p-4 border rounded-lg">
              {checkResult.error ? (
                <div className="text-red-600 text-center">
                  ❌ {checkResult.error}
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="text-center text-green-600 font-semibold mb-3">
                    ✅ 신청 정보가 확인되었습니다
                  </div>
                  <div className="bg-gray-50 p-3 rounded space-y-2 text-sm">
                    <div className="flex justify-between">
                      <strong>이름:</strong> 
                      <span>{checkResult.name}</span>
                    </div>
                    <div className="flex justify-between">
                      <strong>학교:</strong> 
                      <span>{checkResult.school}</span>
                    </div>
                    <div className="flex justify-between">
                      <strong>연락처:</strong> 
                      <span>{checkResult.contact}</span>
                    </div>
                    <div className="flex justify-between">
                      <strong>신청 인원:</strong> 
                      <span>{checkResult.people}명</span>
                    </div>
                    <div className="flex justify-between">
                      <strong>신청 번호:</strong> 
                      <span className="font-semibold text-blue-600">{checkResult.yourNumbers}</span>
                    </div>
                    <div className="flex justify-between">
                      <strong>신청 시각:</strong> 
                      <span>{formatTimestamp(checkResult.timestamp)}</span>
                    </div>
                    {checkResult.checksum && (
                      <div className="text-xs text-gray-500 mt-2 pt-2 border-t">
                        확인코드: {checkResult.checksum}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* 🔥 뒤로가기 버튼 */}
          <button
            onClick={() => {
              setIsCheckMode(false);
              setCheckContact("");
              setCheckResult(null);
            }}
            className="w-full py-2 text-sm text-gray-600 hover:text-gray-800 border border-gray-300 rounded transition-colors"
          >
            ← 뒤로 가기
          </button>
        </>
      )}
    </div>
  );
}