// src/lib/firebaseConfig.js
import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getFunctions } from "firebase/functions"; // ✅ 추가

const firebaseConfig = {
  apiKey: "AIzaSyBi11hNkWT9J_H9uiBg6YaNRgBPqz1gqso",
  authDomain: "form-a1f4b.firebaseapp.com",
  projectId: "form-a1f4b",
  storageBucket: "form-a1f4b.firebasestorage.app",
  messagingSenderId: "725202330296",
  appId: "1:725202330296:web:4d1224e698a418d1b2ca4d",
  measurementId: "G-DQPXHHJVD8"
};

// Firebase 초기화
const app = initializeApp(firebaseConfig);

// Firestore 인스턴스 생성
const db = getFirestore(app);

// ✅ Cloud Functions 인스턴스 (동아시아 리전 명시)
const functions = getFunctions(app, "asia-northeast3");

export { db, functions };
