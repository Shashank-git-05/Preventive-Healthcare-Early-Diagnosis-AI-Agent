import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, collection, query, onSnapshot, addDoc, doc, deleteDoc } from 'firebase/firestore';
import { Plus, X, Trash2, Calendar, Clock, MessageSquare, Bell, Send, Link, Activity, Heart, Moon } from 'lucide-react';
import { getAnalytics } from "firebase/analytics";

// --- Configuration for Local vs. Sandbox Environment ---

// This flag determines if the app is running locally (true) or in the Canvas environment (false)
const isLocalRun = typeof __initial_auth_token === 'undefined';

// 1. FIREBASE LOCAL CONFIG (Required if isLocalRun is true):
// >>>>>> PASTE YOUR ACTUAL FIREBASE CONFIGURATION OBJECT HERE <<<<<<
const FIREBASE_LOCAL_CONFIG = {
    apiKey: "AIzaSyAdR5AX4GyipuN1OJZew9wxjzsUawMLovU",
    authDomain: "health-navigator-cb1e9.firebaseapp.com",
    projectId: "health-navigator-cb1e9",
    storageBucket: "health-navigator-cb1e9.firebasestorage.app",
    messagingSenderId: "320930192297",
    appId: "1:320930192297:web:b3ad8eaeabdf18330782b8",
    measurementId: "G-N2FRL54GFF" // Added the measurementId you provided
};

// 2. GEMINI API KEY (Required if isLocalRun is true to enable chatbot):
// !!! REPLACE THIS PLACEHOLDER KEY WITH YOUR ACTUAL KEY !!!
const GEMINI_API_KEY = "AIzaSyA_pbiHyj43tARucPRcUtwcQxMkOnDi_bw"; 

// 3. GOOGLE FIT OAUTH CLIENT ID (Required if isLocalRun is true to connect to Google Fit):
// IMPORTANT: YOU MUST PASTE YOUR GOOGLE OAUTH CLIENT ID HERE.
const GOOGLE_CLIENT_ID = '372260688523-1o2r51dmk1vrq98i9pjktnqh94q0a28d.apps.googleusercontent.com'; // <--- VERIFY THIS VALUE!

// Final configuration logic (uses injected values if available, otherwise falls back to local constants)
const appId = (typeof __app_id !== 'undefined' ? __app_id : 'local-health-app').replace(/[\/.]/g, '-');
const initialAuthToken = typeof __initial_auth_token !== 'undefined' ? __initial_auth_token : null;

const firebaseConfig = isLocalRun
    ? FIREBASE_LOCAL_CONFIG
    : (typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : {});


// --- Health Constants ---
const DAILY_STEP_GOAL = 10000; // Standard daily step goal
const RECOMMENDED_SLEEP_HOURS = 7.5; // Recommended sleep duration

// --- API Helper for Robustness ---
const exponentialBackoffFetch = async (url, options, maxRetries = 3) => {
    for (let i = 0; i < maxRetries; i++) {
        try {
            const response = await fetch(url, options);
            if (!response.ok) {
                if (response.status === 429 && i < maxRetries - 1) {
                    const delay = Math.pow(2, i) * 1000 + Math.random() * 1000;
                    await new Promise(resolve => setTimeout(resolve, delay));
                    continue; // Retry
                }
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            return response;
        } catch (error) {
            if (i === maxRetries - 1) {
                throw error;
            }
        }
    }
    throw new Error("Failed to fetch after multiple retries.");
};

// --- Custom Color Definitions (PRESERVED) ---
const COLORS = {
    PRIMARY_ACCENT: '#C82550', 
    SECONDARY_ACCENT: '#E07889', 
    LIGHT_BG: '#FCE4C9',      
    MAIN_BG: '#FAF0E5',       
    DARK_TEXT: '#2C3E50',
};

// --- Component Utilities ---

const LoadingSpinner = () => (
    <div className="flex justify-center items-center py-4">
        <div className="w-6 h-6 border-2 border-slate-400" 
             style={{borderTopColor: COLORS.PRIMARY_ACCENT, borderRadius: '50%', animation: 'spin 1s linear infinite'}}
        ></div>
        <span className="ml-3" style={{color: COLORS.PRIMARY_ACCENT}}>Loading...</span>
        <style>{`
            @keyframes spin {
                0% { transform: rotate(0deg); }
                100% { transform: rotate(360deg); }
            }
        `}</style>
    </div>
);

// Step Completion Ring using SVG (PRESERVED)
const StepCompletionRing = ({ steps, goal, size = 150 }) => {
    // Calculate percentage, cap at 100%
    const rawPercentage = (steps / goal) * 100;
    const percentage = Math.min(100, Math.round(rawPercentage));
    
    // SVG Pathing constants
    const radius = 50;
    const circumference = 2 * Math.PI * radius;
    const offset = circumference - (percentage / 100) * circumference;

    // Determine color based on progress (use a green for completion)
    const progressColor = percentage >= 100 ? '#38A169' : COLORS.PRIMARY_ACCENT; 

    return (
        <div className="relative flex flex-col items-center justify-center p-4">
            <svg width={size} height={size} viewBox="0 0 120 120" className="-rotate-90">
                {/* Track Circle */}
                <circle
                    cx="60"
                    cy="60"
                    r={radius}
                    fill="none"
                    stroke={COLORS.SECONDARY_ACCENT}
                    strokeWidth="10"
                    opacity="0.3"
                />
                {/* Progress Circle */}
                <circle
                    cx="60"
                    cy="60"
                    r={radius}
                    fill="none"
                    stroke={progressColor}
                    strokeWidth="10"
                    strokeDasharray={circumference}
                    strokeDashoffset={offset}
                    strokeLinecap="round"
                    style={{ transition: 'stroke-dashoffset 0.8s ease-out' }}
                />
            </svg>
            <div className="absolute flex flex-col items-center justify-center">
                <p className="text-4xl font-extrabold" style={{ color: progressColor }}>
                    {percentage}%
                </p>
                <p className="text-sm font-semibold mt-1" style={{ color: COLORS.DARK_TEXT, opacity: 0.7 }}>
                    Completed
                </p>
            </div>
        </div>
    );
};


// Utility function to convert military time string (e.g., '0800') to a display format (PRESERVED)
const formatTime = (timeStr) => {
    if (!timeStr || timeStr.length !== 4) return timeStr;
    const hours = parseInt(timeStr.substring(0, 2), 10);
    const minutes = timeStr.substring(2, 4);
    const ampm = hours >= 12 ? 'PM' : 'AM';
    const displayHours = hours % 12 || 12;
    return `${displayHours}:${minutes} ${ampm}`;
};

// --- Main App Component ---
const App = () => {
    const [db, setDb] = useState(null);
    const [auth, setAuth] = useState(null);
    const [userId, setUserId] = useState(null);
    const [medications, setMedications] = useState([]);
    const [newMedication, setNewMedication] = useState({ name: '', dose: '', times: ['08:00'] }); 
    const [isAdding, setIsAdding] = useState(false);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState(null);
    const [activeTab, setActiveTab] = useState('reminders'); 
    
    // Chatbot State
    const [chatHistory, setChatHistory] = useState([
        { role: 'model', text: 'Hello! I am your Health Navigator chatbot. I can provide general information on medications, conditions, and health topics using Google Search for the latest context. Always consult a professional for medical advice!', sources: [] }
    ]);
    const [chatInput, setChatInput] = useState('');
    const [isChatLoading, setIsChatLoading] = useState(false);

    // --- GOOGLE FIT STATE ---
    const [googleAccessToken, setGoogleAccessToken] = useState(null);
    const [stepCount, setStepCount] = useState(null);
    const [sleepHours, setSleepHours] = useState(null); // NEW: Sleep hours state
    const [isFitLoading, setIsFitLoading] = useState(false);
    
    // State for the independent assessment result
    const [assessmentResult, setAssessmentResult] = useState(null);
    const [isAssessmentLoading, setIsAssessmentLoading] = useState(false);


    // 1. Firebase Initialization and Authentication (PRESERVED)
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

    // 2. Firestore Data Listener (PRESERVED)
    useEffect(() => {
        if (!db || !userId) return;

        const medCollectionRef = collection(db, `/artifacts/${appId}/users/${userId}/medications`);
        const q = query(medCollectionRef);

        const unsubscribe = onSnapshot(q, (snapshot) => {
            const meds = snapshot.docs.map(doc => ({
                id: doc.id,
                ...doc.data()
            }));
            setMedications(meds);
        }, (err) => {
            console.error("Firestore Snapshot Error:", err);
            if (auth?.currentUser) {
                setError("Failed to fetch medication data in real-time. (Check security rules or console)");
            }
        });

        return () => unsubscribe();
    }, [db, userId, auth]);

    // --- Core Input Handlers (PRESERVED) ---
    const handleNewMedChange = useCallback((e) => {
        const { name, value } = e.target;
        setNewMedication(prev => ({
            ...prev,
            [name]: value
        }));
    }, []);

    const handleTimeChange = useCallback((index, value) => {
        const cleanValue = value.replace(':', '').slice(0, 4);

        setNewMedication(prev => {
            const newTimes = [...prev.times];
            newTimes[index] = value; 
            return { ...prev, times: newTimes };
        });
    }, []);

    const handleAddTime = () => {
        setNewMedication(prev => ({
            ...prev,
            times: [...prev.times, '08:00'] 
        }));
    };

    const handleRemoveTime = (indexToRemove) => {
        setNewMedication(prev => ({
            ...prev,
            times: prev.times.filter((_, index) => index !== indexToRemove)
        }));
    };


    // --- GOOGLE FIT OAUTH FLOW (PRESERVED) ---

    const handleGoogleSignIn = () => {
        if (GOOGLE_CLIENT_ID.includes('PASTE_YOUR_CORRECT_CLIENT_ID_HERE')) {
            setError('GOOGLE FIT ERROR: Please replace the GOOGLE_CLIENT_ID placeholder in App.jsx with your actual Client ID.');
            return;
        }
        setError(null); // Clear previous errors

        const redirectUri = window.location.origin; 
        
        // --- ADDED fitness.sleep.read SCOPE ---
        const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
            `client_id=${GOOGLE_CLIENT_ID}&` +
            `redirect_uri=${redirectUri}&` +
            `response_type=token&` +
            `scope=https://www.googleapis.com/auth/fitness.activity.read%20https://www.googleapis.com/auth/fitness.sleep.read&` +
            `state=google-fit-connect`;

        window.location.href = authUrl;
    };

    // Effect to parse the access token from the URL hash (PRESERVED)
    useEffect(() => {
        if (window.location.hash) {
            const hash = window.location.hash.substring(1);
            const params = hash.split('&').reduce((acc, part) => {
                const [key, value] = part.split('=');
                if (key && value) {
                    acc[decodeURIComponent(key)] = decodeURIComponent(value);
                }
                return acc;
            }, {});

            const accessToken = params['access_token'];
            const state = params['state'];

            if (accessToken && state === 'google-fit-connect') {
                setGoogleAccessToken(accessToken);
                setError({ type: 'success', message: 'Google Fit connected! Token received. Now fetch your activity.' });
                window.history.replaceState({}, document.title, window.location.pathname);
                setActiveTab('activity'); 
            }
        }
    }, []);

    // --- GOOGLE FIT DATA FETCHING: STEPS (UPDATED for timing adjustment) ---

    const fetchSteps = useCallback(async () => {
        if (!googleAccessToken) {
            setError('Error: Google Fit Access Token is missing. Please sign in again.');
            return 0;
        }
        setError(null);
        setIsFitLoading(true);

        const oneDayMs = 24 * 60 * 60 * 1000;
        const now = Date.now();
        
        const startTimeMs = now - (now % oneDayMs); 
        
        // --- FIX: Adjust endTimeMs to 2 minutes in the past for data fusion latency ---
        const LATENCY_BUFFER_MS = 2 * 60 * 1000;
        const endTimeMs = now - LATENCY_BUFFER_MS; 
        // -----------------------------------------------------------------------------
        
        const requestBody = {
            aggregateBy: [{
                dataTypeName: "com.google.step_count.delta",
                dataSourceId: "derived:com.google.step_count.delta:com.google.android.gms:estimated_steps"
            }],
            bucketByTime: { durationMillis: oneDayMs },
            startTimeMillis: startTimeMs,
            endTimeMillis: endTimeMs
        };

        try {
            const response = await exponentialBackoffFetch('https://www.googleapis.com/fitness/v1/users/me/dataset:aggregate', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${googleAccessToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(requestBody)
            });

            if (response.status === 401) {
                setError('Google Fit token expired. Please reconnect to Google Fit.');
                setGoogleAccessToken(null);
                return 0;
            }

            const data = await response.json();
            const stepBucket = data.bucket?.[0];
            const steps = stepBucket?.dataset?.[0]?.point?.[0]?.value?.[0]?.intVal || 0;
            
            setStepCount(steps);
            setError({ type: 'success', message: `Fetched activity successfully! Today's steps: ${steps.toLocaleString()}.` });
            return steps;

        } catch (error) {
            console.error("Error fetching Google Fit data:", error);
            setError(`Failed to fetch steps: ${error.message}`);
            setStepCount(0);
            return 0;
        } finally {
            setIsFitLoading(false);
        }
    }, [googleAccessToken]);


    // --- GOOGLE FIT DATA FETCHING: SLEEP (PRESERVED) ---

    const fetchSleep = useCallback(async () => {
        if (!googleAccessToken) {
            setError('Error: Google Fit Access Token is missing. Please sign in again.');
            return 0;
        }
        setError(null);
        setIsFitLoading(true);

        const oneDayMs = 24 * 60 * 60 * 1000;
        const now = Date.now();
        // Look back 36 hours to ensure we catch a full night's session, even if it finished late this morning.
        const startTimeMs = now - (36 * 60 * 60 * 1000); 
        const endTimeMs = now; 
        
        // activityType 72 is the code for Sleep
        const sessionsUrl = `https://www.googleapis.com/fitness/v1/users/me/sessions?startTime=${startTimeMs}&endTime=${endTimeMs}&activityType=72`;

        try {
            const response = await exponentialBackoffFetch(sessionsUrl, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${googleAccessToken}`,
                    'Content-Type': 'application/json'
                }
            });

            if (response.status === 401) {
                setError('Google Fit token expired. Please reconnect to Google Fit.');
                setGoogleAccessToken(null);
                return 0;
            }

            const data = await response.json();
            
            // Find the most recent sleep session
            const sleepSessions = data.session || [];
            
            // Calculate total sleep duration in milliseconds
            const totalSleepMs = sleepSessions.reduce((total, session) => {
                // Check if the session is recent (ends in the last 24 hours)
                if (session.endTimeMillis > (now - oneDayMs)) {
                    // Duration is endTime - startTime
                    return total + (session.endTimeMillis - session.startTimeMillis);
                }
                return total;
            }, 0);

            // Convert milliseconds to hours (round to 1 decimal place)
            const hours = Math.round((totalSleepMs / (1000 * 60 * 60)) * 10) / 10;
            
            setSleepHours(hours);
            setError({ type: 'success', message: `Fetched activity successfully! Last night's sleep: ${hours} hours.` });
            return hours;

        } catch (error) {
            console.error("Error fetching Google Fit sleep data:", error);
            setError(`Failed to fetch sleep data: ${error.message}`);
            setSleepHours(0);
            return 0;
        } finally {
            setIsFitLoading(false);
        }
    }, [googleAccessToken]);


    // --- Combined Assessment Logic (PRESERVED) ---

    // Renamed and updated to accept both step and sleep data
    const callAssessmentAPI = useCallback(async ({ steps, sleepHours }) => {
        const apiKey = isLocalRun ? GEMINI_API_KEY : "";
        if (apiKey.includes('PASTE_YOUR_GENUINE_GEMINI_API_KEY_HERE')) {
             setError("GEMINI API ERROR: You must replace the placeholder 'PASTE_YOUR_GENUINE_GEMINI_API_KEY_HERE' with your genuine Gemini API Key to enable the chatbot locally.");
             return;
        }
        setError(null);
        setIsAssessmentLoading(true);

        const sleepStatus = sleepHours !== null ? `${sleepHours} hours (Recommended: ${RECOMMENDED_SLEEP_HOURS} hours)` : 'Data not available.';
        const stepStatus = steps !== null ? `${steps.toLocaleString()} steps (Goal: ${DAILY_STEP_GOAL.toLocaleString()} steps)` : 'Data not available.';

        const prompt = `
            Analyze the following two key health metrics and provide an integrated wellness summary:
            1. Daily Steps: ${stepStatus}
            2. Sleep Duration (Last Night): ${sleepStatus}
            
            Provide a frank, objective assessment and suggestions. Focus on how sleep impacts energy and motivation for activity. If both are low, suggest prioritization. If one is good and the other is poor, focus on improving the weaker metric and maintaining the stronger one. The general health goal is ${DAILY_STEP_GOAL.toLocaleString()} steps and ${RECOMMENDED_SLEEP_HOURS} hours of sleep. The analysis must be professional and direct.
        `;

        const systemPrompt = `You are a direct, objective, and professional Wellness Analyst. Provide an honest, integrated assessment of the user's steps and sleep data. Compare facts against recommended health goals, and give 3 specific, actionable, and non-overly-optimistic suggestions for improvement or maintenance across both domains. The tone must be neutral and focused on data and progress, not emotional encouragement.`;

        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${apiKey}`;

        const payload = {
            contents: [{ parts: [{ text: prompt }] }],
            tools: [{ "google_search": {} }], 
            systemInstruction: {
                parts: [{ text: systemPrompt }]
            },
        };

        try {
            const response = await exponentialBackoffFetch(apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            const result = await response.json();
            const candidate = result.candidates?.[0];

            let modelText = "Sorry, I couldn't generate a response. Please check the console for API errors.";
            let sources = [];

            if (candidate && candidate.content?.parts?.[0]?.text) {
                modelText = candidate.content.parts[0].text;
                
                const groundingMetadata = candidate.groundingMetadata;
                if (groundingMetadata && groundingMetadata.groundingAttributions) {
                    sources = groundingMetadata.groundingAttributions
                        .map(attribution => ({
                            uri: attribution.web?.uri,
                            title: attribution.web?.title,
                        }))
                        .filter(source => source.uri && source.title); 
                }
            } else if (result.error) {
                 modelText = `API Error: ${result.error.message}. Please check your API key and network connection.`;
            }

            setAssessmentResult({ text: modelText, sources });
            
        } catch (error) {
            console.error("Assessment API Error:", error);
            setAssessmentResult({ text: `Error fetching assessment: Network error or API issue. (See console for details)`, sources: [] });
        } finally {
            setIsAssessmentLoading(false);
        }
    }, [isLocalRun]);

    // Function to run the full Fit -> Independent AI Assessment workflow (PRESERVED)
    const handleAssessment = async () => {
        // Fetch data if not already present
        const currentSteps = stepCount !== null ? stepCount : await fetchSteps();
        const currentSleep = sleepHours !== null ? sleepHours : await fetchSleep();
        
        // Pass both to the dedicated assessment API
        await callAssessmentAPI({ steps: currentSteps, sleepHours: currentSleep }); 
    };

    // --- Main Chatbot Logic (PRESERVED) ---
    const handleSendMessage = async (e) => {
        e.preventDefault();
        if (!chatInput.trim() || isChatLoading) return;
        const userPrompt = chatInput.trim();
        setChatInput('');
        await callGeminiAPI({ userPrompt });
    };

    const callGeminiAPI = useCallback(async ({ userPrompt }) => {
        const apiKey = isLocalRun ? GEMINI_API_KEY : "";
        if (apiKey.includes('PASTE_YOUR_GENUINE_GEMINI_API_KEY_HERE')) {
             setError("GEMINI API ERROR: You must replace the placeholder 'PASTE_YOUR_GENUINE_GEMINI_API_KEY_HERE' with your genuine Gemini API Key to enable the chatbot locally.");
             return;
        }
        setError(null);
        
        setChatHistory(prev => [...prev, { role: 'user', text: userPrompt, sources: [] }]);
        setIsChatLoading(true);
        setActiveTab('chatbot'); 

        const systemPrompt = "You are a concise, knowledgeable health and wellness navigator. Provide a direct, factual answer to the user's question. Limit your response to a maximum of 4-5 sentences. Use Google Search grounding for medical/factual queries.";

        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${apiKey}`;

        const effectiveChatHistory = chatHistory.slice(-5).map(msg => ({ role: msg.role, parts: [{ text: msg.text }] }));
        effectiveChatHistory.push({ role: 'user', parts: [{ text: userPrompt }] });

        const payload = {
            contents: effectiveChatHistory,
            tools: [{ "google_search": {} }], 
            systemInstruction: {
                parts: [{ text: systemPrompt }]
            },
        };

        try {
            const response = await exponentialBackoffFetch(apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            const result = await response.json();
            const candidate = result.candidates?.[0];

            let modelText = "Sorry, I couldn't generate a response. Please check the console for API errors.";
            let sources = [];

            if (candidate && candidate.content?.parts?.[0]?.text) {
                modelText = candidate.content.parts[0].text;
                
                const groundingMetadata = candidate.groundingMetadata;
                if (groundingMetadata && groundingMetadata.groundingAttributions) {
                    sources = groundingMetadata.groundingAttributions
                        .map(attribution => ({
                            uri: attribution.web?.uri,
                            title: attribution.web?.title,
                        }))
                        .filter(source => source.uri && source.title); 
                }
            } else if (result.error) {
                 modelText = `API Error: ${result.error.message}. Please check your API key and network connection.`;
            }

            setChatHistory(prev => [...prev, { role: 'model', text: modelText, sources }]);
            
        } catch (error) {
            console.error("Gemini API Error:", error);
            setChatHistory(prev => [...prev, { role: 'model', text: `Error fetching response: Network error or API issue. (See console for details)` }]);
        } finally {
            setIsChatLoading(false);
        }
    }, [chatHistory, isLocalRun]);

    // --- CRUD Operations (PRESERVED) ---
    const handleSaveMedication = async () => {
        const isConfigMissing = !firebaseConfig.apiKey;

        if (!db || !userId) {
            if (isLocalRun && isConfigMissing) {
                setError("Database Error: You are running this app locally without a Firebase config. Please provide your own configuration details in the `FIREBASE_LOCAL_CONFIG` variable in `src/App.jsx` to enable persistence (saving/loading).");
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

        if (validTimes.length === 0) {
            setError('Please use the time picker to select valid times.');
            return;
        }

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
        try {
            await deleteDoc(medDocRef);
        } catch (e) {
            console.error("Error deleting document: ", e);
            setError("Failed to delete medication.");
        }
    };

    // --- Schedule Logic (PRESERVED) ---
    const todaySchedule = medications
        .flatMap(med => med.times.map(time => ({
            time: time,
            medName: med.name,
            dose: med.dose,
            medId: med.id,
            key: med.id + time,
        })))
        .sort((a, b) => a.time.localeCompare(b.time));

    // --- Render Functions (PRESERVED) ---

    // **PRESERVED: renderMedicationForm**
    const renderMedicationForm = () => (
        <div className="p-6 rounded-xl space-y-4 shadow-lg" style={{backgroundColor: COLORS.LIGHT_BG}}>
            <h3 className="text-lg font-semibold" style={{color: COLORS.DARK_TEXT}}>Add New Medication</h3>

            <input
                type="text"
                name="name"
                value={newMedication.name}
                onChange={handleNewMedChange}
                placeholder="Medication Name (e.g., Vitamin D)"
                className="w-full p-3 border rounded-lg placeholder-gray-500 focus:outline-none focus:ring-2"
                style={{borderColor: COLORS.SECONDARY_ACCENT, backgroundColor: COLORS.MAIN_BG, color: COLORS.DARK_TEXT, focusRingColor: COLORS.PRIMARY_ACCENT}}
            />
            <input
                type="text"
                name="dose"
                value={newMedication.dose}
                onChange={handleNewMedChange}
                placeholder="Dose (e.g., 1000 IU or 1 tab)"
                className="w-full p-3 border rounded-lg placeholder-gray-500 focus:outline-none focus:ring-2"
                style={{borderColor: COLORS.SECONDARY_ACCENT, backgroundColor: COLORS.MAIN_BG, color: COLORS.DARK_TEXT, focusRingColor: COLORS.PRIMARY_ACCENT}}
            />

            <div>
                <label className="block text-sm font-medium mb-2" style={{color: COLORS.DARK_TEXT}}>
                    Daily Schedule Times
                </label>
                <div className="flex flex-wrap gap-3 items-center">
                    {newMedication.times.map((time, index) => (
                        <div key={`time-input-${index}`} className="flex items-center space-x-2">
                            <input
                                type="time"
                                value={time} 
                                onChange={(e) => handleTimeChange(index, e.target.value)}
                                className="w-28 p-2 border rounded-lg text-center appearance-none"
                                style={{borderColor: COLORS.SECONDARY_ACCENT, backgroundColor: COLORS.MAIN_BG, color: COLORS.DARK_TEXT}}
                            />
                            <button
                                onClick={() => handleRemoveTime(index)}
                                className="transition duration-150 p-1 rounded-full hover:bg-red-100"
                                style={{color: COLORS.PRIMARY_ACCENT}}
                                aria-label="Remove time"
                            >
                                <X size={16} />
                            </button>
                        </div>
                    ))}
                    <button
                        onClick={handleAddTime}
                        className="flex items-center transition duration-150 p-2 rounded-full border"
                        style={{color: COLORS.PRIMARY_ACCENT, borderColor: COLORS.PRIMARY_ACCENT, hoverBackgroundColor: COLORS.SECONDARY_ACCENT}}
                    >
                        <Plus size={16} className="mr-1" />
                        Add Time
                    </button>
                </div>
            </div>

            <div className="pt-4 flex justify-end">
                <button
                    onClick={handleSaveMedication}
                    className="flex items-center px-6 py-3 text-white font-semibold rounded-xl shadow-md transition duration-200 hover:opacity-90"
                    style={{backgroundColor: COLORS.PRIMARY_ACCENT}}
                >
                    <Bell size={20} className="mr-2" />
                    Save Medication
                </button>
            </div>
        </div>
    );

    // **PRESERVED: renderRemindersTab**
    const renderRemindersTab = () => (
        <div className="space-y-8">
            <div className="flex justify-between items-center pb-4 border-b" style={{borderColor: COLORS.SECONDARY_ACCENT}}>
                <h2 className="text-3xl font-bold" style={{color: COLORS.DARK_TEXT}}>Medication Reminders</h2>
                <button
                    onClick={() => setIsAdding(!isAdding)}
                    className="flex items-center px-4 py-2 text-white rounded-xl shadow-md transition duration-200 hover:opacity-90"
                    style={{backgroundColor: COLORS.PRIMARY_ACCENT}}
                >
                    {isAdding ? <X size={20} className="mr-2" /> : <Plus size={20} className="mr-2" />}
                    {isAdding ? 'Close Form' : 'Add New Medication'}
                </button>
            </div>

            {isAdding && renderMedicationForm()}

            <div className="space-y-4">
                <h3 className="text-2xl font-bold flex items-center" style={{color: COLORS.PRIMARY_ACCENT}}>
                    <Calendar size={24} className="mr-2" />
                    Today's Schedule ({todaySchedule.length} items)
                </h3>
                {isLoading ? (
                    <LoadingSpinner />
                ) : todaySchedule.length === 0 ? (
                    <p style={{color: COLORS.DARK_TEXT, opacity: 0.6}} className="italic">No medications set yet. Add one above!</p>
                ) : (
                    <div className="space-y-3">
                        {todaySchedule.map(item => (
                            <div key={item.key} className="flex items-center justify-between p-4 rounded-xl shadow-md transition duration-200 hover:shadow-lg" 
                                 style={{backgroundColor: COLORS.LIGHT_BG, borderLeft: `4px solid ${COLORS.PRIMARY_ACCENT}`}}>
                                <div className="flex items-center space-x-4">
                                    <div className="text-3xl font-mono flex items-center" style={{color: COLORS.PRIMARY_ACCENT}}>
                                        <Clock size={20} className="mr-2" />
                                        {formatTime(item.time)}
                                    </div>
                                    <div>
                                        <p className="text-lg font-semibold" style={{color: COLORS.DARK_TEXT}}>{item.medName}</p>
                                        <p className="text-sm" style={{color: COLORS.DARK_TEXT, opacity: 0.7}}>Dose: {item.dose}</p>
                                    </div>
                                </div>
                                <div className="flex space-x-2">
                                    <button
                                        onClick={() => handleDeleteMedication(item.medId)}
                                        className="p-2 rounded-full transition duration-150 hover:bg-red-100"
                                        style={{color: COLORS.SECONDARY_ACCENT}}
                                        aria-label="Delete medication"
                                    >
                                        <Trash2 size={20} />
                                    </button>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            <div className="space-y-4 pt-4 border-t" style={{borderColor: COLORS.SECONDARY_ACCENT}}>
                <h3 className="text-2xl font-bold" style={{color: COLORS.DARK_TEXT}}>All Medications</h3>
                {medications.length === 0 ? (
                    <p style={{color: COLORS.DARK_TEXT, opacity: 0.6}} className="italic">You have no saved medications.</p>
                ) : (
                    <div className="space-y-2">
                        {medications.map(med => (
                            <div key={med.id} className="p-4 rounded-xl shadow-md flex justify-between items-center transition duration-200" style={{backgroundColor: COLORS.LIGHT_BG}}>
                                <div>
                                    <p className="text-lg font-semibold" style={{color: COLORS.DARK_TEXT}}>{med.name}</p>
                                    <p className="text-sm" style={{color: COLORS.DARK_TEXT, opacity: 0.7}}>Dose: {med.dose}</p>
                                    <p className="text-xs mt-1" style={{color: COLORS.DARK_TEXT, opacity: 0.5}}>Times: {med.times.map(formatTime).join(', ')}</p>
                                </div>
                                <button
                                    onClick={() => handleDeleteMedication(med.id)}
                                    className="p-2 rounded-full transition duration-150 hover:bg-red-100"
                                    style={{color: COLORS.SECONDARY_ACCENT}}
                                    aria-label="Delete medication"
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

    // **PRESERVED: renderActivityTab**
    const renderActivityTab = () => (
        <div className="p-6 space-y-6">
            <h2 className="text-3xl font-bold border-b pb-3" style={{color: COLORS.DARK_TEXT, borderColor: COLORS.SECONDARY_ACCENT}}>
                <Activity size={32} className="inline mr-2" style={{color: COLORS.PRIMARY_ACCENT}} />
                Google Fit Activity
            </h2>
            <div className="p-6 rounded-xl shadow-md space-y-4" style={{backgroundColor: COLORS.MAIN_BG, border: `1px solid ${COLORS.SECONDARY_ACCENT}`}}>
                <p className="text-sm" style={{color: COLORS.DARK_TEXT, opacity: 0.7}}>
                  
                </p>

                {!googleAccessToken ? (
                    <button
                        onClick={handleGoogleSignIn}
                        className="w-full py-3 text-white font-bold rounded-xl transition duration-200 shadow-md hover:opacity-90 disabled:opacity-50 flex items-center justify-center"
                        style={{backgroundColor: COLORS.PRIMARY_ACCENT}}
                        disabled={GOOGLE_CLIENT_ID.includes('PASTE_YOUR_CORRECT_CLIENT_ID_HERE')}
                    >
                        <Heart size={20} className="mr-2" />
                        Connect to Google Fit
                    </button>
                ) : (
                    <>
                        <div className="text-center p-3 rounded-lg" style={{backgroundColor: COLORS.LIGHT_BG}}>
                            <p className="font-semibold" style={{color: COLORS.PRIMARY_ACCENT}}>Connected!</p>
                            <p className="text-xs" style={{color: COLORS.DARK_TEXT, opacity: 0.7}}>Access token received. Fetching data requires permission.</p>
                        </div>
                        
                        <div className="flex flex-col sm:flex-row justify-center space-y-4 sm:space-y-0 sm:space-x-4">
                            <button
                                onClick={fetchSteps}
                                className="flex-1 py-3 text-white font-bold rounded-xl transition duration-200 shadow-md hover:opacity-90 disabled:opacity-50"
                                style={{backgroundColor: COLORS.SECONDARY_ACCENT}}
                                disabled={isFitLoading}
                            >
                                {isFitLoading ? 'Fetching Steps...' : "Fetch Today's Steps"} 
                            </button>
                            <button
                                onClick={fetchSleep}
                                className="flex-1 py-3 text-white font-bold rounded-xl transition duration-200 shadow-md hover:opacity-90 disabled:opacity-50"
                                style={{backgroundColor: COLORS.SECONDARY_ACCENT}}
                                disabled={isFitLoading}
                            >
                                {isFitLoading ? 'Fetching Sleep...' : "Fetch Last Night's Sleep"} 
                            </button>
                            <button
                                onClick={handleAssessment}
                                className="flex-1 py-3 text-white font-bold rounded-xl transition duration-200 shadow-md hover:opacity-90 disabled:opacity-50"
                                style={{backgroundColor: COLORS.PRIMARY_ACCENT}}
                                disabled={isAssessmentLoading || (stepCount === null && sleepHours === null)}
                            >
                                {isAssessmentLoading ? 'Analyzing...' : 'Get AI Assessment'}
                            </button>
                        </div>
                        
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-6 border-t" style={{ borderColor: COLORS.SECONDARY_ACCENT }}>
                            {/* Step Count Display with Ring */}
                            {stepCount !== null && (
                                <div className="flex flex-col items-center justify-center">
                                    <StepCompletionRing steps={stepCount} goal={DAILY_STEP_GOAL} size={180} />
                                    <div className="mt-4 text-center">
                                        <p className="text-3xl font-extrabold" style={{color: COLORS.DARK_TEXT}}>
                                            {stepCount.toLocaleString()} Steps
                                        </p>
                                        <p className="text-sm" style={{color: COLORS.PRIMARY_ACCENT}}>
                                            Daily Goal: {DAILY_STEP_GOAL.toLocaleString()} steps
                                        </p>
                                    </div>
                                </div>
                            )}

                            {/* NEW: Sleep Hours Display */}
                            {sleepHours !== null && (
                                <div className="flex flex-col items-center justify-center p-4">
                                    <div className={`w-40 h-40 rounded-full flex flex-col items-center justify-center border-4 ${sleepHours < RECOMMENDED_SLEEP_HOURS ? 'border-red-400' : 'border-green-500'}`}
                                         style={{backgroundColor: COLORS.MAIN_BG}}>
                                        <Moon size={40} className="mb-2" style={{color: sleepHours < RECOMMENDED_SLEEP_HOURS ? '#CC0000' : '#38A169'}}/>
                                        <p className="text-4xl font-extrabold" style={{color: COLORS.DARK_TEXT}}>
                                            {sleepHours}h
                                        </p>
                                    </div>
                                    <div className="mt-4 text-center">
                                        <p className="text-3xl font-extrabold" style={{color: COLORS.DARK_TEXT}}>
                                            Sleep
                                        </p>
                                        <p className="text-sm" style={{color: COLORS.PRIMARY_ACCENT}}>
                                            Recommended: {RECOMMENDED_SLEEP_HOURS} hours
                                        </p>
                                    </div>
                                </div>
                            )}

                            {/* Default Message if no data is present yet */}
                            {stepCount === null && sleepHours === null && (
                                <p className="col-span-2 text-center italic" style={{color: COLORS.DARK_TEXT, opacity: 0.6}}>
                                    Fetch your steps and sleep data above to see your health overview.
                                </p>
                            )}
                        </div>
                    </>
                )}
            </div>

            {/* Assessment Report Display (RENAMED result state) */}
            {(isAssessmentLoading || assessmentResult) && (
                <div className="mt-6 p-6 rounded-xl shadow-xl" style={{backgroundColor: COLORS.LIGHT_BG}}>
                    <h3 className="text-2xl font-bold flex items-center mb-4" style={{color: COLORS.DARK_TEXT}}>
                        <MessageSquare size={24} className="mr-2" style={{color: COLORS.PRIMARY_ACCENT}}/>
                        Activity Analyst Report
                    </h3>
                    
                    {isAssessmentLoading && <LoadingSpinner />}

                    {assessmentResult && !isAssessmentLoading && (
                        <div>
                            <p className="whitespace-pre-wrap text-lg" style={{color: COLORS.DARK_TEXT}}>{assessmentResult.text}</p>
                            
                            {assessmentResult.sources && assessmentResult.sources.length > 0 && (
                                <div className="mt-4 text-xs pt-3 border-t" style={{borderColor: COLORS.SECONDARY_ACCENT}}>
                                    <p className="font-semibold mb-1" style={{color: COLORS.DARK_TEXT, opacity: 0.8}}>Sources:</p>
                                    <div className="space-y-1">
                                        {assessmentResult.sources.map((source, idx) => (
                                            <a 
                                                key={idx} 
                                                href={source.uri} 
                                                target="_blank" 
                                                rel="noopener noreferrer" 
                                                className="flex items-center break-words hover:underline"
                                                style={{color: COLORS.SECONDARY_ACCENT}}
                                            >
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

    // **PRESERVED: renderChatbotTab**
    const renderChatbotTab = () => (
        <div className="flex flex-col h-[70vh] p-6 rounded-xl shadow-lg" style={{backgroundColor: COLORS.LIGHT_BG}}>
            <h2 className="text-3xl font-bold border-b pb-3 mb-4" style={{color: COLORS.DARK_TEXT, borderColor: COLORS.SECONDARY_ACCENT}}>Health Chatbot</h2>
            <div className="flex-grow overflow-y-auto space-y-4 pr-2 custom-scrollbar">
                {chatHistory.map((msg, index) => (
                    <div key={index} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                        <div className={`max-w-3xl p-4 rounded-xl shadow-md ${msg.role === 'user' 
                            ? 'text-white rounded-br-none' 
                            : 'rounded-tl-none'}`}
                            style={{
                                backgroundColor: msg.role === 'user' ? COLORS.PRIMARY_ACCENT : COLORS.MAIN_BG,
                                color: msg.role === 'user' ? 'white' : COLORS.DARK_TEXT,
                                border: msg.role !== 'user' ? `1px solid ${COLORS.SECONDARY_ACCENT}` : 'none'
                            }}
                        >
                            <p className="whitespace-pre-wrap">{msg.text}</p>
                            
                            {msg.sources && msg.sources.length > 0 && (
                                <div className="mt-2 text-xs pt-2 border-t" style={{borderColor: COLORS.SECONDARY_ACCENT}}>
                                    <p className="font-semibold mb-1" style={{color: COLORS.DARK_TEXT, opacity: 0.8}}>Sources:</p>
                                    {msg.sources.map((source, idx) => (
                                        <a 
                                            key={idx} 
                                            href={source.uri} 
                                            target="_blank" 
                                            rel="noopener noreferrer" 
                                            className="flex items-center break-words hover:underline"
                                            style={{color: COLORS.SECONDARY_ACCENT}}
                                        >
                                            <Link size={12} className="mr-1 flex-shrink-0" />
                                            <span className="truncate">{source.title}</span>
                                        </a>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>
                ))}
                {isChatLoading && (
                    <div className="flex justify-start">
                        <div className="p-4 rounded-xl shadow-md rounded-tl-none" style={{backgroundColor: COLORS.MAIN_BG, border: `1px solid ${COLORS.SECONDARY_ACCENT}`}}>
                            <LoadingSpinner />
                        </div>
                    </div>
                )}
            </div>
            <form onSubmit={handleSendMessage} className="flex space-x-3 mt-4">
                <input
                    type="text"
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    placeholder="Ask a health question (e.g., 'What are the side effects of ibuprofen?')"
                    className="flex-grow p-3 border rounded-xl placeholder-gray-500 focus:outline-none focus:ring-2"
                    style={{borderColor: COLORS.SECONDARY_ACCENT, backgroundColor: COLORS.MAIN_BG, color: COLORS.DARK_TEXT, focusRingColor: COLORS.PRIMARY_ACCENT}}
                    disabled={isChatLoading}
                />
                <button
                    type="submit"
                    className={`px-6 py-3 rounded-xl shadow-md transition duration-200 flex items-center text-white ${
                        chatInput.trim() && !isChatLoading
                            ? 'hover:opacity-90'
                            : 'opacity-50 cursor-not-allowed'
                    }`}
                    style={{backgroundColor: COLORS.PRIMARY_ACCENT}}
                    disabled={!chatInput.trim() || isChatLoading}
                >
                    <Send size={20} className="mr-1" />
                    Send
                </button>
            </form>
        </div>
    );


    // --- Custom Error/Success Rendering (PRESERVED) ---
    const renderError = () => {
        if (!error) return null;

        const isSuccess = typeof error === 'object' && error.type === 'success';
        const messageText = isSuccess ? error.message : error;
        const bgColor = isSuccess ? '#E6FFFA' : '#FFE5E5';
        const textColor = isSuccess ? '#38A169' : '#CC0000';
        const borderColor = isSuccess ? '#81E6D9' : '#CC0000';

        return (
            <div className="p-4 rounded-xl mb-6 flex items-center justify-between" style={{backgroundColor: bgColor, color: textColor, border: `1px solid ${borderColor}`}}>
                <span>{isSuccess ? 'Success: ' : 'Error: '}{messageText}</span>
                <button onClick={() => setError(null)} className="hover:opacity-70" style={{color: textColor}}><X size={20} /></button>
            </div>
        );
    };

    // --- Main Render (PRESERVED) ---
    return (
        <div className="min-h-screen p-4 sm:p-8 font-sans" style={{backgroundColor: COLORS.MAIN_BG, color: COLORS.DARK_TEXT}}>
            <div className="max-w-5xl mx-auto">
                {/* Header and Tabs */}
                <div className="flex flex-col sm:flex-row justify-between items-center mb-6 border-b pb-4" style={{borderColor: COLORS.SECONDARY_ACCENT}}>
                    <h1 className="text-4xl font-extrabold mb-4 sm:mb-0" style={{color: COLORS.PRIMARY_ACCENT}}>Health Navigator</h1>
                    <div className="flex space-x-2 p-1 rounded-xl shadow-inner" style={{backgroundColor: COLORS.LIGHT_BG}}>
                        <button
                            onClick={() => setActiveTab('reminders')}
                            className={`flex items-center px-4 py-2 rounded-lg font-medium transition duration-200 ${activeTab === 'reminders' ? 'text-white shadow-md' : 'hover:opacity-80'}`}
                            style={{backgroundColor: activeTab === 'reminders' ? COLORS.PRIMARY_ACCENT : 'transparent', color: activeTab === 'reminders' ? 'white' : COLORS.DARK_TEXT}}
                        >
                            <Bell size={20} className="mr-2" />
                            Reminders
                        </button>
                        <button
                            onClick={() => setActiveTab('activity')}
                            className={`flex items-center px-4 py-2 rounded-lg font-medium transition duration-200 ${activeTab === 'activity' ? 'text-white shadow-md' : 'hover:opacity-80'}`}
                            style={{backgroundColor: activeTab === 'activity' ? COLORS.PRIMARY_ACCENT : 'transparent', color: activeTab === 'activity' ? 'white' : COLORS.DARK_TEXT}}
                        >
                            <Activity size={20} className="mr-2" />
                            Activity
                        </button>
                        <button
                            onClick={() => setActiveTab('chatbot')}
                            className={`flex items-center px-4 py-2 rounded-lg font-medium transition duration-200 ${activeTab === 'chatbot' ? 'text-white shadow-md' : 'hover:opacity-80'}`}
                            style={{backgroundColor: activeTab === 'chatbot' ? COLORS.PRIMARY_ACCENT : 'transparent', color: activeTab === 'chatbot' ? 'white' : COLORS.DARK_TEXT}}
                        >
                            <MessageSquare size={20} className="mr-2" />
                            Chatbot
                        </button>
                    </div>
                </div>

                {/* User ID for debugging/sharing */}
                {userId && (
                    <p className="text-xs mb-6 p-2 rounded-lg break-all" style={{backgroundColor: COLORS.LIGHT_BG, color: COLORS.DARK_TEXT, opacity: 0.7}}>
                        Current User ID (for sharing/debug): <span className="font-mono">{userId}</span>
                    </p>
                )}

                {/* Custom Alert/Error Message */}
                {renderError()}

                {/* Main Content Area */}
                <div className="p-6 rounded-3xl shadow-2xl min-h-[60vh]" style={{backgroundColor: COLORS.LIGHT_BG}}>
                    {activeTab === 'reminders' && renderRemindersTab()}
                    {activeTab === 'activity' && renderActivityTab()}
                    {activeTab === 'chatbot' && renderChatbotTab()}
                </div>
            </div>
        </div>
    );
};

export default App;
