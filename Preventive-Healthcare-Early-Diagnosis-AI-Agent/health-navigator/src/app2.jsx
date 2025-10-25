import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, doc, onSnapshot, collection, query, orderBy, addDoc, updateDoc, deleteDoc, serverTimestamp } from 'firebase/firestore';
import { Activity, Pill, User, Send, ChevronRight, X, Loader, MessageSquare, Heart } from 'lucide-react';

// --- CONFIGURATION ---
// IMPORTANT: You MUST replace this with your actual Google OAuth Client ID 
// from your Google Cloud Project (where the Fitness API is enabled).
const GOOGLE_CLIENT_ID = 'YOUR_GOOGLE_FIT_CLIENT_ID'; 

// Firestore Global Setup (Uses runtime variables from the environment)
const firebaseConfig = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : {};
const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';

// API Key Placeholder
const apiKey = "";
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${apiKey}`;

// --- FIREBASE INITIALIZATION & STATE ---
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

// Sign in with custom token if available, otherwise anonymously
const initializeAuth = async () => {
    try {
        const initialAuthToken = typeof __initial_auth_token !== 'undefined' ? __initial_auth_token : null;
        if (initialAuthToken) {
            await signInWithCustomToken(auth, initialAuthToken);
        } else {
            await signInAnonymously(auth);
        }
    } catch (error) {
        console.error("Firebase Auth Initialization Error:", error);
    }
};

const Header = ({ userId }) => (
    <header className="p-4 bg-white shadow-md rounded-t-xl sticky top-0 z-10">
        <div className="flex items-center justify-between">
            <h1 className="text-2xl font-extrabold text-blue-600 flex items-center">
                <Heart className="w-6 h-6 mr-2 text-red-500" />
                Health Navigator
            </h1>
            <div className="flex items-center text-sm text-gray-600">
                <User className="w-4 h-4 mr-1 text-gray-500" />
                User ID: <span className="ml-1 font-mono text-xs overflow-hidden truncate max-w-[150px]">{userId || 'N/A'}</span>
            </div>
        </div>
    </header>
);

// --- MAIN APP COMPONENT ---
const App = () => {
    const [userId, setUserId] = useState(null);
    const [isAuthReady, setIsAuthReady] = useState(false);
    const [medications, setMedications] = useState([]);
    const [chatHistory, setChatHistory] = useState([]);
    const [chatInput, setChatInput] = useState('');
    const [isChatLoading, setIsChatLoading] = useState(false);
    const [activeTab, setActiveTab] = useState('medications'); // 'medications', 'fit', 'chat'
    const [message, setMessage] = useState(null); // Custom alert message

    // Google Fit State
    const [googleAccessToken, setGoogleAccessToken] = useState(null);
    const [stepCount, setStepCount] = useState(null);
    const [isFitLoading, setIsFitLoading] = useState(false);

    // --- FIREBASE AUTH & DATA LISTENERS ---

    useEffect(() => {
        initializeAuth();
        const unsubscribeAuth = onAuthStateChanged(auth, (user) => {
            setUserId(user ? user.uid : null);
            setIsAuthReady(true);
        });
        return () => unsubscribeAuth();
    }, []);

    const userMedicationsCollectionRef = useMemo(() => {
        if (!userId) return null;
        // Private Data Path: /artifacts/{appId}/users/{userId}/medications
        return collection(db, 'artifacts', appId, 'users', userId, 'medications');
    }, [userId]);

    useEffect(() => {
        if (!isAuthReady || !userMedicationsCollectionRef) return;

        const medicationsQuery = query(userMedicationsCollectionRef, orderBy('createdAt', 'desc'));

        const unsubscribe = onSnapshot(medicationsQuery, (snapshot) => {
            const meds = snapshot.docs.map(doc => ({
                id: doc.id,
                ...doc.data()
            }));
            setMedications(meds);
        }, (error) => {
            console.error("Error fetching medications:", error);
        });

        return () => unsubscribe();
    }, [isAuthReady, userMedicationsCollectionRef]);


    // --- GOOGLE FIT OAUTH FLOW ---

    const handleGoogleSignIn = () => {
        if (GOOGLE_CLIENT_ID === 'YOUR_GOOGLE_FIT_CLIENT_ID') {
            setMessage({ type: 'error', text: 'ERROR: Please replace YOUR_GOOGLE_FIT_CLIENT_ID in the code with your actual Client ID.' });
            return;
        }

        const redirectUri = window.location.origin;
        const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
            `client_id=${GOOGLE_CLIENT_ID}&` +
            `redirect_uri=${redirectUri}&` +
            `response_type=token&` +
            `scope=https://www.googleapis.com/auth/fitness.activity.read&` +
            `state=google-fit-connect`;

        window.location.href = authUrl;
    };

    // Effect to parse the access token from the URL hash on page load (after redirect)
    useEffect(() => {
        if (window.location.hash) {
            const hash = window.location.hash.substring(1);
            const params = new URLSearchParams(hash.replace(/&/g, ',').replace(/=/g, ':'));

            const tokenParam = Array.from(params.entries()).find(([key]) => key.startsWith('access_token'));
            const stateParam = Array.from(params.entries()).find(([key]) => key.startsWith('state'));

            const accessToken = tokenParam ? tokenParam[1] : null;
            const state = stateParam ? stateParam[1] : null;

            if (accessToken && state === 'google-fit-connect') {
                setGoogleAccessToken(accessToken);
                setMessage({ type: 'success', text: 'Google Fit connected! Token received. Now fetch your activity.' });
                // Clean up the URL hash to prevent issues on subsequent loads
                window.history.replaceState({}, document.title, window.location.pathname);
            }
        }
    }, []);

    // --- GOOGLE FIT DATA FETCHING ---

    const fetchSteps = useCallback(async () => {
        if (!googleAccessToken) {
            setMessage({ type: 'error', text: 'Error: Google Fit Access Token is missing. Please sign in again.' });
            return 0;
        }
        
        setIsFitLoading(true);

        const oneDayMs = 24 * 60 * 60 * 1000;
        const now = Date.now();
        // Calculate the start and end of "yesterday" in nanoseconds (Google Fit API requirement)
        const endTimeMs = now - (now % oneDayMs) - 1; // End of yesterday
        const startTimeMs = endTimeMs - oneDayMs; // Start of the day before yesterday
        
        const startTimeNs = startTimeMs * 1000000;
        const endTimeNs = endTimeMs * 1000000;
        
        // Google Fit API Request Body
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
            const response = await fetch('https://www.googleapis.com/fitness/v1/users/me/dataset:aggregate', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${googleAccessToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(requestBody)
            });

            if (!response.ok) {
                // If token expired (401), we prompt re-auth.
                if (response.status === 401) {
                    setMessage({ type: 'error', text: 'Google Fit token expired. Please reconnect to Google Fit.' });
                    setGoogleAccessToken(null);
                    return 0;
                }
                throw new Error(`Google Fit API error: ${response.statusText}`);
            }

            const data = await response.json();
            const stepBucket = data.bucket?.[0];
            const steps = stepBucket?.dataset?.[0]?.point?.[0]?.value?.[0]?.intVal || 0;
            
            setStepCount(steps);
            setMessage({ type: 'success', text: `Fetched activity successfully! Yesterday's steps: ${steps}.` });
            return steps;

        } catch (error) {
            console.error("Error fetching Google Fit data:", error);
            setMessage({ type: 'error', text: `Failed to fetch activity: ${error.message}` });
            setStepCount(0);
            return 0;
        } finally {
            setIsFitLoading(false);
        }
    }, [googleAccessToken]);

    // --- GEMINI CHATBOT LOGIC ---

    const handleGeminiQuery = useCallback(async (customPrompt = null, isFitQuery = false) => {
        if (!chatInput.trim() && !customPrompt) return;
        
        const userPrompt = customPrompt || chatInput;
        
        let newHistory = [{ role: "user", parts: [{ text: userPrompt }] }];
        
        // Add existing history for context, if not a custom command
        if (!customPrompt) {
            newHistory = [...chatHistory, ...newHistory];
        }

        setChatHistory(newHistory);
        setChatInput('');
        setIsChatLoading(true);

        // System instructions adapted for health context and conciseness
        const systemPrompt = isFitQuery 
            ? "You are an encouraging and helpful virtual health coach. Analyze the user's step count and provide concise, motivating feedback and a simple, actionable suggestion in 2-3 sentences. Focus on positive reinforcement."
            : "You are a concise, knowledgeable health and wellness navigator. Provide a direct, factual answer to the user's question. Limit your response to a maximum of 4-5 sentences. Use Google Search grounding for medical/factual queries.";

        const payload = {
            contents: newHistory,
            // Only use grounding for general queries, not for analyzing structured data
            tools: !isFitQuery ? [{ "google_search": {} }] : undefined, 
            systemInstruction: { parts: [{ text: systemPrompt }] },
        };

        try {
            const response = await fetch(GEMINI_API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            const result = await response.json();
            const candidate = result.candidates?.[0];

            if (candidate && candidate.content?.parts?.[0]?.text) {
                const text = candidate.content.parts[0].text;
                let sources = [];
                const groundingMetadata = candidate.groundingMetadata;
                if (groundingMetadata && groundingMetadata.groundingAttributions) {
                    sources = groundingMetadata.groundingAttributions
                        .map(attribution => ({ uri: attribution.web?.uri, title: attribution.web?.title }))
                        .filter(source => source.uri && source.title);
                }

                setChatHistory(prev => [
                    ...prev,
                    { role: "model", parts: [{ text }], sources }
                ]);
            } else {
                const errorText = "Model response error: Could not generate content.";
                setChatHistory(prev => [...prev, { role: "model", parts: [{ text: errorText }] }]);
                console.error("Gemini API Error:", result);
            }
        } catch (error) {
            const errorText = `Failed to connect to AI: ${error.message}.`;
            setChatHistory(prev => [...prev, { role: "model", parts: [{ text: errorText }] }]);
            console.error("Fetch Error:", error);
        } finally {
            setIsChatLoading(false);
        }
    }, [chatInput, chatHistory]);

    // Function to run the full Fit -> Gemini workflow
    const handleAssessSteps = async () => {
        const steps = await fetchSteps();
        if (steps > 0 || steps === 0) {
            const prompt = `Yesterday, the user took exactly ${steps.toLocaleString()} steps. Please provide an assessment and feedback based on this activity level.`;
            // Switch to chat tab to show the response
            setActiveTab('chat'); 
            await handleGeminiQuery(prompt, true);
        }
    };


    // --- MEDICATION CRUD OPERATIONS ---

    const MedicationForm = () => {
        const [name, setName] = useState('');
        const [dose, setDose] = useState('');
        const [time, setTime] = useState('');

        const handleSubmit = async (e) => {
            e.preventDefault();
            if (!name || !dose || !time || !userMedicationsCollectionRef) {
                setMessage({ type: 'error', text: 'All fields are required.' });
                return;
            }

            try {
                await addDoc(userMedicationsCollectionRef, {
                    name,
                    dose,
                    time,
                    isTaken: false,
                    createdAt: serverTimestamp(),
                });
                setName('');
                setDose('');
                setTime('');
            } catch (error) {
                console.error("Error adding document: ", error);
                setMessage({ type: 'error', text: 'Failed to add medication. See console for details.' });
            }
        };

        return (
            <form onSubmit={handleSubmit} className="p-4 bg-gray-50 rounded-xl shadow-inner mb-6">
                <h3 className="font-semibold text-lg text-gray-700 mb-3 flex items-center">
                    <Pill className="w-5 h-5 mr-2" />
                    Add New Medication
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    <input
                        type="text"
                        placeholder="Medication Name (e.g., Aspirin)"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        className="p-2 border border-gray-300 rounded-lg focus:ring-blue-500 focus:border-blue-500"
                        required
                    />
                    <input
                        type="text"
                        placeholder="Dose (e.g., 500mg)"
                        value={dose}
                        onChange={(e) => setDose(e.target.value)}
                        className="p-2 border border-gray-300 rounded-lg focus:ring-blue-500 focus:border-blue-500"
                        required
                    />
                    <input
                        type="time"
                        value={time}
                        onChange={(e) => setTime(e.target.value)}
                        className="p-2 border border-gray-300 rounded-lg focus:ring-blue-500 focus:border-blue-500"
                        required
                    />
                </div>
                <button
                    type="submit"
                    className="mt-4 w-full bg-blue-500 hover:bg-blue-600 text-white font-bold py-2 rounded-lg transition duration-200 shadow-md"
                >
                    Save Reminder
                </button>
            </form>
        );
    };

    const handleToggleTaken = async (id, isTaken) => {
        if (!userMedicationsCollectionRef) return;
        try {
            const medRef = doc(userMedicationsCollectionRef, id);
            await updateDoc(medRef, {
                isTaken: !isTaken
            });
        } catch (error) {
            console.error("Error updating document: ", error);
            setMessage({ type: 'error', text: 'Failed to update status. See console.' });
        }
    };

    const handleDelete = async (id) => {
        if (!userMedicationsCollectionRef) return;
        try {
            const medRef = doc(userMedicationsCollectionRef, id);
            await deleteDoc(medRef);
        } catch (error) {
            console.error("Error deleting document: ", error);
            setMessage({ type: 'error', text: 'Failed to delete item. See console.' });
        }
    };

    // --- UTILITY COMPONENTS ---

    const MessagePopup = ({ message, onClose }) => {
        if (!message) return null;
        const baseClass = "fixed bottom-5 right-5 p-4 rounded-xl shadow-2xl transition-opacity duration-300 z-50 flex items-start space-x-3";
        const colorClass = message.type === 'error'
            ? 'bg-red-500 text-white'
            : 'bg-green-500 text-white';

        return (
            <div className={`${baseClass} ${colorClass}`}>
                <p className="font-medium">{message.text}</p>
                <button onClick={onClose} className="ml-4 -mt-1 opacity-70 hover:opacity-100 transition-opacity">
                    <X className="w-5 h-5" />
                </button>
            </div>
        );
    };

    const LoadingSpinner = () => (
        <div className="flex items-center justify-center p-4">
            <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-500"></div>
        </div>
    );

    // --- RENDERING SECTIONS ---

    const renderMedicationTab = () => (
        <div className="p-4">
            <MedicationForm />

            <h3 className="font-semibold text-xl text-gray-800 mb-4 border-b pb-2">Your Reminders ({medications.length})</h3>
            
            {medications.length === 0 ? (
                <p className="text-gray-500 italic p-4 bg-white rounded-lg text-center">No medications scheduled yet. Add one above!</p>
            ) : (
                <div className="space-y-3">
                    {medications.map((med) => (
                        <div key={med.id} className={`p-4 rounded-xl shadow-lg flex items-center justify-between transition duration-300 ${med.isTaken ? 'bg-green-50 border-l-4 border-green-500' : 'bg-white border-l-4 border-red-500'}`}>
                            <div className="flex-1 min-w-0">
                                <p className="font-bold text-lg text-gray-800 truncate">{med.name}</p>
                                <p className="text-sm text-gray-600">{med.dose} | Due at: {med.time}</p>
                            </div>
                            <div className="flex items-center space-x-3 ml-4">
                                <button
                                    onClick={() => handleToggleTaken(med.id, med.isTaken)}
                                    className={`px-3 py-1 text-sm font-semibold rounded-full transition duration-300 ${med.isTaken ? 'bg-green-500 text-white hover:bg-green-600' : 'bg-yellow-100 text-yellow-800 hover:bg-yellow-200'}`}
                                >
                                    {med.isTaken ? 'Undo' : 'Mark Taken'}
                                </button>
                                <button
                                    onClick={() => handleDelete(med.id)}
                                    className="p-1 text-red-500 hover:bg-red-100 rounded-full transition duration-200"
                                    aria-label="Delete medication"
                                >
                                    <X className="w-5 h-5" />
                                </button>
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );

    const renderFitTab = () => (
        <div className="p-6">
            <h2 className="text-2xl font-bold text-gray-800 mb-4 flex items-center">
                <Activity className="w-6 h-6 mr-2 text-purple-600" />
                Google Fit Activity Tracker
            </h2>
            <div className="p-6 bg-white rounded-xl shadow-lg border border-gray-200">
                <p className="mb-4 text-gray-600">
                    To get feedback on your activity, click "Connect" below. **Note: This uses a client-side OAuth flow and your token will expire after about an hour, requiring re-authentication.**
                </p>

                {!googleAccessToken ? (
                    <button
                        onClick={handleGoogleSignIn}
                        className="w-full py-3 bg-purple-600 hover:bg-purple-700 text-white font-bold rounded-lg transition duration-200 shadow-md flex items-center justify-center disabled:opacity-50"
                        disabled={GOOGLE_CLIENT_ID === 'YOUR_GOOGLE_FIT_CLIENT_ID'}
                    >
                        Connect to Google Fit
                    </button>
                ) : (
                    <>
                        <div className="text-center mb-6">
                            <p className="font-semibold text-green-600 mb-2">Connected successfully!</p>
                            <p className="text-sm text-gray-500">Token received. Ready to fetch data.</p>
                        </div>
                        
                        <div className="flex justify-center space-x-4 mb-6">
                            <button
                                onClick={fetchSteps}
                                className="px-4 py-2 bg-yellow-500 hover:bg-yellow-600 text-white font-bold rounded-lg transition duration-200 shadow-md disabled:opacity-50"
                                disabled={isFitLoading}
                            >
                                {isFitLoading ? <LoadingSpinner /> : 'Fetch Yesterday\'s Steps'}
                            </button>
                            <button
                                onClick={handleAssessSteps}
                                className="px-4 py-2 bg-blue-500 hover:bg-blue-600 text-white font-bold rounded-lg transition duration-200 shadow-md disabled:opacity-50"
                                disabled={isFitLoading || stepCount === null}
                            >
                                Get Gemini Feedback
                            </button>
                        </div>
                        
                        {stepCount !== null && (
                            <div className="mt-4 p-4 border-t border-gray-200 text-center">
                                <p className="text-2xl font-extrabold text-indigo-700">
                                    {stepCount.toLocaleString()} Steps
                                </p>
                                <p className="text-sm text-gray-500">Activity recorded for yesterday</p>
                            </div>
                        )}
                    </>
                )}
            </div>
        </div>
    );

    const renderChatTab = () => (
        <div className="flex flex-col h-full bg-gray-50 p-4">
            <div className="flex-1 overflow-y-auto mb-4 space-y-4 pr-2">
                {chatHistory.length === 0 ? (
                    <div className="text-center p-8 text-gray-500 bg-white rounded-xl shadow-lg mt-4">
                        <MessageSquare className="w-8 h-8 mx-auto mb-2 text-blue-400" />
                        <p>Ask the Gemini Health Navigator anything about wellness, symptoms, or medication interactions.</p>
                        <p className="text-xs mt-2 italic">e.g., "What is the recommended daily water intake?"</p>
                    </div>
                ) : (
                    chatHistory.map((message, index) => (
                        <div key={index} className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                            <div className={`max-w-3/4 p-3 rounded-xl shadow-md ${message.role === 'user' ? 'bg-blue-500 text-white rounded-br-none' : 'bg-white text-gray-800 rounded-tl-none border border-gray-200'}`}>
                                <p className="whitespace-pre-wrap">{message.parts[0].text}</p>
                                {message.sources && message.sources.length > 0 && (
                                    <div className="mt-2 pt-2 border-t border-gray-200 text-xs text-gray-500">
                                        <p className="font-semibold mb-1">Sources:</p>
                                        {message.sources.map((source, sIndex) => (
                                            <a key={sIndex} href={source.uri} target="_blank" rel="noopener noreferrer" className="block text-blue-600 hover:underline truncate">
                                                {source.title || new URL(source.uri).hostname}
                                            </a>
                                        ))}
                                    </div>
                                )}
                            </div>
                        </div>
                    ))
                )}
                {isChatLoading && <LoadingSpinner />}
            </div>

            <form onSubmit={(e) => { e.preventDefault(); handleGeminiQuery(); }} className="flex">
                <input
                    type="text"
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    placeholder="Ask a health question or type 'Assess Steps'..."
                    className="flex-1 p-3 border border-gray-300 rounded-l-xl focus:ring-blue-500 focus:border-blue-500"
                    disabled={isChatLoading}
                />
                <button
                    type="submit"
                    className="p-3 bg-blue-500 hover:bg-blue-600 text-white rounded-r-xl transition duration-200 disabled:opacity-50 flex items-center justify-center"
                    disabled={isChatLoading || !chatInput.trim()}
                >
                    <Send className="w-5 h-5" />
                </button>
            </form>
        </div>
    );

    // --- MAIN RENDER ---
    return (
        <div className="min-h-screen bg-gray-100 font-sans p-4 sm:p-6 flex justify-center items-start">
            <div className="w-full max-w-4xl bg-white rounded-xl shadow-2xl overflow-hidden min-h-[80vh]">
                <Header userId={userId} />

                {/* Tab Navigation */}
                <div className="flex border-b border-gray-200 bg-white">
                    <TabButton 
                        name="Medications" 
                        icon={Pill} 
                        isActive={activeTab === 'medications'} 
                        onClick={() => setActiveTab('medications')} 
                    />
                    <TabButton 
                        name="Activity" 
                        icon={Activity} 
                        isActive={activeTab === 'fit'} 
                        onClick={() => setActiveTab('fit')} 
                    />
                    <TabButton 
                        name="AI Chat" 
                        icon={MessageSquare} 
                        isActive={activeTab === 'chat'} 
                        onClick={() => setActiveTab('chat')} 
                    />
                </div>

                {/* Content */}
                <div className="min-h-[60vh] overflow-y-auto">
                    {activeTab === 'medications' && renderMedicationTab()}
                    {activeTab === 'fit' && renderFitTab()}
                    {activeTab === 'chat' && renderChatTab()}
                </div>

                <MessagePopup message={message} onClose={() => setMessage(null)} />
            </div>
        </div>
    );
};

// Helper Component for Tabs
const TabButton = ({ name, icon: Icon, isActive, onClick }) => (
    <button
        onClick={onClick}
        className={`flex-1 flex items-center justify-center py-3 px-1 text-sm font-semibold transition-colors duration-200 ${
            isActive
                ? 'text-blue-600 border-b-2 border-blue-600 bg-blue-50'
                : 'text-gray-600 hover:text-blue-500 hover:bg-gray-50'
        }`}
    >
        <Icon className="w-5 h-5 mr-2" />
        {name}
    </button>
);

export default App;
