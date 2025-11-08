import React, { useState, useEffect, useCallback } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, collection, query, onSnapshot, addDoc, doc, deleteDoc } from 'firebase/firestore';
import { Plus, X, Trash2, Calendar, Clock, MessageSquare, Bell, Send, Link, Activity, Heart, Moon } from 'lucide-react';

/** ---------------------------------------
 * App Config (unchanged)
 * -------------------------------------- */
const isLocalRun = typeof __initial_auth_token === 'undefined';

const FIREBASE_LOCAL_CONFIG = {
  apiKey: "AIzaSyAdR5AX4GyipuN1OJZew9wxjzsUawMLovU",
  authDomain: "health-navigator-cb1e9.firebaseapp.com",
  projectId: "health-navigator-cb1e9",
  storageBucket: "health-navigator-cb1e9.firebasestorage.app",
  messagingSenderId: "320930192297",
  appId: "1:320930192297:web:b3ad8eaeabdf18330782b8",
  measurementId: "G-N2FRL54GFF"
};

// Gemini & Google Fit keys (local)
const GEMINI_API_KEY = "AIzaSyA_pbiHyj43tARucPRcUtwcQxMkOnDi_bw";
const GOOGLE_CLIENT_ID = '372260688523-1o2r51dmk1vrq98i9pjktnqh94q0a28d.apps.googleusercontent.com';

const appId = (typeof __app_id !== 'undefined' ? __app_id : 'local-health-app').replace(/[\/.]/g, '-');
const initialAuthToken = typeof __initial_auth_token !== 'undefined' ? __initial_auth_token : null;
const firebaseConfig = isLocalRun
  ? FIREBASE_LOCAL_CONFIG
  : (typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : {});

// Health constants
const DAILY_STEP_GOAL = 10000;
const RECOMMENDED_SLEEP_HOURS = 7.5;

const COLORS = {
  PRIMARY_ACCENT: '#C82550',
  SECONDARY_ACCENT: '#E07889',
  LIGHT_BG: '#FCE4C9',
  MAIN_BG: '#FAF0E5',
  DARK_TEXT: '#2C3E50',
};

/** ---------------------------------------
 * Small UI Helpers
 * -------------------------------------- */
const LoadingSpinner = () => (
  <div className="flex justify-center items-center py-4">
    <div className="w-6 h-6 border-2 border-slate-400"
      style={{ borderTopColor: COLORS.PRIMARY_ACCENT, borderRadius: '50%', animation: 'spin 1s linear infinite' }}
    />
    <span className="ml-3" style={{ color: COLORS.PRIMARY_ACCENT }}>Loading...</span>
    <style>{`
      @keyframes spin { 0%{transform:rotate(0)} 100%{transform:rotate(360deg)} }
    `}</style>
  </div>
);

const StepCompletionRing = ({ steps, goal, size = 150 }) => {
  const rawPercentage = (steps / goal) * 100;
  const percentage = Math.min(100, Math.round(rawPercentage));
  const radius = 50;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (percentage / 100) * circumference;
  const progressColor = percentage >= 100 ? '#38A169' : COLORS.PRIMARY_ACCENT;

  return (
    <div className="relative flex flex-col items-center justify-center p-4">
      <svg width={size} height={size} viewBox="0 0 120 120" className="-rotate-90">
        <circle cx="60" cy="60" r={radius} fill="none" stroke={COLORS.SECONDARY_ACCENT} strokeWidth="10" opacity="0.3" />
        <circle cx="60" cy="60" r={radius} fill="none" stroke={progressColor} strokeWidth="10"
          strokeDasharray={circumference} strokeDashoffset={offset} strokeLinecap="round"
          style={{ transition: 'stroke-dashoffset 0.8s ease-out' }} />
      </svg>
      <div className="absolute flex flex-col items-center justify-center">
        <p className="text-4xl font-extrabold" style={{ color: progressColor }}>{percentage}%</p>
        <p className="text-sm font-semibold mt-1" style={{ color: COLORS.DARK_TEXT, opacity: 0.7 }}>Completed</p>
      </div>
    </div>
  );
};

const formatTime = (timeStr) => {
  if (!timeStr || timeStr.length !== 4) return timeStr;
  const hours = parseInt(timeStr.substring(0, 2), 10);
  const minutes = timeStr.substring(2, 4);
  const ampm = hours >= 12 ? 'PM' : 'AM';
  const displayHours = hours % 12 || 12;
  return `${displayHours}:${minutes} ${ampm}`;
};

/** ---------------------------------------
 * Auth Login Card
 * -------------------------------------- */
const LoginPage = ({ handleLogin, error }) => (
  <div className="flex flex-col items-center justify-center min-h-screen p-8" style={{ backgroundColor: COLORS.MAIN_BG }}>
    <div className="max-w-md w-full p-10 rounded-3xl shadow-2xl text-center" style={{ backgroundColor: COLORS.LIGHT_BG }}>
      <h1 className="text-5xl font-extrabold mb-4" style={{ color: COLORS.PRIMARY_ACCENT }}>Health Navigator</h1>
      <p className="text-lg mb-8" style={{ color: COLORS.DARK_TEXT, opacity: 0.8 }}>
        Sign in to manage your medication reminders and connect your activity data from Google Fit.
      </p>

      {error && !error.type && (
        <div className="p-4 rounded-xl mb-4" style={{ backgroundColor: '#FFE5E5', color: '#CC0000', border: '1px solid #CC0000' }}>
          Error: {typeof error === 'string' ? error : JSON.stringify(error)}
        </div>
      )}

      <button
        onClick={handleLogin}
        className="w-full py-4 text-white text-xl font-bold rounded-xl transition duration-200 shadow-lg hover:brightness-90 flex items-center justify-center"
        style={{ backgroundColor: COLORS.PRIMARY_ACCENT }}
      >
        <img
          src="https://www.gstatic.com/images/icons/material/system/2x/google_white_24dp.png"
          alt="Google icon"
          className="w-6 h-6 mr-3"
        />
        Sign In with Google & Connect Fit
      </button>

      <p className="mt-4 text-xs" style={{ color: COLORS.DARK_TEXT, opacity: 0.6 }}>
        You will be redirected to Google to authorize access to your Fit activity, sleep, and heart-rate data.
      </p>
    </div>
  </div>
);

/** ---------------------------------------
 * Networking helper
 * -------------------------------------- */
const exponentialBackoffFetch = async (url, options, maxRetries = 3) => {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await fetch(url, options);
      if (!response.ok) {
        if (response.status === 429 && i < maxRetries - 1) {
          const delay = Math.pow(2, i) * 1000 + Math.random() * 1000;
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      return response;
    } catch (error) {
      if (i === maxRetries - 1) throw error;
    }
  }
  throw new Error("Failed to fetch after multiple retries.");
};

/** ---------------------------------------
 * Main App
 * -------------------------------------- */
const App = () => {
  // Firebase & core state
  const [db, setDb] = useState(null);
  const [auth, setAuth] = useState(null);
  const [userId, setUserId] = useState(null);
  const [medications, setMedications] = useState([]);
  const [newMedication, setNewMedication] = useState({ name: '', dose: '', times: ['08:00'] });
  const [isAdding, setIsAdding] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const [activeTab, setActiveTab] = useState('reminders');

  // Chatbot
  const [chatHistory, setChatHistory] = useState([
    { role: 'model', text: 'Hello! I am your Health Navigator chatbot. I can provide general information on medications, conditions, and health topics using Google Search for the latest context. Always consult a professional for medical advice!', sources: [] }
  ]);
  const [chatInput, setChatInput] = useState('');
  const [isChatLoading, setIsChatLoading] = useState(false);

  // Google Fit auth token
  const [googleAccessToken, setGoogleAccessToken] = useState(null);

  // Health metrics
  const [stepCount, setStepCount] = useState(null);
  const [sleepHours, setSleepHours] = useState(null);
  const [calories, setCalories] = useState(null);
  const [distance, setDistance] = useState(null); // km
  const [heartRate, setHeartRate] = useState(null);

  // Loading flags
  const [isStepsLoading, setIsStepsLoading] = useState(false);
  const [isSleepLoading, setIsSleepLoading] = useState(false);
  const [isCaloriesLoading, setIsCaloriesLoading] = useState(false);
  const [isDistanceLoading, setIsDistanceLoading] = useState(false);
  const [isHeartRateLoading, setIsHeartRateLoading] = useState(false);
  const [isSyncingAll, setIsSyncingAll] = useState(false);

  // Assessment
  const [assessmentResult, setAssessmentResult] = useState(null);
  const [isAssessmentLoading, setIsAssessmentLoading] = useState(false);

  /** ----------------------------
   * Firebase init & auth
   * --------------------------- */
  useEffect(() => {
    try {
      const isConfigMissing = !firebaseConfig.apiKey;
      if (isConfigMissing) {
        if (isLocalRun) {
          setError("DATABASE/AUTH ERROR: Please update FIREBASE_LOCAL_CONFIG in App.jsx for local persistence.");
        } else {
          setError("Failed to initialize the app due to missing config.");
        }
        setDb(null);
        setAuth(null);
        setUserId(crypto.randomUUID());
        setIsLoading(false);
        return;
      }

      const app = initializeApp(firebaseConfig);
      const firestore = getFirestore(app);
      const authentication = getAuth(app);

      setDb(firestore);
      setAuth(authentication);

      const unsubscribeAuth = onAuthStateChanged(authentication, async (user) => {
        if (user) {
          setUserId(user.uid);
          setIsLoading(false);
        } else {
          if (initialAuthToken) {
            await signInWithCustomToken(authentication, initialAuthToken);
          } else {
            const anonUser = await signInAnonymously(authentication);
            setUserId(anonUser.user.uid);
          }
          setIsLoading(false);
        }
      });

      return () => unsubscribeAuth();
    } catch (e) {
      console.error("Firebase Initialization Error:", e);
      setError("Failed to initialize the app. Check console for details.");
      setIsLoading(false);
    }
  }, [isLocalRun]);

  /** ----------------------------
   * Firestore listener
   * --------------------------- */
  useEffect(() => {
    if (!db || !userId) return;
    const medCollectionRef = collection(db, `/artifacts/${appId}/users/${userId}/medications`);
    const q = query(medCollectionRef);
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const meds = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      setMedications(meds);
    }, () => {
      if (auth?.currentUser) {
        setError("Failed to fetch medication data in real-time. (Check security rules or console)");
      }
    });
    return () => unsubscribe();
  }, [db, userId, auth]);

  /** ----------------------------
   * OAuth Login
   * --------------------------- */
  const handleLogin = () => {
    const redirectUri = window.location.origin;
    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
      `client_id=${GOOGLE_CLIENT_ID}&` +
      `redirect_uri=${redirectUri}&` +
      `response_type=token&` +
      // NOTE: add heart_rate scope
      `scope=${encodeURIComponent([
        'https://www.googleapis.com/auth/fitness.activity.read',
        'https://www.googleapis.com/auth/fitness.sleep.read',
        'https://www.googleapis.com/auth/fitness.heart_rate.read'
      ].join(' '))}&` +
      `state=google-fit-connect`;
    window.location.href = authUrl;
  };

  // Parse access token from URL
  useEffect(() => {
    if (window.location.hash) {
      const hash = window.location.hash.substring(1);
      const params = hash.split('&').reduce((acc, part) => {
        const [key, value] = part.split('=');
        if (key && value) acc[decodeURIComponent(key)] = decodeURIComponent(value);
        return acc;
      }, {});
      const accessToken = params['access_token'];
      const state = params['state'];
      if (accessToken && state === 'google-fit-connect') {
        setGoogleAccessToken(accessToken);
        setError({ type: 'success', message: 'Signed in with Google and connected to Fit successfully! Welcome.' });
        window.history.replaceState({}, document.title, window.location.pathname);
        setActiveTab('activity');
      }
    }
  }, []);

  /** ---------------------------------------
   * Helpers: consistent time window
   * -------------------------------------- */
  const getTodayWindow = () => {
    const now = Date.now();
    const oneDayMs = 24 * 60 * 60 * 1000;
    const tzOffset = new Date().getTimezoneOffset() * 60 * 1000; // ms
    const localMidnight = now - ((now - tzOffset) % oneDayMs); // local day start
    const LATENCY_BUFFER_MS = 2 * 60 * 1000;
    return {
      startTimeMillis: localMidnight,
      endTimeMillis: now - LATENCY_BUFFER_MS
    };
  };

  /** ---------------------------------------
   * Google Fit Fetchers
   * -------------------------------------- */
  const fetchSteps = useCallback(async () => {
    if (!googleAccessToken) { setError('Error: Google Fit Access Token is missing. Please sign in again.'); return 0; }
    setIsStepsLoading(true);
    const { startTimeMillis, endTimeMillis } = getTodayWindow();
    const body = {
      aggregateBy: [{
        dataTypeName: "com.google.step_count.delta",
        dataSourceId: "derived:com.google.step_count.delta:com.google.android.gms:estimated_steps"
      }],
      bucketByTime: { durationMillis: endTimeMillis - startTimeMillis },
      startTimeMillis, endTimeMillis
    };
    try {
      const res = await exponentialBackoffFetch('https://www.googleapis.com/fitness/v1/users/me/dataset:aggregate', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${googleAccessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      const steps = data.bucket?.[0]?.dataset?.[0]?.point?.[0]?.value?.[0]?.intVal;
      if (typeof steps === 'number') {
        setStepCount(steps);
        return steps;
      } else {
        setStepCount(0);
        setError('No step data found for today.');
        return 0;
      }
    } catch (e) {
      console.error(e);
      setStepCount(0);
      setError('Failed to fetch steps.');
      return 0;
    } finally {
      setIsStepsLoading(false);
    }
  }, [googleAccessToken]);

  const fetchSleep = useCallback(async () => {
    if (!googleAccessToken) { setError('Error: Google Fit Access Token is missing. Please sign in again.'); return 0; }
    setIsSleepLoading(true);
    const now = Date.now();
    const startTimeIso = new Date(now - 36 * 60 * 60 * 1000).toISOString();
    const endTimeIso = new Date(now).toISOString();
    const sessionsUrl = `https://www.googleapis.com/fitness/v1/users/me/sessions?startTime=${startTimeIso}&endTime=${endTimeIso}&activityType=72`;
    try {
      const res = await exponentialBackoffFetch(sessionsUrl, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${googleAccessToken}`, 'Content-Type': 'application/json' }
      });
      const data = await res.json();
      const sleepSessions = data.session || [];
      if (!sleepSessions.length) {
        setSleepHours(0);
        setError('No sleep data found for the past 36 hours.');
        return 0;
      }
      const oneDayMs = 24 * 60 * 60 * 1000;
      const totalSleepMs = sleepSessions.reduce((total, s) => {
        if (s.endTimeMillis > (now - oneDayMs)) {
          return total + (s.endTimeMillis - s.startTimeMillis);
        }
        return total;
      }, 0);
      const hours = Math.round((totalSleepMs / (1000 * 60 * 60)) * 10) / 10;
      setSleepHours(hours);
      return hours;
    } catch (e) {
      console.error(e);
      setSleepHours(0);
      setError('Failed to fetch sleep data.');
      return 0;
    } finally {
      setIsSleepLoading(false);
    }
  }, [googleAccessToken]);

  // Calories (merged source) — matches Google Fit app totals
  const fetchCalories = useCallback(async () => {
    if (!googleAccessToken) { setError('Error: Google Fit Access Token is missing. Please sign in again.'); return 0; }
    setIsCaloriesLoading(true);
    const { startTimeMillis, endTimeMillis } = getTodayWindow();
    const body = {
      aggregateBy: [{
        dataTypeName: "com.google.calories.expended",
        dataSourceId: "derived:com.google.calories.expended:com.google.android.gms:merge_calories_expended"
      }],
      bucketByTime: { durationMillis: endTimeMillis - startTimeMillis },
      startTimeMillis, endTimeMillis
    };
    try {
      const res = await exponentialBackoffFetch('https://www.googleapis.com/fitness/v1/users/me/dataset:aggregate', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${googleAccessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      const kcal = data.bucket?.[0]?.dataset?.[0]?.point?.[0]?.value?.[0]?.fpVal;
      if (typeof kcal === 'number') {
        setCalories(Math.round(kcal));
        return kcal;
      } else {
        setCalories(0);
        setError('No calories data found for today.');
        return 0;
      }
    } catch (e) {
      console.error(e);
      setCalories(0);
      setError('Failed to fetch calories.');
      return 0;
    } finally {
      setIsCaloriesLoading(false);
    }
  }, [googleAccessToken]);

  // Distance (merged source) — fixes “0 km” mismatch
  const fetchDistance = useCallback(async () => {
    if (!googleAccessToken) { setError('Error: Google Fit Access Token is missing. Please sign in again.'); return 0; }
    setIsDistanceLoading(true);
    const { startTimeMillis, endTimeMillis } = getTodayWindow();
    const body = {
      aggregateBy: [{
        dataTypeName: "com.google.distance.delta",
        dataSourceId: "derived:com.google.distance.delta:com.google.android.gms:merge_distance_delta"
      }],
      bucketByTime: { durationMillis: endTimeMillis - startTimeMillis },
      startTimeMillis, endTimeMillis
    };
    try {
      const res = await exponentialBackoffFetch('https://www.googleapis.com/fitness/v1/users/me/dataset:aggregate', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${googleAccessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      const meters = data.bucket?.[0]?.dataset?.[0]?.point?.[0]?.value?.[0]?.fpVal;
      if (typeof meters === 'number') {
        const km = meters / 1000;
        setDistance(km.toFixed(2));
        return km;
      } else {
        setDistance(0);
        setError('No distance data found for today.');
        return 0;
      }
    } catch (e) {
      console.error(e);
      setDistance(0);
      setError('Failed to fetch distance.');
      return 0;
    } finally {
      setIsDistanceLoading(false);
    }
  }, [googleAccessToken]);

  // Heart rate — return latest sample seen in last 24h or show “no data” message
  const fetchHeartRate = useCallback(async () => {
    if (!googleAccessToken) { setError('Error: Google Fit Access Token is missing. Please sign in again.'); return null; }
    setIsHeartRateLoading(true);
    const now = Date.now();
    const startTimeMillis = now - 24 * 60 * 60 * 1000;
    const endTimeMillis = now - 60 * 1000; // 1-minute buffer

    const body = {
      aggregateBy: [{
        dataTypeName: "com.google.heart_rate.bpm",
        dataSourceId: "derived:com.google.heart_rate.bpm:com.google.android.gms:merge_heart_rate_bpm"
      }],
      bucketByTime: { durationMillis: 60 * 60 * 1000 }, // hourly buckets
      startTimeMillis, endTimeMillis
    };

    try {
      const res = await exponentialBackoffFetch('https://www.googleapis.com/fitness/v1/users/me/dataset:aggregate', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${googleAccessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await res.json();

      // find the most recent bucket that has at least one point
      let latestBpm = null;
      if (Array.isArray(data.bucket)) {
        for (let i = data.bucket.length - 1; i >= 0; i--) {
          const pts = data.bucket[i]?.dataset?.[0]?.point;
          if (Array.isArray(pts) && pts.length) {
            const lastPoint = pts[pts.length - 1];
            const v = lastPoint?.value?.[0]?.fpVal;
            if (typeof v === 'number') { latestBpm = Math.round(v); break; }
          }
        }
      }

      if (latestBpm !== null) {
        setHeartRate(latestBpm);
        return latestBpm;
      } else {
        setHeartRate(null);
        setError('No heart-rate data found in the last 24 hours (wearable not connected).');
        return null;
      }
    } catch (e) {
      console.error(e);
      setHeartRate(null);
      setError('Failed to fetch heart-rate.');
      return null;
    } finally {
      setIsHeartRateLoading(false);
    }
  }, [googleAccessToken]);

  // One-click sync (does all fetches, shows explicit messages)
  const syncAll = useCallback(async () => {
    setIsSyncingAll(true);
    setAssessmentResult(null);
    try {
      const results = await Promise.allSettled([
        fetchSteps(),
        fetchSleep(),
        fetchCalories(),
        fetchDistance(),
        fetchHeartRate()
      ]);

      // If every promise failed or returned empty values, show a generic banner
      const someData =
        (stepCount ?? 0) > 0 ||
        (sleepHours ?? 0) > 0 ||
        (calories ?? 0) > 0 ||
        (parseFloat(distance) ?? 0) > 0 ||
        (heartRate ?? null) !== null;

      if (!someData) {
        setError('Synced, but no metrics were available for today. Open Google Fit and sync your device, then try again.');
      } else {
        setError({ type: 'success', message: 'Synced today’s data successfully.' });
      }

      return results;
    } finally {
      setIsSyncingAll(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [googleAccessToken, stepCount, sleepHours, calories, distance, heartRate]);

  /** ---------------------------------------
   * Assessment (now uses all metrics)
   * -------------------------------------- */
  const callAssessmentAPI = useCallback(async () => {
    const apiKey = isLocalRun ? GEMINI_API_KEY : "";
    if (!apiKey) {
      setError("GEMINI API ERROR: Missing API Key in local run.");
      return;
    }
    setIsAssessmentLoading(true);

    const prompt = `
Analyze all available health metrics and provide a combined wellness analysis.

Metrics:
- Steps Today: ${stepCount ?? "N/A"}
- Sleep Hours: ${sleepHours ?? "N/A"}
- Calories Burned: ${calories ?? "N/A"}
- Distance Travelled: ${distance ?? "N/A"} km
- Heart Rate: ${heartRate ?? "N/A"} bpm

Give a professional health assessment considering activity level, recovery, cardiovascular load, and overall daily balance.
Provide 3 realistic, actionable recommendations.
`;

    const systemPrompt = `You are a direct, objective, and professional Wellness Analyst. Provide an honest, integrated assessment of the user's steps, sleep, calories, distance, and heart-rate data. Compare against reasonable goals (10k steps, ~7.5h sleep).`;

    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${apiKey}`;

    const payload = {
      contents: [{ parts: [{ text: prompt }] }],
      tools: [{ "google_search": {} }],
      systemInstruction: { parts: [{ text: systemPrompt }] },
    };

    try {
      const res = await exponentialBackoffFetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const result = await res.json();
      const candidate = result.candidates?.[0];
      let modelText = "Sorry, I couldn't generate a response. Please check the console for API errors.";
      let sources = [];

      if (candidate && candidate.content?.parts?.[0]?.text) {
        modelText = candidate.content.parts[0].text;
        const groundingMetadata = candidate.groundingMetadata;
        if (groundingMetadata?.groundingAttributions) {
          sources = groundingMetadata.groundingAttributions
            .map(a => ({ uri: a.web?.uri, title: a.web?.title }))
            .filter(s => s.uri && s.title);
        }
      } else if (result.error) {
        modelText = `API Error: ${result.error.message}.`;
      }
      setAssessmentResult({ text: modelText, sources });
    } catch (e) {
      console.error(e);
      setAssessmentResult({ text: `Error fetching assessment: Network error or API issue.`, sources: [] });
    } finally {
      setIsAssessmentLoading(false);
    }
  }, [isLocalRun, stepCount, sleepHours, calories, distance, heartRate]);
  
  /** ---------------------------------------
   * Chatbot API Call (FIXED/NEW)
   * -------------------------------------- */
  const callChatbotAPI = useCallback(async (newMessage) => {
    const apiKey = isLocalRun ? GEMINI_API_KEY : "";
    if (!apiKey) {
      setError("GEMINI API ERROR: Missing API Key in local run. Cannot chat.");
      return;
    }
    setIsChatLoading(true);

    // Prepare history for API call (limit and convert format)
    const contents = [...chatHistory, { role: 'user', text: newMessage }]
      .slice(-10) // Keep the last 10 messages for context
      .map(msg => ({
        role: msg.role === 'model' ? 'model' : 'user', // Ensure role consistency
        parts: [{ text: msg.text }]
      }));
      
    const systemInstruction = {
      parts: [{
        text: 'You are a helpful and professional Health Navigator chatbot. Provide general, non-diagnostic information on medications, conditions, and health topics. Always state that your advice is not a substitute for professional medical consultation. Use Google Search for up-to-date context.'
      }]
    };

    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${apiKey}`;

    const payload = {
      contents: contents,
      tools: [{ "google_search": {} }],
      systemInstruction: systemInstruction,
    };

    try {
      const res = await exponentialBackoffFetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const result = await res.json();
      const candidate = result.candidates?.[0];
      let modelText = "Sorry, I couldn't generate a response. Please check the console for API errors.";
      
      if (candidate && candidate.content?.parts?.[0]?.text) {
        modelText = candidate.content.parts[0].text;
      } else if (result.error) {
        modelText = `API Error: ${result.error.message}.`;
      }
      
      setChatHistory(prev => [...prev, { role: 'model', text: modelText, sources: [] }]);
    } catch (e) {
      console.error("Chatbot API Error:", e);
      setChatHistory(prev => [...prev, { role: 'model', text: `Error fetching response: Network error or API issue.`, sources: [] }]);
    } finally {
      setIsChatLoading(false);
    }
  }, [isLocalRun, chatHistory]);

  /** ---------------------------------------
   * Meds CRUD (unchanged)
   * -------------------------------------- */
  const handleNewMedChange = (e) => {
    const { name, value } = e.target;
    setNewMedication(prev => ({ ...prev, [name]: value }));
  };
  const handleTimeChange = (index, value) => {
    const cleanValue = value.replace(':', '').slice(0, 4);
    setNewMedication(prev => {
      const newTimes = [...prev.times];
      newTimes[index] = value;
      return { ...prev, times: newTimes };
    });
  };
  const handleAddTime = () => setNewMedication(prev => ({ ...prev, times: [...prev.times, '08:00'] }));
  const handleRemoveTime = (indexToRemove) => setNewMedication(prev => ({ ...prev, times: prev.times.filter((_, i) => i !== indexToRemove) }));

  const handleSaveMedication = async () => {
    const isConfigMissing = !firebaseConfig.apiKey;
    if (!db || !userId) {
      if (isLocalRun && isConfigMissing) {
        setError("Database Error: Provide Firebase config in FIREBASE_LOCAL_CONFIG to enable persistence.");
      } else {
        setError("Database not ready. Please wait for initialization or check Firebase setup.");
      }
      return;
    }
    if (!newMedication.name.trim() || !newMedication.dose.trim() || newMedication.times.every(t => !t.trim())) {
      setError('Please enter a name, dose, and at least one time.');
      return;
    }
    const validTimes = newMedication.times
      .map(t => t.trim())
      .filter(t => t.match(/^\d{2}:\d{2}$/))
      .map(t => t.replace(':', ''))
      .sort();
    if (validTimes.length === 0) { setError('Use the time picker to select valid times.'); return; }

    const medicationData = {
      name: newMedication.name.trim(),
      dose: newMedication.dose.trim(),
      times: validTimes,
      createdAt: Date.now()
    };

    try {
      const medCollectionRef = collection(db, `/artifacts/${appId}/users/${userId}/medications`);
      await addDoc(medCollectionRef, medicationData);
      setNewMedication({ name: '', dose: '', times: ['08:00'] });
      setIsAdding(false);
      setError(null);
    } catch (e) {
      console.error("Error adding document: ", e);
      setError(`Failed to save medication: ${e.message}.`);
    }
  };

  const handleDeleteMedication = async (id) => {
    if (!db) return;
    const medDocRef = doc(db, `/artifacts/${appId}/users/${userId}/medications`, id);
    try { await deleteDoc(medDocRef); }
    catch (e) { console.error("Error deleting document: ", e); setError("Failed to delete medication."); }
  };

  const todaySchedule = medications
    .flatMap(med => med.times.map(time => ({
      time: time,
      medName: med.name,
      dose: med.dose,
      medId: med.id,
      key: med.id + time,
    })))
    .sort((a, b) => a.time.localeCompare(b.time));

  /** ---------------------------------------
   * Renderers
   * -------------------------------------- */
  const renderMedicationForm = () => (
    <div className="p-6 rounded-xl space-y-4 shadow-lg" style={{ backgroundColor: COLORS.LIGHT_BG }}>
      <h3 className="text-lg font-semibold" style={{ color: COLORS.DARK_TEXT }}>Add New Medication</h3>

      <input
        type="text" name="name" value={newMedication.name} onChange={handleNewMedChange}
        placeholder="Medication Name (e.g., Vitamin D)"
        className="w-full p-3 border rounded-lg placeholder-gray-500 focus:outline-none focus:ring-2"
        style={{ borderColor: COLORS.SECONDARY_ACCENT, backgroundColor: COLORS.MAIN_BG, color: COLORS.DARK_TEXT }}
      />
      <input
        type="text" name="dose" value={newMedication.dose} onChange={handleNewMedChange}
        placeholder="Dose (e.g., 1000 IU or 1 tab)"
        className="w-full p-3 border rounded-lg placeholder-gray-500 focus:outline-none focus:ring-2"
        style={{ borderColor: COLORS.SECONDARY_ACCENT, backgroundColor: COLORS.MAIN_BG, color: COLORS.DARK_TEXT }}
      />

      <div>
        <label className="block text-sm font-medium mb-2" style={{ color: COLORS.DARK_TEXT }}>Daily Schedule Times</label>
        <div className="flex flex-wrap gap-3 items-center">
          {newMedication.times.map((time, index) => (
            <div key={`time-input-${index}`} className="flex items-center space-x-2">
              <input
                type="time" value={time} onChange={(e) => handleTimeChange(index, e.target.value)}
                className="w-28 p-2 border rounded-lg text-center appearance-none"
                style={{ borderColor: COLORS.SECONDARY_ACCENT, backgroundColor: COLORS.MAIN_BG, color: COLORS.DARK_TEXT }}
              />
              <button
                onClick={() => handleRemoveTime(index)}
                className="transition duration-150 p-1 rounded-full hover:bg-red-100"
                style={{ color: COLORS.PRIMARY_ACCENT }} aria-label="Remove time"
              >
                <X size={16} />
              </button>
            </div>
          ))}
          <button
            onClick={handleAddTime}
            className="flex items-center transition duration-150 p-2 rounded-full border"
            style={{ color: COLORS.PRIMARY_ACCENT, borderColor: COLORS.PRIMARY_ACCENT }}
          >
            <Plus size={16} className="mr-1" /> Add Time
          </button>
        </div>
      </div>

      <div className="pt-4 flex justify-end">
        <button
          onClick={handleSaveMedication}
          className="flex items-center px-6 py-3 text-white font-semibold rounded-xl shadow-md transition duration-200 hover:opacity-90"
          style={{ backgroundColor: COLORS.PRIMARY_ACCENT }}
        >
          <Bell size={20} className="mr-2" /> Save Medication
        </button>
      </div>
    </div>
  );

  const renderRemindersTab = () => (
    <div className="space-y-8">
      <div className="flex justify-between items-center pb-4 border-b" style={{ borderColor: COLORS.SECONDARY_ACCENT }}>
        <h2 className="text-3xl font-bold" style={{ color: COLORS.DARK_TEXT }}>Medication Reminders</h2>
        <button
          onClick={() => setIsAdding(!isAdding)}
          className="flex items-center px-4 py-2 text-white rounded-xl shadow-md transition duration-200 hover:opacity-90"
          style={{ backgroundColor: COLORS.PRIMARY_ACCENT }}
        >
          {isAdding ? <X size={20} className="mr-2" /> : <Plus size={20} className="mr-2" />}
          {isAdding ? 'Close Form' : 'Add New Medication'}
        </button>
      </div>

      {isAdding && renderMedicationForm()}

      <div className="space-y-4">
        <h3 className="text-2xl font-bold flex items-center" style={{ color: COLORS.PRIMARY_ACCENT }}>
          <Calendar size={24} className="mr-2" />
          Today's Schedule ({todaySchedule.length} items)
        </h3>
        {isLoading ? (
          <LoadingSpinner />
        ) : todaySchedule.length === 0 ? (
          <p style={{ color: COLORS.DARK_TEXT, opacity: 0.6 }} className="italic">No medications set yet. Add one above!</p>
        ) : (
          <div className="space-y-3">
            {todaySchedule.map(item => (
              <div key={item.key} className="flex items-center justify-between p-4 rounded-xl shadow-md transition duration-200 hover:shadow-lg"
                style={{ backgroundColor: COLORS.LIGHT_BG, borderLeft: `4px solid ${COLORS.PRIMARY_ACCENT}` }}>
                <div className="flex items-center space-x-4">
                  <div className="text-3xl font-mono flex items-center" style={{ color: COLORS.PRIMARY_ACCENT }}>
                    <Clock size={20} className="mr-2" />
                    {formatTime(item.time)}
                  </div>
                  <div>
                    <p className="text-lg font-semibold" style={{ color: COLORS.DARK_TEXT }}>{item.medName}</p>
                    <p className="text-sm" style={{ color: COLORS.DARK_TEXT, opacity: 0.7 }}>Dose: {item.dose}</p>
                  </div>
                </div>
                <div className="flex space-x-2">
                  <button
                    onClick={() => handleDeleteMedication(item.medId)}
                    className="p-2 rounded-full transition duration-150 hover:bg-red-100"
                    style={{ color: COLORS.SECONDARY_ACCENT }} aria-label="Delete medication"
                  >
                    <Trash2 size={20} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="space-y-4 pt-4 border-t" style={{ borderColor: COLORS.SECONDARY_ACCENT }}>
        <h3 className="text-2xl font-bold" style={{ color: COLORS.DARK_TEXT }}>All Medications</h3>
        {medications.length === 0 ? (
          <p style={{ color: COLORS.DARK_TEXT, opacity: 0.6 }} className="italic">You have no saved medications.</p>
        ) : (
          <div className="space-y-2">
            {medications.map(med => (
              <div key={med.id} className="p-4 rounded-xl shadow-md flex justify-between items-center transition duration-200" style={{ backgroundColor: COLORS.LIGHT_BG }}>
                <div>
                  <p className="text-lg font-semibold" style={{ color: COLORS.DARK_TEXT }}>{med.name}</p>
                  <p className="text-sm" style={{ color: COLORS.DARK_TEXT, opacity: 0.7 }}>Dose: {med.dose}</p>
                  <p className="text-xs mt-1" style={{ color: COLORS.DARK_TEXT, opacity: 0.5 }}>Times: {med.times.map(formatTime).join(', ')}</p>
                </div>
                <button
                  onClick={() => handleDeleteMedication(med.id)}
                  className="p-2 rounded-full transition duration-150 hover:bg-red-100"
                  style={{ color: COLORS.SECONDARY_ACCENT }} aria-label="Delete medication"
                >
                  <Trash2 size={20} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );

  const renderActivityTab = () => (
    <div className="p-6 space-y-6">
      <h2 className="text-3xl font-bold border-b pb-3" style={{ color: COLORS.DARK_TEXT, borderColor: COLORS.SECONDARY_ACCENT }}>
        <Activity size={32} className="inline mr-2" style={{ color: COLORS.PRIMARY_ACCENT }} />
        Google Fit Activity
      </h2>

      <div className="p-6 rounded-xl shadow-md space-y-4" style={{ backgroundColor: COLORS.MAIN_BG, border: `1px solid ${COLORS.SECONDARY_ACCENT}` }}>
        <div className="text-center p-3 rounded-lg" style={{ backgroundColor: COLORS.LIGHT_BG }}>
          <p className="font-semibold" style={{ color: COLORS.PRIMARY_ACCENT }}>Connected to Google Fit!</p>
          <p className="text-xs" style={{ color: COLORS.DARK_TEXT, opacity: 0.7 }}>Your activity data is accessible.</p>
        </div>

        {/* One-click sync */}
        <div className="flex flex-col sm:flex-row justify-center gap-3">
          <button
            onClick={!isSyncingAll ? syncAll : undefined}
            className={`flex-1 py-3 text-white font-bold rounded-xl transition duration-200 shadow-md ${isSyncingAll ? "opacity-70 pointer-events-none" : "hover:opacity-90"}`}
            style={{ backgroundColor: COLORS.PRIMARY_ACCENT }}
          >
            {isSyncingAll ? "Syncing Today’s Data..." : "Sync Today’s Data (All)"}
          </button>

          <button
            onClick={!isAssessmentLoading ? callAssessmentAPI : undefined}
            className={`flex-1 py-3 text-white font-bold rounded-xl transition duration-200 shadow-md ${isAssessmentLoading ? "opacity-70 pointer-events-none" : "hover:opacity-90"}`}
            style={{ backgroundColor: COLORS.PRIMARY_ACCENT }}
            disabled={
              isAssessmentLoading ||
              (stepCount ?? null) === null &&
              (sleepHours ?? null) === null &&
              (calories ?? null) === null &&
              (distance ?? null) === null &&
              (heartRate ?? null) === null
            }
          >
            {isAssessmentLoading ? 'Analyzing…' : 'Get AI Assessment'}
          </button>
        </div>

        {/* Metrics Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 pt-6 border-t" style={{ borderColor: COLORS.SECONDARY_ACCENT }}>
          {stepCount !== null && (
            <div className="flex flex-col items-center justify-center">
              <StepCompletionRing steps={stepCount} goal={DAILY_STEP_GOAL} size={180} />
              <div className="mt-4 text-center">
                <p className="text-3xl font-extrabold" style={{ color: COLORS.DARK_TEXT }}>
                  {stepCount.toLocaleString()} Steps
                </p>
                <p className="text-sm" style={{ color: COLORS.PRIMARY_ACCENT }}>
                  Daily Goal: {DAILY_STEP_GOAL.toLocaleString()} steps
                </p>
              </div>
            </div>
          )}

          {sleepHours !== null && (
            <div className="flex flex-col items-center justify-center p-4">
              <div className={`w-40 h-40 rounded-full flex flex-col items-center justify-center border-4 ${sleepHours < RECOMMENDED_SLEEP_HOURS ? 'border-red-400' : 'border-green-500'}`}
                style={{ backgroundColor: COLORS.MAIN_BG }}>
                <Moon size={40} className="mb-2" style={{ color: sleepHours < RECOMMENDED_SLEEP_HOURS ? '#CC0000' : '#38A169' }} />
                <p className="text-4xl font-extrabold" style={{ color: COLORS.DARK_TEXT }}>
                  {sleepHours}h
                </p>
              </div>
              <div className="mt-4 text-center">
                <p className="text-3xl font-extrabold" style={{ color: COLORS.DARK_TEXT }}>Sleep</p>
                <p className="text-sm" style={{ color: COLORS.PRIMARY_ACCENT }}>Recommended: {RECOMMENDED_SLEEP_HOURS} hours</p>
              </div>
            </div>
          )}

          {calories !== null && (
            <div className="flex flex-col items-center justify-center p-6 rounded-2xl shadow-lg"
              style={{ backgroundColor: COLORS.MAIN_BG, border: `3px solid ${COLORS.SECONDARY_ACCENT}` }}>
              <p className="text-5xl font-extrabold" style={{ color: COLORS.PRIMARY_ACCENT }}>{calories} kcal</p>
              <p className="mt-2 text-xl font-semibold" style={{ color: COLORS.DARK_TEXT }}>Calories Burned Today</p>
            </div>
          )}

          {distance !== null && (
            <div className="flex flex-col items-center justify-center p-6 rounded-2xl shadow-lg"
              style={{ backgroundColor: COLORS.MAIN_BG, border: `3px solid ${COLORS.SECONDARY_ACCENT}` }}>
              <p className="text-5xl font-extrabold" style={{ color: COLORS.PRIMARY_ACCENT }}>{distance} km</p>
              <p className="mt-2 text-xl font-semibold" style={{ color: COLORS.DARK_TEXT }}>Distance Travelled</p>
            </div>
          )}

          {heartRate !== null && (
            <div className="flex flex-col items-center justify-center p-6 rounded-2xl shadow-lg"
              style={{ backgroundColor: COLORS.MAIN_BG, border: `3px solid ${COLORS.SECONDARY_ACCENT}` }}>
              <Heart size={48} style={{ color: COLORS.PRIMARY_ACCENT }} />
              <p className="text-5xl font-extrabold mt-2" style={{ color: COLORS.DARK_TEXT }}>{heartRate} bpm</p>
              <p className="mt-2 text-xl font-semibold" style={{ color: COLORS.DARK_TEXT }}>Latest Heart Rate</p>
            </div>
          )}

          {(stepCount === null && sleepHours === null && calories === null && distance === null && heartRate === null) && (
            <p className="col-span-3 text-center italic" style={{ color: COLORS.DARK_TEXT, opacity: 0.6 }}>
              Tap “Sync Today’s Data” to fetch your activity overview.
            </p>
          )}
        </div>
      </div>

      {(isAssessmentLoading || assessmentResult) && (
        <div className="mt-6 p-6 rounded-xl shadow-xl" style={{ backgroundColor: COLORS.LIGHT_BG }}>
          <h3 className="text-2xl font-bold flex items-center mb-4" style={{ color: COLORS.DARK_TEXT }}>
            <MessageSquare size={24} className="mr-2" style={{ color: COLORS.PRIMARY_ACCENT }} />
            Activity Analyst Report
          </h3>

          {isAssessmentLoading && <LoadingSpinner />}

          {assessmentResult && !isAssessmentLoading && (
            <div className="space-y-4">
              <div className="prose max-w-none text-base leading-relaxed" style={{ color: COLORS.DARK_TEXT, whiteSpace: 'pre-wrap', lineHeight: '1.7' }}
                dangerouslySetInnerHTML={{
                  __html: assessmentResult.text
                    .replace(/^### (.*$)/gim, '<h3>$1</h3>')
                    .replace(/^## (.*$)/gim, '<h2>$1</h2>')
                    .replace(/^# (.*$)/gim, '<h1>$1</h1>')
                    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
                    .replace(/\*(.*?)\*/g, '<em>$1</em>')
                    .replace(/^\s*[-•]\s+(.*)$/gim, '<li>$1</li>')
                    .replace(/(<li>.*<\/li>)/gim, '<ul>$1</ul>')
                    .replace(/\n{2,}/g, '</p><p>')
                    .replace(/\n/g, '<br/>')
                }}
              />

              {assessmentResult.sources && assessmentResult.sources.length > 0 && (
                <div className="mt-4 text-sm pt-3 border-t" style={{ borderColor: COLORS.SECONDARY_ACCENT }}>
                  <p className="font-semibold mb-1" style={{ color: COLORS.DARK_TEXT, opacity: 0.8 }}>Sources:</p>
                  <div className="space-y-1">
                    {assessmentResult.sources.map((source, idx) => (
                      <a key={idx} href={source.uri} target="_blank" rel="noopener noreferrer" className="flex items-center break-words hover:underline" style={{ color: COLORS.SECONDARY_ACCENT }}>
                        <Link size={12} className="mr-1 flex-shrink-0" />
                        <span className="truncate">{source.title}</span>
                      </a>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );

  const renderChatbotTab = () => (
    <div className="flex flex-col h-[70vh] p-6 rounded-xl shadow-lg" style={{ backgroundColor: COLORS.LIGHT_BG }}>
      <h2 className="text-3xl font-bold border-b pb-3 mb-4" style={{ color: COLORS.DARK_TEXT, borderColor: COLORS.SECONDARY_ACCENT }}>Health Chatbot</h2>
      <div className="flex-grow overflow-y-auto space-y-4 pr-2">
        {chatHistory.map((msg, index) => (
          <div key={index} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-3xl p-4 rounded-xl shadow-md ${msg.role === 'user' ? 'text-white rounded-br-none' : 'rounded-tl-none'}`}
              style={{
                backgroundColor: msg.role === 'user' ? COLORS.PRIMARY_ACCENT : COLORS.MAIN_BG,
                color: msg.role === 'user' ? 'white' : COLORS.DARK_TEXT,
                border: msg.role !== 'user' ? `1px solid ${COLORS.SECONDARY_ACCENT}` : 'none'
              }}
            >
              <p className="whitespace-pre-wrap">{msg.text}</p>
            </div>
          </div>
        ))}
        {isChatLoading && (
          <div className="flex justify-start">
            <div className="p-4 rounded-xl shadow-md rounded-tl-none" style={{ backgroundColor: COLORS.MAIN_BG, border: `1px solid ${COLORS.SECONDARY_ACCENT}` }}>
              <LoadingSpinner />
            </div>
          </div>
        )}
      </div>
      <form onSubmit={(e) => {
        e.preventDefault();
        const message = chatInput.trim();
        if (!message) return;
        
        // 1. Add user message to history
        setChatHistory(prev => [...prev, { role: 'user', text: message, sources: [] }]);
        const currentMessage = message; // Capture the current message before state clear
        setChatInput('');
        
        // 2. Call the API
        callChatbotAPI(currentMessage);
      }} className="flex space-x-3 mt-4">
        <input
          type="text" value={chatInput} onChange={(e) => setChatInput(e.target.value)}
          placeholder="Ask a health question"
          className="flex-grow p-3 border rounded-xl placeholder-gray-500 focus:outline-none focus:ring-2"
          style={{ borderColor: COLORS.SECONDARY_ACCENT, backgroundColor: COLORS.MAIN_BG, color: COLORS.DARK_TEXT }}
        />
        <button
          type="submit"
          disabled={!chatInput.trim() || isChatLoading}
          className={`px-6 py-3 rounded-xl shadow-md transition duration-200 flex items-center text-white ${chatInput.trim() && !isChatLoading ? 'hover:opacity-90' : 'opacity-50 cursor-not-allowed'}`}
          style={{ backgroundColor: COLORS.PRIMARY_ACCENT }}
        >
          <Send size={20} className="mr-1" /> Send
        </button>
      </form>
    </div>
  );

  /** ---------------------------------------
   * Error banner
   * -------------------------------------- */
  const renderError = () => {
    if (!error) return null;
    const isSuccess = typeof error === 'object' && error.type === 'success';
    const messageText = isSuccess ? error.message : (typeof error === 'string' ? error : JSON.stringify(error));
    const bgColor = isSuccess ? '#E6FFFA' : '#FFE5E5';
    const textColor = isSuccess ? '#38A169' : '#CC0000';
    const borderColor = isSuccess ? '#81E6D9' : '#CC0000';
    return (
      <div className="p-4 rounded-xl mb-6 flex items-center justify-between" style={{ backgroundColor: bgColor, color: textColor, border: `1px solid ${borderColor}` }}>
        <span>{isSuccess ? 'Success: ' : 'Error: '}{messageText}</span>
        <button onClick={() => setError(null)} className="hover:opacity-70" style={{ color: textColor }}><X size={20} /></button>
      </div>
    );
  };

  /** ---------------------------------------
   * Render
   * -------------------------------------- */
  if (!googleAccessToken) return <LoginPage handleLogin={handleLogin} error={error} />;

  return (
    <div className="min-h-screen p-4 sm:p-8 font-sans" style={{ backgroundColor: COLORS.MAIN_BG, color: COLORS.DARK_TEXT }}>
      <div className="max-w-5xl mx-auto">
        <div className="flex flex-col sm:flex-row justify-between items-center mb-6 border-b pb-4" style={{ borderColor: COLORS.SECONDARY_ACCENT }}>
          <h1 className="text-4xl font-extrabold mb-4 sm:mb-0" style={{ color: COLORS.PRIMARY_ACCENT }}>Health Navigator</h1>
          <div className="flex space-x-2 p-1 rounded-xl shadow-inner" style={{ backgroundColor: COLORS.LIGHT_BG }}>
            <button
              onClick={() => setActiveTab('reminders')}
              className={`flex items-center px-4 py-2 rounded-lg font-medium transition duration-200 ${activeTab === 'reminders' ? 'text-white shadow-md' : 'hover:opacity-80'}`}
              style={{ backgroundColor: activeTab === 'reminders' ? COLORS.PRIMARY_ACCENT : 'transparent', color: activeTab === 'reminders' ? 'white' : COLORS.DARK_TEXT }}
            >
              <Bell size={20} className="mr-2" /> Reminders
            </button>
            <button
              onClick={() => setActiveTab('activity')}
              className={`flex items-center px-4 py-2 rounded-lg font-medium transition duration-200 ${activeTab === 'activity' ? 'text-white shadow-md' : 'hover:opacity-80'}`}
              style={{ backgroundColor: activeTab === 'activity' ? COLORS.PRIMARY_ACCENT : 'transparent', color: activeTab === 'activity' ? 'white' : COLORS.DARK_TEXT }}
            >
              <Activity size={20} className="mr-2" /> Activity
            </button>
            <button
              onClick={() => setActiveTab('chatbot')}
              className={`flex items-center px-4 py-2 rounded-lg font-medium transition duration-200 ${activeTab === 'chatbot' ? 'text-white shadow-md' : 'hover:opacity-80'}`}
              style={{ backgroundColor: activeTab === 'chatbot' ? COLORS.PRIMARY_ACCENT : 'transparent', color: activeTab === 'chatbot' ? 'white' : COLORS.DARK_TEXT }}
            >
              <MessageSquare size={20} className="mr-2" /> Chatbot
            </button>
          </div>
        </div>

        {userId && (
          <p className="text-xs mb-6 p-2 rounded-lg break-all" style={{ backgroundColor: COLORS.LIGHT_BG, color: COLORS.DARK_TEXT, opacity: 0.7 }}>
            Current User ID (for sharing/debug): <span className="font-mono">{userId}</span>
          </p>
        )}

        {renderError()}

        <div className="p-6 rounded-3xl shadow-2xl min-h-[60vh]" style={{ backgroundColor: COLORS.LIGHT_BG }}>
          {activeTab === 'reminders' && renderRemindersTab()}
          {activeTab === 'activity' && renderActivityTab()}
          {activeTab === 'chatbot' && renderChatbotTab()}
        </div>
      </div>
    </div>
  );
};

export default App;