console.log('App.js script started execution');
import {
    db,
    auth,
    googleProvider,
    signInWithPopup,
    signOut,
    onAuthStateChanged,
    createUserWithEmailAndPassword,
    signInWithEmailAndPassword,
    sendPasswordResetEmail,
    firebaseConfig
} from './firebase-config.js';

// Import initializeApp properly to create secondary app instances for Admin actions
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

import {
    collection,
    getDocs,
    doc,
    getDoc,
    setDoc,
    updateDoc,
    arrayUnion,
    query,
    where,
    deleteDoc,
    addDoc,
    deleteField
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

import { BehavioralTracker } from './behavioral_tracking.js';
import { MetricsEngine } from './metrics_engine.js';

// Global State
const state = {
    currentRoute: '',
    courses: [],
    currentCourse: null,
    isAdmin: false,      // Permission Flag
    adminLoggedIn: false, // Access Flag (Original System) - We might merge these or keep both for compatibility
    loading: true,
    currentUser: null,   // { userId, userName, email, uid }
    adminViewMode: 'courses', // 'courses', 'users', 'behavior'
    adminSortBy: 'openDate'
};

const themeColor = '#0ABAB5'; // Tiffany Blue

// YouTube Player Management
let currentYouTubePlayer = null;
let youtubeSaveInterval = null;
let youtubeRestrictionInterval = null;
let isYouTubeAPIReady = false;
let currentTracker = null;
let currentEngine = null;

// YouTube API Ready Callback
window.onYouTubeIframeAPIReady = function () {
    isYouTubeAPIReady = true;
    console.log('[YouTube API] 撌脰??亙???);
};

// Wait for YouTube API to be ready
function waitForYouTubeAPI(maxAttempts = 50) {
    return new Promise((resolve) => {
        let attempts = 0;
        const checkAPI = setInterval(() => {
            attempts++;

            // 瑼Ｘ?典? YT ?拐辣?臬摮
            if (typeof YT !== 'undefined' && YT.Player) {
                isYouTubeAPIReady = true;
                clearInterval(checkAPI);
                console.log('[YouTube API] 撌脰??亙?????瑼Ｘ葫嚗?);
                resolve(true);
            } else if (attempts >= maxAttempts) {
                clearInterval(checkAPI);
                console.error('[YouTube API] 頛?暹?');
                resolve(false);
            }
        }, 100); // 瘥?100ms 瑼Ｘ銝甈?
    });
}

// Cleanup YouTube Player
function cleanupYouTubePlayer() {
    if (youtubeSaveInterval) {
        clearInterval(youtubeSaveInterval);
        youtubeSaveInterval = null;
    }
    if (youtubeRestrictionInterval) {
        clearInterval(youtubeRestrictionInterval);
        youtubeRestrictionInterval = null;
    }
    if (currentYouTubePlayer) {
        try {
            currentYouTubePlayer.destroy();
        } catch (e) {
            console.warn('[YouTube] 皜??剜?冽??潛??航炊:', e);
        }
        currentYouTubePlayer = null;
    }
}

