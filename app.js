import { db, auth, googleProvider, signInWithPopup, signOut, onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword, sendPasswordResetEmail } from './firebase-config.js';
import { collection, getDocs, addDoc, updateDoc, doc, deleteDoc, query, where, setDoc, getDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { BehavioralTracker } from './behavioral_tracking.js';
import { MetricsEngine } from './metrics_engine.js';

// State
const state = {
    currentRoute: '',
    courses: [],
    adminLoggedIn: false,
    loading: true,
    currentUser: null, // v5: { uid, userName, employeeId, email, role, status }
    adminViewMode: 'courses', // 'courses', 'users', 'archives'
    adminSortBy: 'openDate',   // 'openDate' or 'actualDate'
    authInitialized: false,    // v5: Firebase Auth 初始化完成
    useFirebaseAuth: false     // v5: 啟用 Firebase Auth (漸進式切換開關)
};

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
    console.log('[YouTube API] 已載入完成');
};

// Wait for YouTube API to be ready
function waitForYouTubeAPI(maxAttempts = 50) {
    return new Promise((resolve) => {
        let attempts = 0;
        const checkAPI = setInterval(() => {
            attempts++;

            // 檢查全域 YT 物件是否存在
            if (typeof YT !== 'undefined' && YT.Player) {
                isYouTubeAPIReady = true;
                clearInterval(checkAPI);
                console.log('[YouTube API] 已載入完成（手動檢測）');
                resolve(true);
            } else if (attempts >= maxAttempts) {
                clearInterval(checkAPI);
                console.error('[YouTube API] 載入逾時');
                resolve(false);
            }
        }, 100); // 每 100ms 檢查一次
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
            console.warn('[YouTube] 清理播放器時發生錯誤:', e);
        }
        currentYouTubePlayer = null;
    }
}

// Mock Data (For Migration Only)
const MOCK_COURSES = [
    {
        title: '個人資料保護法及案例解析',
        color: '#0ABAB5',
        startDate: '2023-01-01',
        endDate: '2030-12-31',
        parts: [
            { type: 'video', title: 'Part1', url: 'https://www.youtube.com/embed/dQw4w9WgXcQ' },
            { type: 'video', title: 'Part2', url: '' },
            { type: 'quiz', title: '課後測驗', url: 'https://docs.google.com/forms/d/e/1FAIpQLSfD_example/viewform' }
        ]
    },
    {
        title: '資訊安全基礎',
        color: '#FF6B6B',
        startDate: '2023-01-01',
        endDate: '2030-12-31',
        parts: [
            { type: 'video', title: 'Part1', url: '' },
            { type: 'video', title: 'Part2', url: '' }
        ]
    },
    {
        title: '企業誠信與倫理',
        color: '#4ECDC4',
        startDate: '2023-01-01',
        endDate: '2030-12-31',
        parts: [
            { type: 'video', title: '全一講', url: '' }
        ]
    }
];

// Router
function handleRoute() {
    const hash = window.location.hash || '#home';
    const path = hash.split('/')[0];
    const id = hash.split('/')[1];

    state.currentRoute = path;
    renderApp(path, id);
}

// Data Handling
async function fetchCourses() {
    state.loading = true;
    try {
        const querySnapshot = await getDocs(collection(db, "courses"));
        const courses = [];
        querySnapshot.forEach((doc) => {
            courses.push({ id: doc.id, ...doc.data() });
        });

        state.courses = courses;

        // Auto Migrate if Empty
        if (courses.length === 0) {
            console.log('Migrating Mock Data...');
            for (const course of MOCK_COURSES) {
                await addDoc(collection(db, "courses"), course);
            }
            // Fetch again
            return fetchCourses();
        }

    } catch (e) {
        console.error("Error fetching courses: ", e);
        alert("讀取課程失敗，請檢查網路或 Firebase 設定");
    } finally {
        state.loading = false;
        // Re-render current route after fetch
        handleRoute();
    }
}

// Helper: Check Availability (Date only)
function isCourseAvailable(course) {
    if (!course.startDate || !course.endDate) return true; // Default to available if not set
    const now = new Date();
    // Reset time components for strict date comparison, or just compare value
    // Let's treat startDate as 00:00 and endDate as 23:59
    const start = new Date(course.startDate);
    const end = new Date(course.endDate);
    end.setHours(23, 59, 59, 999);

    return now >= start && now <= end;
}

// Helper: Check Permission (Date + User ID)
function canUserViewCourse(course, userId) {
    // 1. Check Date Availability
    if (!isCourseAvailable(course)) return false;

    // 2. Check User Permission
    // If no specific users are allowed, it's open to everyone
    if (!course.allowedUserIds || course.allowedUserIds.length === 0) {
        return true;
    }

    // Admin Override: Admins can see all on-air courses
    if (state.adminLoggedIn) {
        return true;
    }

    // If specific users are allowed, must be logged in
    if (!userId) return false;

    // Check if user is in the allowed list
    return course.allowedUserIds.includes(userId);
}

// ============== V5 AUTH MANAGER ==============
const AuthManager = {
    init: () => {
        onAuthStateChanged(auth, async (user) => {
            if (user) {
                console.log('[v5 Auth] User detected:', user.uid);
                await AuthManager.handleUserLogin(user);
            } else {
                console.log('[v5 Auth] No user.');
                if (state.useFirebaseAuth) {
                    state.currentUser = null;
                    state.adminLoggedIn = false;
                    state.authInitialized = true;
                    handleRoute();
                }
            }
        });
    },

    handleUserLogin: async (firebaseUser) => {
        if (!state.useFirebaseAuth) return; // 若未啟用 v5，跳過

        try {
            state.loading = true;
            const userRef = doc(db, "users", firebaseUser.uid);
            const userSnap = await getDoc(userRef);

            let userData = null;

            if (userSnap.exists()) {
                userData = userSnap.data();

                // ✨ 檢查是否已封存
                if (userData.status === 'archived') {
                    const reason = userData.archivedReason === 'merged'
                        ? '此帳號已被合併至其他帳號'
                        : '此帳號已被停用';
                    alert(reason + '。如有疑問請聯絡管理員。');
                    await signOut(auth);
                    state.loading = false;
                    return;
                }
            } else {
                // 新使用者首次登入
                userData = {
                    email: firebaseUser.email,
                    userName: firebaseUser.displayName || '',
                    photoURL: firebaseUser.photoURL || '',
                    createdAt: new Date().toISOString(),
                    status: 'active',
                    role: 'user',
                    employeeId: '' // 尚未綁定
                };
                await setDoc(userRef, userData);
            }

            // 更新 State
            state.currentUser = { uid: firebaseUser.uid, ...userData };

            // 檢查管理員權限
            if (userData.role === 'admin') {
                state.adminLoggedIn = true;
            }

            state.authInitialized = true;
            state.loading = false;

            // ✨ 檢查是否需要強制綁定編號
            if (!userData.employeeId) {
                console.log('[v5 Auth] No Employee ID, triggering binding...');
                AuthManager.showMandatoryBindingModal(firebaseUser.uid);
            } else {
                await fetchCourses();
                handleRoute();
            }

        } catch (e) {
            console.error('[v5 Auth] Login handling error:', e);
            state.loading = false;
            alert('登入處理發生錯誤: ' + e.message);
        }
    },

    loginWithGoogle: async () => {
        try {
            await signInWithPopup(auth, googleProvider);
        } catch (error) {
            console.error(error);
            if (error.code === 'auth/account-exists-with-different-credential') {
                alert('此 Email 已使用其他方式（如密碼）登入過，請使用該方式登入。');
            } else {
                alert('Google 登入失敗: ' + error.message);
            }
        }
    },

    loginWithEmail: async (email, password) => {
        try {
            await signInWithEmailAndPassword(auth, email, password);
        } catch (error) {
            console.error(error);
            alert('登入失敗: ' + error.message);
        }
    },

    resetPassword: async (email) => {
        try {
            await sendPasswordResetEmail(auth, email);
            alert(`已發送重設密碼信至 ${email}，請查收信件並設定新密碼。`);
        } catch (e) {
            console.error(e);
            alert('發送失敗: ' + e.message);
        }
    },

    // ✨ 管理員邀請學員 (使用 Secondary App)
    createUserAsAdmin: async (email, name) => {
        const secondaryApp = window.secondaryFirebaseApp ||
            (await import("https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js")).initializeApp({
                apiKey: "AIzaSyBwQ8SNvJ_VcLkN9Bx7bop8OYU4fnRlpbM",
                authDomain: "hr-online-training.firebaseapp.com",
                projectId: "hr-online-training",
            }, "SecondaryApp");
        window.secondaryFirebaseApp = secondaryApp;

        const secondaryAuth = (await import("https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js")).getAuth(secondaryApp);

        try {
            const tempPassword = Math.random().toString(36).slice(-8) + "Aa1!";
            const userCred = await (await import("https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js")).createUserWithEmailAndPassword(secondaryAuth, email, tempPassword);
            const uid = userCred.user.uid;

            await (await import("https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js")).sendPasswordResetEmail(secondaryAuth, email);

            await setDoc(doc(db, "users", uid), {
                email: email,
                userName: name,
                createdAt: new Date().toISOString(),
                status: 'active',
                role: 'user',
                employeeId: ''
            });

            await (await import("https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js")).signOut(secondaryAuth);

            return true;
        } catch (e) {
            console.error("[v5 Admin] Invite Error", e);
            throw e;
        }
    },

    // ✨ 強制綁定 Modal (自動大寫)
    showMandatoryBindingModal: (uid) => {
        const modal = document.createElement('div');
        modal.className = 'user-dialog-overlay';
        modal.style.zIndex = '10000';
        modal.innerHTML = `
            <div class="mandatory-modal">
                <h2 style="color: var(--primary-color); margin-bottom: 1rem;">初次登入設定</h2>
                <p style="margin-bottom: 2rem; color: #666;">為了確保學習權益，請綁定您的員工資訊。</p>
                
                <div class="input-group">
                    <label class="input-label">真實姓名</label>
                    <input type="text" id="bind-name" class="input-field" placeholder="請輸入姓名" value="${state.currentUser?.userName || ''}">
                </div>
                
                <div class="input-group">
                    <label class="input-label">員工編號 (將自動轉為大寫)</label>
                    <input type="text" id="bind-id" class="input-field" placeholder="例如: A1234">
                </div>

                <div id="bind-error" style="color: #ef4444; margin-bottom: 1rem; display: none;"></div>

                <button id="btn-bind-submit" class="btn-submit" style="background: var(--primary-color); color: white;">確認綁定</button>
            </div>
        `;
        document.body.appendChild(modal);

        const btn = modal.querySelector('#btn-bind-submit');
        const idInput = modal.querySelector('#bind-id');
        const nameInput = modal.querySelector('#bind-name');
        const err = modal.querySelector('#bind-error');

        btn.onclick = async () => {
            const rawId = idInput.value.trim().toUpperCase(); // ✨ 自動大寫
            const name = nameInput.value.trim();

            if (!rawId || !name) {
                err.textContent = '請填寫所有欄位';
                err.style.display = 'block';
                return;
            }

            try {
                btn.disabled = true;
                btn.textContent = '處理中...';

                await updateDoc(doc(db, "users", uid), {
                    employeeId: rawId,
                    userName: name,
                    updatedAt: new Date().toISOString()
                });

                state.currentUser.employeeId = rawId;
                state.currentUser.userName = name;

                document.body.removeChild(modal);
                await fetchCourses();
                handleRoute();

            } catch (e) {
                console.error(e);
                err.textContent = '綁定失敗: ' + e.message;
                err.style.display = 'block';
                btn.disabled = false;
                btn.textContent = '確認綁定';
            }
        }
    }
};

// ============== 使用者識別模組 ==============
function initializeUser() {
    // 檢查 sessionStorage (Browser Session) 是否已有使用者資訊
    const stored = sessionStorage.getItem('hr_training_user');
    const storedAdmin = sessionStorage.getItem('localAdminUser'); // Check for admin session

    if (storedAdmin) {
        state.adminLoggedIn = true;
        state.isAdmin = true;
        return true; // Skip user dialog if admin matches
    }

    if (stored) {
        try {
            state.currentUser = JSON.parse(stored);
            return true;
        } catch (e) {
            console.error('解析使用者資訊失敗', e);
        }
    }

    // 顯示使用者資訊輸入對話框
    return showUserDialog();
}

function showUserDialog() {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'user-dialog-overlay';
        overlay.innerHTML = `
            <div class="user-dialog">
                <h2 style="margin-bottom: 1.5rem; color: var(--primary-color);">歡迎使用線上學習平台</h2>
                <p style="margin-bottom: 2rem; color: #666;">請輸入您的資訊以開始學習</p>
                <div class="form-group">
                    <label>員工編號 (4碼) *</label>
                    <input type="text" id="user-id" placeholder="0000" required />
                </div>
                <div class="form-group">
                    <label>中文姓名 *</label>
                    <input type="text" id="user-name" placeholder="請輸入您的姓名" required />
                </div>
                 <div class="form-group">
                    <label>Email * (公司email)</label>
                    <input type="email" id="user-email" placeholder="example@mitac.com.tw" required />
                </div>
                <p id="user-error" style="color: #ff6b6b; font-size: 0.9rem; margin-top: 1rem; display: none;">請填寫所有欄位</p>
                <button class="btn full-width" id="btn-user-submit" style="margin-top: 1.5rem;">開始學習 / 註冊</button>
                <div style="text-align: center; margin-top: 15px;">
                    <a href="#" id="admin-login-link" style="font-size: 0.85rem; color: #aaa; text-decoration: none;">管理員後台</a>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        const submitBtn = overlay.querySelector('#btn-user-submit');
        const userIdInput = overlay.querySelector('#user-id');
        const userNameInput = overlay.querySelector('#user-name');
        const userEmailInput = overlay.querySelector('#user-email');
        const errorMsg = overlay.querySelector('#user-error');

        const submit = async () => {
            const rawId = userIdInput.value.trim();
            const rawEmail = userEmailInput.value.trim();
            const userName = userNameInput.value.trim();

            if (!rawId || !userName || !rawEmail) {
                errorMsg.textContent = '請填寫所有欄位';
                errorMsg.style.display = 'block';
                return;
            }

            // Normalization
            const userId = rawId.toUpperCase();
            const email = rawEmail.toLowerCase();

            // Simple Email Regex
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            if (!emailRegex.test(email)) {
                errorMsg.textContent = '請輸入有效的 Email 格式';
                errorMsg.style.display = 'block';
                return;
            }

            submitBtn.disabled = true;
            submitBtn.textContent = '驗證中...';

            try {
                // Check if user exists in Firestore
                const userRef = doc(db, "users", userId);
                const userSnap = await getDoc(userRef);

                if (userSnap.exists()) {
                    // User exists, check email
                    const userData = userSnap.data();
                    if (userData.email && userData.email.toLowerCase() === email) {
                        // Login Success
                        // Using userName from DB if you prefer consistency, or update it? 
                        // Let's use the DB name to be safe, or allow update? 
                        // Request says "compare", usually implies strict check.
                        finishLogin({ userId, userName: userData.userName, email });
                    } else {
                        // Mismatch
                        errorMsg.textContent = '登入失敗：員工編號已存在，但 Email 不符。';
                        errorMsg.style.display = 'block';
                        submitBtn.disabled = false;
                        submitBtn.textContent = '開始學習 / 註冊';
                    }
                } else {
                    // User does not exist -> Register
                    const newUser = {
                        userId,
                        userName,
                        email,
                        createdAt: new Date().toISOString()
                    };
                    await setDoc(userRef, newUser);
                    finishLogin(newUser);
                }
            } catch (e) {
                console.error("Login Error", e);
                errorMsg.textContent = '系統錯誤，請與管理員聯繫: ' + e.message;
                errorMsg.style.display = 'block';
                submitBtn.disabled = false;
                submitBtn.textContent = '開始學習 / 註冊';
            }
        };

        const finishLogin = (user) => {
            sessionStorage.setItem('hr_training_user', JSON.stringify(user));
            state.currentUser = user;
            document.body.removeChild(overlay);
            resolve(true);

            // Redirect to home if on admin route to avoid confusion
            if (window.location.hash === '#admin') {
                window.location.hash = '#home';
            }

            // Re-render home to respect permissions with new user
            if (window.location.hash === '' || window.location.hash === '#home') {
                renderHome();
            }
        };

        submitBtn.onclick = submit;
        userIdInput.addEventListener('keyup', (e) => { if (e.key === 'Enter') userNameInput.focus(); });
        userNameInput.addEventListener('keyup', (e) => { if (e.key === 'Enter') userEmailInput.focus(); });
        userEmailInput.addEventListener('keyup', (e) => { if (e.key === 'Enter') submit(); });

        // Admin Link Handler
        const adminLink = overlay.querySelector('#admin-login-link');
        adminLink.onclick = (e) => {
            e.preventDefault();
            document.body.removeChild(overlay);
            resolve(false); // Resolve promise to allow app initialization to continue
            window.location.hash = '#admin';
        };

        // Focus first input
        setTimeout(() => userIdInput.focus(), 100);
    });
}

// ============== 進度追蹤服務 ==============
async function saveProgress(userId, courseId, courseName, unitProgress) {
    try {
        // 計算整體完成度
        const totalUnits = unitProgress.length;
        const completedUnits = unitProgress.filter(u => u.completed || u.quizCompleted).length;
        const completionRate = totalUnits > 0 ? Math.round((completedUnits / totalUnits) * 100) : 0;

        // 判斷課程狀態
        let status = 'not-started';
        if (completionRate === 100) status = 'completed';
        else if (completionRate > 0) status = 'in-progress';

        const progressData = {
            userId,
            userName: state.currentUser?.userName || '',
            courseId,
            courseName,
            status,
            completionRate,
            units: unitProgress,
            updatedAt: new Date().toISOString()
        };

        // 使用 userId_courseId 作為文件 ID，確保每個使用者每門課程只有一筆紀錄
        const docId = `${userId}_${courseId}`;
        await setDoc(doc(db, 'userProgress', docId), progressData, { merge: true });

        return true;
    } catch (e) {
        console.error('儲存進度失敗:', e);
        return false;
    }
}

async function loadProgress(userId, courseId) {
    try {
        const docId = `${userId}_${courseId}`;
        const progressDocRef = doc(db, 'userProgress', docId);
        const progressDoc = await getDoc(progressDocRef);

        if (progressDoc.exists()) {
            return progressDoc.data();
        }

        return null;
    } catch (e) {
        console.error('讀取進度失敗:', e);
        return null;
    }
}

async function updateVideoPosition(userId, courseId, courseName, unitIndex, position, duration, allUnits, metrics = null) {
    // 計算是否完成（觀看 >= 90%）
    const completed = duration > 0 && (position / duration) >= 0.9;

    // 更新單元進度
    if (!allUnits[unitIndex].viewCount) allUnits[unitIndex].viewCount = 0;
    allUnits[unitIndex].lastPosition = position;
    allUnits[unitIndex].duration = duration;
    allUnits[unitIndex].completed = completed;
    allUnits[unitIndex].lastAccessTime = new Date().toISOString();

    allUnits[unitIndex].lastAccessTime = new Date().toISOString();

    if (metrics) {
        allUnits[unitIndex].behavioralMetrics = metrics;
    }

    return saveProgress(userId, courseId, courseName, allUnits);
}

async function markUnitCompleted(userId, courseId, courseName, unitIndex, allUnits, isQuiz = false) {
    if (isQuiz) {
        allUnits[unitIndex].quizCompleted = true;
    } else {
        allUnits[unitIndex].completed = true;
    }
    allUnits[unitIndex].lastAccessTime = new Date().toISOString();

    return saveProgress(userId, courseId, courseName, allUnits);
}

// 初始化單元進度結構
function initializeUnitProgress(course) {
    return (course.parts || []).map((part, index) => ({
        unitIndex: index,
        unitTitle: part.title,
        type: part.type,
        lastPosition: 0,
        duration: 0,
        completed: false,
        quizCompleted: false,
        lastAccessTime: null,
        viewCount: 0
    }));
}

// 查詢使用者所有課程進度
async function getAllUserProgress(userId) {
    try {
        const q = query(collection(db, 'userProgress'), where('userId', '==', userId));
        const snapshot = await getDocs(q);
        const progressList = [];
        snapshot.forEach(doc => {
            progressList.push({ id: doc.id, ...doc.data() });
        });
        return progressList;
    } catch (e) {
        console.error('查詢進度失敗:', e);
        return [];
    }
}

// 查詢所有使用者進度（管理員用）
async function getAllProgress() {
    try {
        const snapshot = await getDocs(collection(db, 'userProgress'));
        const progressList = [];
        snapshot.forEach(doc => {
            progressList.push({ id: doc.id, ...doc.data() });
        });
        return progressList;
    } catch (e) {
        console.error('查詢所有進度失敗:', e);
        return [];
    }
}

// Initialization
window.addEventListener('load', async () => {
    window.addEventListener('hashchange', handleRoute);

    // v5 開關：設為 true 啟用 Firebase Auth
    // 設為 false 使用舊的簡易登入系統
    const enableV5 = true; // ✨ v5 已啟用
    state.useFirebaseAuth = enableV5;

    if (enableV5) {
        console.log('[App] v5 Firebase Auth 模式啟用');
        // 初始化 Firebase Auth
        AuthManager.init();
        // Auth 狀態變化會自動處理登入和載入課程
    } else {
        console.log('[App] 使用傳統登入模式');
        // 先識別使用者
        await initializeUser();
        // 再載入課程
        await fetchCourses();
    }
});

// Render Functions
// Render Functions
async function renderApp(route, id) {
    const app = document.getElementById('app');
    app.innerHTML = ''; // Clear current content

    // Render Navbar (No arguments needed now, state is handled internally)
    app.appendChild(createNavbar());

    // Render Content
    const content = document.createElement('div');
    content.className = 'container fade-in';
    content.style.paddingTop = '2rem';

    if (state.loading) {
        content.innerHTML = '<h2 style="text-align:center;">載入中...</h2>';
        app.appendChild(content);
        return;
    }

    if (route === '#home' || route === '') {
        content.appendChild(renderHome());
    } else if (route === '#course') {
        if (id) {
            const courseDetail = await renderCourseDetail(id);
            content.appendChild(courseDetail);
        } else {
            content.appendChild(renderHome());
        }
    } else if (route === '#progress') {
        const progressPage = await renderProgress();
        content.appendChild(progressPage);
    } else if (route === '#admin') {
        content.appendChild(renderAdmin());
    } else {
        content.innerHTML = '<h2>404 Not Found</h2>';
    }

    app.appendChild(content);
}

function createNavbar(showAdminBtn = false, enableLogoLink = false) {
    const nav = document.createElement('nav');
    nav.className = 'navbar';

    // Logo Logic - FIXED: Use local image and simple link
    const logoHtml = `
            <a href="#home" id="logo-link" class="flex items-center gap-2 text-decoration-none" style="margin-right: auto; text-decoration: none; color: inherit; display: flex; align-items: center;">
                <img src="images/logo.png" alt="MiTAC Logo" style="height: 40px; margin-right: 10px;">
                MiTAC 線上學習平台
            </a>
    `;

    const userInfo = state.currentUser
        ? `<span style = "color: #666; margin-right: 1rem;" >👤 ${state.currentUser.userName}</span> `
        : '';

    const progressBtnHtml = state.currentUser && !state.adminLoggedIn
        ? '<a href="#progress" class="btn" style="background:transparent; color: var(--primary-color); border: 1px solid var(--primary-color); margin-right: 0.5rem;">我的學習紀錄</a>'
        : '';

    // FIXED: Always show Admin Dashboard button if logged in as admin
    const adminBtnHtml = state.adminLoggedIn
        ? '<a href="#admin" class="btn" style="background:transparent; color: var(--primary-color); border: 1px solid var(--primary-color); margin-right: 0.5rem;">管理員後台</a>'
        : '';

    const logoutBtnHtml = (state.currentUser || state.adminLoggedIn)
        ? `<button id = "btn-logout" class="btn" style = "background:#f44336; color: white; border: none; padding: 0.5rem 1rem;" > 登出</button> `
        : '';

    // Mobile Hamburger Button
    const mobileMenuBtn = `
        <button class="mobile-menu-btn" aria - label="Toggle Menu" >
            ☰
        </button>
        `;

    nav.innerHTML = `
        <div class="logo" >
            ${logoHtml}
        </div>
        ${mobileMenuBtn}
    <div class="nav-links" id="nav-links">
        ${userInfo}
        ${progressBtnHtml}
        ${adminBtnHtml}
        ${logoutBtnHtml}
    </div>
    `;

    // Bind Mobile Menu Toggle
    setTimeout(() => {
        const toggleBtn = nav.querySelector('.mobile-menu-btn');
        const navLinks = nav.querySelector('#nav-links');

        if (toggleBtn && navLinks) {
            toggleBtn.onclick = () => {
                navLinks.classList.toggle('active');
            };
        }

        // Close menu when a link is clicked
        const links = navLinks.querySelectorAll('a, button');
        links.forEach(link => {
            link.addEventListener('click', () => {
                navLinks.classList.remove('active');
            });
        });

        // Logout Logic
        const logoutBtn = nav.querySelector('#btn-logout');
        if (logoutBtn) {
            logoutBtn.onclick = () => {
                if (confirm('確定要登出嗎？')) {
                    state.loading = true;
                    state.currentUser = null;
                    state.adminLoggedIn = false;
                    sessionStorage.removeItem('hr_training_user');
                    // FIXED: Clear admin session
                    sessionStorage.removeItem('localAdminUser');
                    window.location.hash = '#home';
                    window.location.reload();
                }
            };
        }
    }, 0);

    if (showAdminBtn) {
        // ...
    }

    // Logo Click Handler
    const logoLink = nav.querySelector('#logo-link');
    if (logoLink) {
        logoLink.onclick = (e) => {
            e.preventDefault();
            // User requested to return to "Course Home"
            // FIXED: Do NOT turn off admin mode here. Just navigate home.
            if (state.adminLoggedIn) {
                state.adminViewMode = 'courses'; // Reset view but keep auth
            }
            window.location.hash = '#home';
            renderAppLegacy('#home'); // Force re-render
        };
    }

    return nav;
}

function renderHome() {
    const section = document.createElement('div');
    section.innerHTML = `<h1 style="text-align:center; margin-bottom: 3rem; margin-top: 2rem;">課程首頁</h1><p style="text-align:center; color:#666; margin-bottom:4rem;">請選擇單元進入學習</p>`;

    const grid = document.createElement('div');
    grid.className = 'grid full-width';
    grid.style.gridTemplateColumns = 'repeat(auto-fit, minmax(300px, 1fr))';
    grid.style.gap = '2rem';

    // Availability Filter
    const coursesToRender = state.courses.filter(c => canUserViewCourse(c, state.currentUser?.userId));

    coursesToRender.forEach(async (course) => {
        const card = document.createElement('div');
        card.className = 'course-card';
        card.style.borderTop = `5px solid ${course.color || '#0ABAB5'}`;

        // 載入進度資料
        let progressHtml = '';
        if (state.currentUser) {
            const progress = await loadProgress(state.currentUser.userId, course.id);
            if (progress && progress.completionRate > 0) {
                const statusText = progress.status === 'completed' ? '已完成' : '學習中';
                const statusColor = progress.status === 'completed' ? '#4CAF50' : '#FF9800';
                progressHtml = `
                    <div class="progress-container" style="margin: 1rem 0;">
                        <div class="progress-info" style="display: flex; justify-content: space-between; margin-bottom: 0.5rem; font-size: 0.85rem;">
                            <span style="color: ${statusColor};">⬤ ${statusText}</span>
                            <span style="color: #666;">${progress.completionRate}%</span>
                        </div>
                        <div class="progress-bar">
                            <div class="progress-fill" style="width: ${progress.completionRate}%; background-color: ${course.color || '#0ABAB5'};"></div>
                        </div>
                    </div>
                `;
            }
        }

        card.innerHTML = `
            <div class="course-title">${course.title}</div>
            <div class="course-meta">${course.parts ? course.parts.length : 0} 個單元</div>
            ${progressHtml}
            <div class="course-meta" style="font-size:0.8rem; margin-top:0.5rem; color:#888;">\r\n                線上開放: ${course.startDate || '未設定'} ~ ${course.endDate || '未設定'}\r\n                ${course.actualStartDate ? `<br>實際課程: ${course.actualStartDate} ~ ${course.actualEndDate || ''}` : ''}\r\n                ${course.courseHours ? `<br>時數: ${course.courseHours} 小時` : ''}\r\n            </div>
            <a href="#course/${course.id}" class="btn" style="background-color: ${course.color || '#0ABAB5'}">進入課程</a>
        `;
        grid.appendChild(card);
    });

    if (coursesToRender.length === 0) {
        grid.innerHTML = `<div style="grid-column: 1/-1; text-align:center; color:#666;">目前沒有開放的課程</div>`;
    }

    section.appendChild(grid);
    return section;
}

async function renderCourseDetail(id) {
    const course = state.courses.find(c => c.id === id);

    // 1. Check restriction
    if (!course) {
        return createErrorView('找不到此課程');
    }

    if (!isCourseAvailable(course)) {
        return createErrorView('非課程觀看時間，請洽HR', false);
    }

    // 2. Check User Permission
    const canView = ((course.allowedUserIds && course.allowedUserIds.length > 0) ?
        (state.adminLoggedIn || (state.currentUser && course.allowedUserIds.includes(state.currentUser.userId))) :
        true
    );

    if (!canView) {
        return createErrorView('您沒有權限觀看此課程');
    }

    const themeColor = course.color || '#0ABAB5';
    const div = document.createElement('div');

    // 載入或初始化進度
    let userProgress = null;
    let unitProgressData = [];

    if (state.currentUser) {
        userProgress = await loadProgress(state.currentUser.userId, id);
        if (userProgress && userProgress.units) {
            unitProgressData = userProgress.units;

            // ✅ 修復:同步單元數量 - 如果課程新增了單元,自動補齊進度
            const currentUnitCount = course.parts ? course.parts.length : 0;
            const savedUnitCount = unitProgressData.length;

            if (currentUnitCount > savedUnitCount) {
                console.log(`[進度同步] 課程有 ${currentUnitCount} 個單元,但進度只有 ${savedUnitCount} 筆,自動補齊`);

                // 補齊缺少的單元進度
                for (let i = savedUnitCount; i < currentUnitCount; i++) {
                    const part = course.parts[i];
                    unitProgressData.push({
                        unitIndex: i,
                        unitTitle: part.title,
                        type: part.type,
                        lastPosition: 0,
                        duration: 0,
                        completed: false,
                        quizCompleted: false,
                        lastAccessTime: null,
                        viewCount: 0
                    });
                }

                // 立即儲存更新後的進度
                await saveProgress(state.currentUser.userId, id, course.title, unitProgressData);
            }
        } else {
            // 初始化進度
            unitProgressData = initializeUnitProgress(course);
        }
    }

    div.innerHTML = `
        <div style="max-width: 900px; margin: 0 auto; padding-bottom: 2rem;">
            <!-- Back Button -->
            <div style="margin-bottom: 2rem;">
                 <a href="#home" class="btn" style="background-color: #6c757d; border-color: #6c757d;">&larr; 回首頁</a>
            </div>

            <!-- Course Title & Nav & Progress -->
            <div style="text-align:center; margin-bottom: 2rem;">
                <h2 style="margin-bottom: 1rem;">${course.title}</h2>
                <div id="course-progress-bar" style="max-width: 500px; margin: 0 auto 1.5rem auto;"></div>
                <div id="unit-buttons-container" class="flex" style="justify-content: center; gap: 1rem; flex-wrap: wrap;"></div>
            </div>

            <!-- Content Area (Video or Quiz) -->
            <div id="content-display" style="
                background: #000;
                min-height: 500px;
                display:flex;
                align-items:center;
                justify-content:center;
                color:white;
                border-radius: 8px;
                overflow: hidden;
                box-shadow: 0 4px 12px rgba(0,0,0,0.1);
            ">
                <h3 id="placeholder-msg">請選擇單元</h3>
            </div>
            <!-- Helper text -->
            <p style="text-align:center; margin-top:1rem; color:#888; font-size:0.9rem;">
                若影片無法播放，請確認瀏覽器支援或網址權限
            </p>
        </div>
    `;

    const btnContainer = div.querySelector('#unit-buttons-container');
    const contentDisplay = div.querySelector('#content-display');
    const progressBarContainer = div.querySelector('#course-progress-bar');

    // 更新課程整體進度顯示
    const updateCourseProgress = () => {
        if (!state.currentUser || unitProgressData.length === 0) return;

        const completedCount = unitProgressData.filter(u => u.completed || u.quizCompleted).length;
        const totalCount = unitProgressData.length;
        const percentage = Math.round((completedCount / totalCount) * 100);

        progressBarContainer.innerHTML = `
            <div style="display: flex; justify-content: space-between; margin-bottom: 0.5rem; font-size: 0.9rem; color: #666;">
                <span>整體進度</span>
                <span>${completedCount}/${totalCount} 單元 (${percentage}%)</span>
            </div>
            <div class="progress-bar">
                <div class="progress-fill" style="width: ${percentage}%; background-color: ${themeColor};"></div>
            </div>
        `;
    };

    updateCourseProgress();

    // Helper: Convert YouTube URL to Embed URL
    const getEmbedUrl = (url) => {
        if (!url) return '';
        let videoId = '';
        if (url.includes('youtube.com/watch')) {
            const urlParams = new URLSearchParams(new URL(url).search);
            videoId = urlParams.get('v');
        } else if (url.includes('youtu.be/')) {
            videoId = url.split('youtu.be/')[1].split('?')[0];
        } else if (url.includes('youtube.com/embed/')) {
            return url;
        }
        return videoId ? `https://www.youtube.com/embed/${videoId}` : url;
    };

    // Helper: Extract YouTube Video ID
    const extractYouTubeVideoId = (url) => {
        if (!url) return null;
        let videoId = null;
        if (url.includes('youtube.com/watch')) {
            const urlParams = new URLSearchParams(new URL(url).search);
            videoId = urlParams.get('v');
        } else if (url.includes('youtu.be/')) {
            videoId = url.split('youtu.be/')[1].split('?')[0];
        } else if (url.includes('youtube.com/embed/')) {
            videoId = url.split('youtube.com/embed/')[1].split('?')[0];
        }
        return videoId;
    };

    // Setup YouTube Player with Progress Tracking
    const setupYouTubePlayer = async (videoId, unitIndex, unitBtn) => {
        console.log('[YouTube] 開始載入播放器...');

        // 等待 YouTube API 載入
        const apiReady = await waitForYouTubeAPI();

        if (!apiReady || typeof YT === 'undefined') {
            console.error('[YouTube] API 載入失敗');
            // 顯示錯誤訊息
            const container = document.getElementById('youtube-player');
            if (container) {
                container.innerHTML = `
                    <div style="padding: 2rem; color: white; text-align: center; background: #333;">
                        <h3>YouTube API 載入失敗</h3>
                        <p style="color: #888;">請重新整理頁面再試一次</p>
                    </div>
                `;
            }
            return;
        }

        cleanupYouTubePlayer();

        const savedPosition = unitProgressData[unitIndex]?.lastPosition || 0;
        console.log(`[YouTube] 準備播放 Video ID: ${videoId}, 恢復位置: ${savedPosition.toFixed(1)}秒`);

        // 初始化 Tracker
        if (state.currentUser) {
            currentTracker = new BehavioralTracker({ userId: state.currentUser.userId });
            currentEngine = new MetricsEngine();
            currentTracker.onEventTracked = (e) => currentEngine.processEvent(e);
        }

        currentYouTubePlayer = new YT.Player('youtube-player', {
            height: '500',
            width: '100%',
            videoId: videoId,
            playerVars: {
                'start': Math.floor(savedPosition),
                'autoplay': 1,
                'rel': 0
            },
            events: {
                'onReady': onPlayerReady,
                'onStateChange': onPlayerStateChange
            }
        });

        function onPlayerReady(event) {
            console.log(`[YouTube] 播放器就緒，從 ${savedPosition.toFixed(1)}秒 開始播放`);

            // 初始化最大觀看時間 (禁止快轉用)
            let maxViewedTime = savedPosition;

            // 啟動限制快轉檢查 (每 0.5 秒)
            youtubeRestrictionInterval = setInterval(() => {
                if (state.adminLoggedIn || !currentYouTubePlayer || !currentYouTubePlayer.getCurrentTime) return;

                const currentTime = currentYouTubePlayer.getCurrentTime();
                // 允許 2 秒緩衝 (避免網路延遲或計時誤差導致的誤判)
                if (currentTime > maxViewedTime + 2) {
                    console.log(`[YouTube] 禁止快轉: 目前 ${currentTime.toFixed(1)} > 最大 ${maxViewedTime.toFixed(1)}`);
                    currentYouTubePlayer.seekTo(maxViewedTime, true);
                    // 可選: 顯示提示訊息
                } else {
                    // 正常播放，更新最大觀看時間
                    if (currentTime > maxViewedTime) {
                        maxViewedTime = currentTime;
                    }
                }
            }, 500);

            // 每 10 秒自動儲存進度
            youtubeSaveInterval = setInterval(async () => {
                if (currentYouTubePlayer && currentYouTubePlayer.getCurrentTime) {
                    const time = currentYouTubePlayer.getCurrentTime();
                    const duration = currentYouTubePlayer.getDuration();

                    if (time > 0 && duration > 0) {
                        await updateVideoPosition(
                            state.currentUser.userId,
                            id,
                            course.title,
                            unitIndex,
                            time,
                            duration,
                            duration,
                            unitProgressData,
                            currentEngine ? currentEngine.getMetrics() : null
                        );

                        // Engine Tick
                        if (currentEngine) {
                            currentEngine.tick(true, time, currentYouTubePlayer.getPlaybackRate());
                        }
                        console.log(`[YouTube] 每 10 秒自動儲存: ${time.toFixed(1)}秒 / ${duration.toFixed(1)}秒`);
                    }
                }
            }, 10000);
        }

        async function onPlayerStateChange(event) {
            if (!currentYouTubePlayer || !currentYouTubePlayer.getCurrentTime) return;

            const time = currentYouTubePlayer.getCurrentTime();
            const duration = currentYouTubePlayer.getDuration();

            // Log Event to Tracker
            if (currentTracker) {
                if (event.data === YT.PlayerState.PLAYING) currentTracker.trackEvent('video_player_event', 'play');
                if (event.data === YT.PlayerState.PAUSED) currentTracker.trackEvent('video_player_event', 'pause');
                if (event.data === YT.PlayerState.ENDED) currentTracker.trackEvent('video_player_event', 'complete');
            }

            // YT.PlayerState: UNSTARTED(-1), ENDED(0), PLAYING(1), PAUSED(2), BUFFERING(3), CUED(5)
            if (event.data === YT.PlayerState.PAUSED) {
                // 暫停時儲存
                if (time > 0 && duration > 0) {
                    await updateVideoPosition(
                        state.currentUser.userId,
                        id,
                        course.title,
                        unitIndex,
                        time,
                        duration,
                        unitProgressData,
                        currentEngine ? currentEngine.getMetrics() : null
                    );
                    console.log(`[YouTube] 暫停時儲存位置: ${time.toFixed(1)}秒`);
                }
            } else if (event.data === YT.PlayerState.ENDED) {
                // 播放結束
                if (youtubeSaveInterval) {
                    clearInterval(youtubeSaveInterval);
                    youtubeSaveInterval = null;
                }

                await updateVideoPosition(
                    state.currentUser.userId,
                    id,
                    course.title,
                    unitIndex,
                    duration,
                    duration,
                    unitProgressData,
                    currentEngine ? currentEngine.getMetrics() : null
                );

                // 更新完成標記
                unitBtn.innerHTML = unitBtn.textContent.replace(' ✓', '') + ' <span style="color: #4CAF50;">✓</span>';
                updateCourseProgress();
                console.log('[YouTube] 播放完畢，已標記完成');
            }
        }
    };

    // 影片進度追蹤變數
    let progressSaveInterval = null;
    let currentVideoElement = null;
    let currentUnitIndex = null;

    // Render Buttons
    let videoCount = 0;
    (course.parts || []).forEach((part, index) => {
        const btn = document.createElement('button');
        const unitProgress = unitProgressData[index] || {};
        const isCompleted = unitProgress.completed || unitProgress.quizCompleted;

        // Determine Button Text
        if (part.type === 'video') {
            videoCount++;
            btn.textContent = `單元 ${videoCount}`;
            btn.title = part.title;
        } else {
            btn.textContent = part.title;
        }

        // 顯示完成標記
        if (isCompleted) {
            btn.innerHTML += ' <span style="color: #4CAF50;">✓</span>';
        }

        btn.className = 'btn';

        const setActive = (active) => {
            if (active) {
                btn.style.backgroundColor = themeColor;
                btn.style.color = 'white';
                btn.style.borderColor = themeColor;
            } else {
                btn.style.backgroundColor = 'white';
                btn.style.color = themeColor;
                btn.style.border = `1px solid ${themeColor}`;
            }
        };

        const renderContent = async () => {
            // 清除之前的自動儲存(直接影片檔案)
            if (progressSaveInterval) {
                clearInterval(progressSaveInterval);
                progressSaveInterval = null;
            }

            // 清除 YouTube Player
            cleanupYouTubePlayer();

            currentUnitIndex = index;
            contentDisplay.innerHTML = '';

            // ✅ 雙重保護:確保該索引的進度資料存在
            if (!unitProgressData[index]) {
                console.warn(`[防禦性修復] unitProgressData[${index}] 不存在,正在初始化...`);
                unitProgressData[index] = {
                    unitIndex: index,
                    unitTitle: part.title,
                    type: part.type,
                    lastPosition: 0,
                    duration: 0,
                    completed: false,
                    quizCompleted: false,
                    lastAccessTime: null,
                    viewCount: 0
                };
            }

            // 增加觀看次數
            if (!unitProgressData[index].viewCount) unitProgressData[index].viewCount = 0;
            unitProgressData[index].viewCount++;

            if (part.type === 'quiz') {
                // Render Quiz Button (No iframe - direct link)
                if (part.url) {
                    contentDisplay.style.background = 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)';
                    contentDisplay.innerHTML = `
                        <div style="
                            width: 100%; 
                            height: 100%; 
                            display: flex; 
                            flex-direction: column; 
                            align-items: center; 
                            justify-content: center; 
                            padding: 3rem;
                            text-align: center;
                        ">
                            <div style="
                                background: white; 
                                padding: 3rem 2rem; 
                                border-radius: 16px; 
                                box-shadow: 0 20px 60px rgba(0,0,0,0.3);
                                max-width: 500px;
                            ">
                                <div style="font-size: 4rem; margin-bottom: 1.5rem;">📝</div>
                                <h2 style="color: #333; margin-bottom: 1rem;">課後測驗</h2>
                                <p style="color: #666; margin-bottom: 2rem; line-height: 1.6;">
                                    請點擊下方按鈕在新視窗開啟測驗<br>
                                    完成測驗後請回到本頁面標記為已完成
                                </p>
                                
                                <button 
                                    class="btn" 
                                    onclick="
                                        const now = Date.now();
                                        window.open('${part.url}', '_blank', 'width=1000,height=800');
                                        
                                        // 啟動倒數計時與啟用按鈕機制
                                        const markBtn = document.getElementById('mark-quiz-complete');
                                        if (markBtn && markBtn.disabled && !markBtn.classList.contains('completed')) {
                                            let timeLeft = 10; // 10秒強制倒數
                                            markBtn.style.opacity = '1';
                                            markBtn.style.backgroundColor = '#999'; // 倒數中顏色
                                            markBtn.textContent = '⏳ 請稍候 ' + timeLeft + ' 秒...';
                                            
                                            const timer = setInterval(() => {
                                                timeLeft--;
                                                if (timeLeft <= 0) {
                                                    clearInterval(timer);
                                                    markBtn.disabled = false;
                                                    markBtn.style.backgroundColor = '#4CAF50';
                                                    markBtn.textContent = '✓ 標記測驗已完成';
                                                } else {
                                                    markBtn.textContent = '⏳ 請稍候 ' + timeLeft + ' 秒...';
                                                }
                                            }, 1000);
                                        }
                                    " 
                                    style="
                                        background-color: ${themeColor}; 
                                        color: white;
                                        border: none;
                                        font-size: 1.1rem;
                                        padding: 1rem 2.5rem;
                                        margin-bottom: 1.5rem;
                                        width: 100%;
                                        box-shadow: 0 4px 12px rgba(0,0,0,0.15);
                                        transition: transform 0.2s;
                                    "
                                    onmouseover="this.style.transform='translateY(-2px)'"
                                    onmouseout="this.style.transform='translateY(0)'"
                                >
                                    🚀 開始測驗
                                </button>
                                
                                <button 
                                    class="btn" 
                                    id="mark-quiz-complete" 
                                    disabled
                                    style="
                                        background-color: #ccc; 
                                        color: white;
                                        border: none;
                                        font-size: 1rem;
                                        padding: 0.8rem 2rem;
                                        width: 100%;
                                        cursor: not-allowed;
                                        transition: background-color 0.3s;
                                    "
                                    title="請先點擊上方按鈕開啟測驗"
                                >
                                    ⚠️ 請先開啟測驗
                                </button>
                                
                                <p style="color: #999; font-size: 0.85rem; margin-top: 1.5rem;">
                                    💡 提示：點擊「開始測驗」後，需等待 10 秒才能標記完成
                                </p>
                            </div>
                        </div>
                    `;

                    // 標記測驗完成
                    setTimeout(() => {
                        const markBtn = contentDisplay.querySelector('#mark-quiz-complete');
                        if (markBtn) {
                            markBtn.onclick = async () => {
                                // 防呆邏輯：驗證碼檢查
                                const requiredCode = part.verificationCode ? String(part.verificationCode).trim() : '';

                                if (requiredCode) {
                                    const userCode = prompt('此測驗需要輸入驗證碼才能完成。\n請輸入驗證碼（通常顯示於測驗表單最後）：');
                                    if (!userCode || userCode.trim().toLowerCase() !== requiredCode.toLowerCase()) {
                                        alert('❌ 驗證碼錯誤，請重新確認！');
                                        return;
                                    }
                                } else {
                                    // 基本防呆：二次確認
                                    // 檢查按鈕狀態是否允許
                                    if (markBtn.innerText.includes('請稍候')) {
                                        alert('⏳ 請完整參與測驗後再標記完成！');
                                        return;
                                    }

                                    if (!confirm('您確認已經填寫並送出測驗表單了嗎？')) {
                                        return;
                                    }
                                }


                                await markUnitCompleted(state.currentUser.userId, id, course.title, index, unitProgressData, true);
                                btn.innerHTML = btn.textContent.replace(' ✓', '') + ' <span style="color: #4CAF50;">✓</span>';
                                updateCourseProgress();
                                markBtn.textContent = '✓ 已完成';
                                markBtn.classList.add('completed');
                                markBtn.disabled = true;
                                markBtn.style.opacity = '0.7';
                                markBtn.style.backgroundColor = '#4CAF50';
                                markBtn.style.cursor = 'default';
                            };
                        }
                    }, 100);
                } else {
                    contentDisplay.style.background = '#f8f9fa';
                    contentDisplay.innerHTML = `<div style="color:#666; padding:2rem;">尚未設定測驗網址</div>`;
                }
            } else {
                // Render Video
                contentDisplay.style.background = 'black';
                if (part.url) {
                    const isDirectFile = part.url.match(/\.(mp4|webm|ogg)$/i);

                    if (isDirectFile) {
                        contentDisplay.innerHTML = `
                            <video id="video-player" controls width="100%" style="max-height: 500px;" src="${part.url}"></video>
                        `;

                        // 設定影片播放追蹤
                        setTimeout(() => {
                            const video = contentDisplay.querySelector('#video-player');
                            if (video) {
                                currentVideoElement = video;

                                // ✅ 修正：在 loadedmetadata 事件後才設定播放位置
                                video.addEventListener('loadedmetadata', () => {
                                    // 初始化 Tracker (HTML5)
                                    if (state.currentUser) {
                                        currentTracker = new BehavioralTracker({ userId: state.currentUser.userId });
                                        currentEngine = new MetricsEngine();
                                        currentTracker.attachToVideoElement(video);
                                        currentTracker.onEventTracked = (e) => currentEngine.processEvent(e);
                                    }
                                    // 記錄影片總時長
                                    unitProgressData[index].duration = video.duration;

                                    // 恢復上次播放位置
                                    const lastPos = unitProgressData[index].lastPosition || 0;
                                    let maxViewedTime = lastPos; // 初始化最大觀看時間

                                    if (lastPos > 0 && lastPos < video.duration) {
                                        video.currentTime = lastPos;
                                        console.log(`[進度追蹤] 恢復播放位置: ${lastPos.toFixed(1)}秒`);
                                    }

                                    // 限制快轉功能 (僅針對非管理員)
                                    video.addEventListener('timeupdate', () => {
                                        if (state.adminLoggedIn) return;

                                        // 允許 2 秒緩衝
                                        if (video.currentTime > maxViewedTime + 2) {
                                            console.log(`[Video] 禁止快轉: ${video.currentTime.toFixed(1)} > ${maxViewedTime.toFixed(1)}`);
                                            video.currentTime = maxViewedTime;
                                        } else {
                                            if (video.currentTime > maxViewedTime) {
                                                maxViewedTime = video.currentTime;
                                            }
                                        }
                                    });
                                });

                                // 開始播放時啟動自動儲存
                                video.addEventListener('play', () => {
                                    progressSaveInterval = setInterval(async () => {
                                        if (video && !video.paused) {
                                            await updateVideoPosition(
                                                state.currentUser.userId,
                                                id,
                                                course.title,
                                                index,
                                                video.currentTime,
                                                video.duration,
                                                unitProgressData,
                                                currentEngine ? currentEngine.getMetrics() : null
                                            );

                                            if (currentEngine) {
                                                currentEngine.tick(true, video.currentTime, video.playbackRate);
                                            }

                                            // 檢查是否達成完成條件
                                            if (unitProgressData[index].completed && !isCompleted) {
                                                btn.innerHTML = btn.textContent.replace(' ✓', '') + ' <span style="color: #4CAF50;">✓</span>';
                                                updateCourseProgress();
                                            }
                                        }
                                    }, 10000); // 每10秒
                                });

                                // ✅ 修正：暫停時立即儲存進度
                                video.addEventListener('pause', async () => {
                                    if (progressSaveInterval) {
                                        clearInterval(progressSaveInterval);
                                    }

                                    // 立即儲存當前位置
                                    if (video.currentTime > 0) {
                                        await updateVideoPosition(
                                            state.currentUser.userId,
                                            id,
                                            course.title,
                                            index,
                                            video.currentTime,
                                            video.duration,
                                            unitProgressData,
                                            currentEngine ? currentEngine.getMetrics() : null
                                        );
                                        console.log(`[進度追蹤] 暫停時儲存位置: ${video.currentTime.toFixed(1)}秒`);
                                    }
                                });

                                // ✅ 新增：使用者手動拖曳進度條時也儲存
                                video.addEventListener('seeked', async () => {
                                    if (video.currentTime > 0) {
                                        await updateVideoPosition(
                                            state.currentUser.userId,
                                            id,
                                            course.title,
                                            index,
                                            video.currentTime,
                                            video.duration,
                                            unitProgressData,
                                            currentEngine ? currentEngine.getMetrics() : null
                                        );
                                        console.log(`[進度追蹤] 拖曳後儲存位置: ${video.currentTime.toFixed(1)}秒`);
                                    }
                                });

                                // 結束時也儲存一次
                                video.addEventListener('ended', async () => {
                                    await updateVideoPosition(
                                        state.currentUser.userId,
                                        id,
                                        course.title,
                                        index,
                                        video.currentTime,
                                        video.duration,
                                        unitProgressData,
                                        currentEngine ? currentEngine.getMetrics() : null
                                    );
                                    btn.innerHTML = btn.textContent.replace(' ✓', '') + ' <span style="color: #4CAF50;">✓</span>';
                                    updateCourseProgress();
                                    console.log('[進度追蹤] 影片播放完畢');
                                });
                            }
                        }, 100);
                    } else {
                        // YouTube 影片（使用 IFrame Player API 自動追蹤）
                        const videoId = extractYouTubeVideoId(part.url);

                        if (videoId) {
                            contentDisplay.innerHTML = `
                                <div style="width: 100%; position: relative;">
                                    <div id="youtube-player"></div>
                                </div>
                            `;

                            // 使用 setTimeout 確保 DOM 已渲染
                            setTimeout(() => {
                                setupYouTubePlayer(videoId, index, btn);
                            }, 100);
                        } else {
                            // 無法提取 Video ID，顯示錯誤訊息
                            contentDisplay.innerHTML = `
                                <div style="padding: 2rem; color: white; text-align: center;">
                                    <h3>無法載入 YouTube 影片</h3>
                                    <p style="color: #888;">請確認影片網址格式正確</p>
                                </div>
                            `;
                        }
                    }
                } else {
                    contentDisplay.innerHTML = `<h3>尚未設定影片網址</h3>`;
                }
            }
        };

        // Initial Load (First Item)
        if (index === 0) {
            setActive(true);
            renderContent();
        } else {
            setActive(false);
        }

        // Click Handler
        btn.addEventListener('click', () => {
            Array.from(btnContainer.children).forEach(child => {
                if (child !== btn) {
                    child.style.backgroundColor = 'white';
                    child.style.color = themeColor;
                }
            });
            setActive(true);
            renderContent();
        });

        btnContainer.appendChild(btn);
    });

    return div;
}

function createErrorView(msg, showHomeBtn = true) {
    const div = document.createElement('div');
    div.style.textAlign = 'center';
    div.style.padding = '4rem 1rem';

    const btnHtml = showHomeBtn ? '<a href="#home" class="btn" style="background-color: #6c757d;">&larr; 回首頁</a>' : '';

    div.innerHTML = `
        <h2 style="color: #ff6b6b; margin-bottom: 2rem;">${msg}</h2>
        ${btnHtml}
    `;
    return div;
}

// 學習進度查詢頁面
async function renderProgress(targetUserId = null) {
    const div = document.createElement('div');

    const isViewAsAdmin = !!targetUserId && state.adminLoggedIn;
    const userId = targetUserId || (state.currentUser ? state.currentUser.userId : null);

    if (!userId) {
        div.innerHTML = '<h2 style="text-align:center; color:#666;">請先登入以查看學習紀錄</h2>';
        return div;
    }

    let userDisplayName = userId;
    // 如果是 Admin 查看他人，嘗試取得該 User Info
    if (isViewAsAdmin) {
        try {
            const userSnap = await getDoc(doc(db, "users", userId));
            if (userSnap.exists()) {
                userDisplayName = `${userSnap.data().userName} (${userId})`;
            }
        } catch (e) { console.error(e); }
    } else if (state.currentUser) {
        userDisplayName = `${state.currentUser.userName} (${state.currentUser.userId})`;
    }

    div.innerHTML = `
    <div style="max-width: 1000px; margin: 0 auto;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem;">
            <h1 style="margin: 0;">${isViewAsAdmin ? '學員學習紀錄 (管理員檢視)' : '我的學習紀錄'}</h1>
            ${isViewAsAdmin
            ? '<button id="back-to-admin" class="btn" style="background-color: #6c757d;">&larr; 返回管理後台</button>'
            : '<a href="#home" class="btn" style="background-color: #6c757d;">&larr; 回首頁</a>'
        }
        </div>
        <p style="color: #666; margin-bottom: 3rem;">使用者：${userDisplayName}</p>
        <div id="progress-content" style="min-height: 300px;">
            <p style="text-align: center; color: #888;">載入中...</p>
        </div>
    </div>
    `;

    if (isViewAsAdmin) {
        div.querySelector('#back-to-admin').onclick = () => {
            // 假設我們想回到學員管理頁籤
            state.adminViewMode = 'users';
            renderApp('#admin');
        };
    }

    const progressContent = div.querySelector('#progress-content');

    // 載入進度資料
    const progressList = await getAllUserProgress(userId);

    if (progressList.length === 0) {
        progressContent.innerHTML = `
        <div style="text-align: center; padding: 3rem; background: var(--light-gray); border-radius: 8px;">
                <h3 style="color: #888; margin-bottom: 1rem;">尚無學習紀錄</h3>
                <p style="color: #999;">開始觀看課程後，進度會顯示在這裡</p>
                <a href="#home" class="btn" style="margin-top: 1.5rem;">前往課程首頁</a>
            </div >
        `;
        return div;
    }

    // ----------------------------------------------------
    // 新增邏輯：依年份/月份分組
    // ----------------------------------------------------

    // 1. 資料處理與排序
    const enrichedList = progressList.map(progress => {
        const course = state.courses.find(c => c.id === progress.courseId);
        // 日期判斷優先順序：實際開課日 > 線上開課日 > 預設
        const dateStr = course?.actualStartDate || course?.startDate;
        let dateObj = new Date(0);
        let year = '其他';
        let month = '其他';

        if (dateStr) {
            const d = new Date(dateStr);
            if (!isNaN(d.getTime())) {
                dateObj = d;
                year = d.getFullYear();
                month = d.getMonth() + 1;
            }
        }

        return { progress, course, dateObj, year, month };
    });

    // 依日期由新到舊排序
    enrichedList.sort((a, b) => b.dateObj - a.dateObj);

    // 2. 分組
    const groups = {}; // { year: { month: [items] } }
    enrichedList.forEach(item => {
        const y = item.year;
        const m = item.month;
        if (!groups[y]) groups[y] = {};
        if (!groups[y][m]) groups[y][m] = [];
        groups[y][m].push(item);
    });

    // 3. 渲染 HTML
    let html = '<div class="progress-container">';

    // 年份由大到小
    const sortedYears = Object.keys(groups).sort((a, b) => {
        if (a === '其他') return 1;
        if (b === '其他') return -1;
        return b - a;
    });

    for (const year of sortedYears) {
        // 年份區塊
        html += `
        <details open style="margin-bottom: 2rem;">
            <summary style="font-size: 1.5rem; font-weight: bold; cursor: pointer; padding: 0.75rem; background: #fafafa; border-radius: 8px; margin-bottom: 1rem; color: #333;">
                📅 ${year} 年度
            </summary>
            <div style="padding-left: 1rem;">
        `;

        // 月份由大到小
        const monthsInYear = groups[year];
        const sortedMonths = Object.keys(monthsInYear).sort((a, b) => {
            if (a === '其他') return 1;
            if (b === '其他') return -1;
            return b - a;
        });

        for (const month of sortedMonths) {
            html += `
            <details open style="margin-bottom: 1.5rem;">
                <summary style="font-size: 1.2rem; font-weight: 500; cursor: pointer; padding: 0.5rem; color: #555; margin-bottom: 0.5rem;">
                     ${month} 月
                </summary>
                <div class="progress-list" style="display: grid; gap: 1.5rem;">
            `;

            for (const { progress, course } of monthsInYear[month]) {
                const themeColor = course?.color || '#0ABAB5';
                const statusColor = progress.status === 'completed' ? '#4CAF50' :
                    progress.status === 'in-progress' ? '#FF9800' : '#999';
                const statusText = progress.status === 'completed' ? '已完成' :
                    progress.status === 'in-progress' ? '學習中' : '未開始';
                const lastUpdate = progress.updatedAt ? new Date(progress.updatedAt).toLocaleString('zh-TW') : '無';

                html += `
                <div class="progress-card" style="
                    background: white;
                    padding: 1.5rem;
                    border-radius: 8px;
                    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.05);
                    border-left: 5px solid ${themeColor};
                ">
                    <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 1rem;">
                        <div>
                            <h3 style="margin: 0 0 0.5rem 0;">${progress.courseName}</h3>
                            <div style="display: flex; gap: 1rem; font-size: 0.9rem; color: #666;">
                                <span style="color: ${statusColor};">⬤ ${statusText}</span>
                                <span>最後學習：${lastUpdate}</span>
                            </div>
                        </div>
                        ${!isViewAsAdmin ? `<a href="#course/${progress.courseId}" class="btn" style="background-color: ${themeColor};">繼續學習</a>` : ''}
                    </div>
                    
                    <div class="progress-bar" style="margin-bottom: 1rem;">
                        <div class="progress-fill" style="width: ${progress.completionRate}%; background-color: ${themeColor};"></div>
                    </div>
                    
                    <div style="display: flex; justify-content: space-between; font-size: 0.9rem; color: #888; margin-bottom: 1rem;">
                        <span>完成度：${progress.completionRate}%</span>
                        <span>${progress.units.filter(u => u.completed || u.quizCompleted).length} / ${progress.units.length} 單元</span>
                    </div>

                    ${isViewAsAdmin ? (() => {
                        const totalTES = progress.units.reduce((acc, u) => acc + (u.behavioralMetrics?.trueEngagementScore || 0), 0);
                        const totalSeek = progress.units.reduce((acc, u) => acc + (u.behavioralMetrics?.seekBackCount || 0), 0);
                        return `
                        <div style="margin-bottom: 1rem; padding: 0.75rem; background: #f0f9ff; border-radius: 6px; border: 1px dashed #38bdf8; display: flex; align-items: center; gap: 1.5rem; font-size: 0.9rem;">
                            <strong style="color: #0284c7;">📊 行為指標</strong>
                            <span>
                                <span title="True Engagement Score (真實投入分數)">TES:</span> 
                                <span style="font-family: monospace; font-weight: bold; color: #0ea5e9;">${totalTES.toFixed(1)}</span>
                            </span>
                            <span>
                                <span title="Seek Back Count (回放次數)">回放:</span> 
                                <span style="font-family: monospace; font-weight: bold; color: #10b981;">${totalSeek}</span> 次
                            </span>
                             <span style="color: #999; font-size: 0.8rem;">(僅管理員可見)</span>
                        </div>
                        `;
                    })() : ''}
                    
                    <details style="margin-top: 1rem;">
                        <summary style="cursor: pointer; color: var(--primary-color); font-size: 0.9rem; user-select: none;">查看詳細進度</summary>
                        <div style="margin-top: 1rem; padding-top: 1rem; border-top: 1px solid #eee;">
                            ${progress.units.map((unit, idx) => {
                        const unitCompleted = unit.completed || unit.quizCompleted;
                        const iconColor = unitCompleted ? '#4CAF50' : '#ddd';
                        const progressPercent = unit.duration > 0 ? Math.round((unit.lastPosition / unit.duration) * 100) : 0;

                        return `
                                    <div style="padding: 0.75rem; margin-bottom: 0.5rem; background: var(--light-gray); border-radius: 4px; display: flex; justify-content: space-between; align-items: center;">
                                        <div style="display: flex; align-items: center; gap: 0.75rem;">
                                            <span style="color: ${iconColor}; font-size: 1.2rem;">${unitCompleted ? '✓' : '○'}</span>
                                            <div>
                                                <div style="font-weight: 500;">${unit.unitTitle}</div>
                                                <div style="font-size: 0.85rem; color: #888;">
                                                    ${unit.type === 'video' ? `觀看進度: ${progressPercent}%` : '測驗'}
                                                    ${unit.viewCount > 0 ? ` • 觀看次數: ${unit.viewCount}` : ''}
                                                </div>
                                            </div>
                                        </div>
                                        ${unitCompleted ? '<span style="color: #4CAF50; font-size: 0.9rem;">已完成</span>' : ''}
                                    </div>
                                `;
                    }).join('')}
                        </div>
                    </details>
                </div> <!-- End Card -->
                `;
            } // End Loop for items in month

            html += `
                </div>
            </details> <!-- End Month Details -->
            `;
        } // End Loop for months

        html += `
            </div>
        </details> <!-- End Year Details -->
        `;
    } // End Loop for years

    html += '</div>';
    progressContent.innerHTML = html;

    return div;
}


// Admin Check Single Course Stats view
async function renderCourseStats(courseId) {
    const course = state.courses.find(c => c.id === courseId);
    const div = document.createElement('div');

    if (!course) {
        div.innerHTML = '查無此課程';
        return div;
    }

    div.innerHTML = `
        <div class="container mt-4">
            <div class="flex justify-between items-center mb-4">
                <h2>📊 課程學習狀況: ${course.title}</h2>
                <button id="back-to-course-list" class="btn" style="background-color: #6c757d;">&larr; 返回列表</button>
            </div>
            <div id="stats-content">載入中...</div>
        </div>
     `;

    div.querySelector('#back-to-course-list').onclick = () => {
        state.adminViewMode = 'courses';
        renderApp('#admin');
    };

    setTimeout(async () => {
        const content = div.querySelector('#stats-content');
        try {
            // Get all progress for this course (Need a query for this optimally)
            const q = query(collection(db, "userProgress"), where("courseId", "==", courseId));
            const snapshot = await getDocs(q);
            const records = [];
            snapshot.forEach(doc => records.push(doc.data()));

            // We also need user names map
            const usersSnap = await getDocs(collection(db, "users"));
            const userMap = {};
            usersSnap.forEach(u => userMap[u.id] = u.data().userName);

            if (records.length === 0) {
                content.innerHTML = '<p class="text-center" style="color:#666; padding:2rem;">目前尚無學員開始此課程</p>';
                return;
            }

            records.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));

            content.innerHTML = `
                <div style="background:white; padding:1.5rem; border-radius:8px; box-shadow:0 2px 8px rgba(0,0,0,0.05);">
                    <p style="margin-bottom:1rem;">共 <strong>${records.length}</strong> 筆學習紀錄</p>
                    <table style="width:100%; text-align:left; border-collapse: collapse;">
                        <thead style="background:#f8f9fa;">
                            <tr>
                                <th style="padding:10px;">學員</th>
                                <th style="padding:10px;">狀態</th>
                                <th style="padding:10px;">進度</th>
                                <th style="padding:10px;">行為指標 (TES/興趣)</th>
                                <th style="padding:10px;">最後更新</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${records.map(r => {
                const Name = userMap[r.userId] || r.userName || r.userId;
                const statusColor = r.status === 'completed' ? '#4CAF50' : r.status === 'in-progress' ? '#FF9800' : '#999';
                const statusText = r.status === 'completed' ? '已完成' : r.status === 'in-progress' ? '進行中 ' : '未開始';

                return `
                                <tr style="border-bottom:1px solid #eee;">
                                    <td style="padding:10px;">
                                        <div style="font-weight:bold;">${Name}</div>
                                        <div style="font-size:0.8rem; color:#888;">${r.userId}</div>
                                    </td>
                                    <td style="padding:10px;">
                                        <span style="color:${statusColor}">${statusText}</span>
                                    </td>
                                    <td style="padding:10px;">
                                        <div style="display:flex; align-items:center; gap:8px;">
                                            <div style="flex:1; max-width:100px; height:6px; background:#eee; border-radius:3px;">
                                                <div style="width:${r.completionRate}%; height:100%; background:${course.color || '#0ABAB5'}; border-radius:3px;"></div>
                                            </div>
                                            <span style="font-size:0.85rem;">${Math.floor(r.completionRate)}%</span>
                                        </div>
                                    </td>
                                    <td style="padding:10px;">
                                         ${(() => {
                        const totalTES = r.units ? r.units.reduce((acc, u) => acc + (u.behavioralMetrics?.trueEngagementScore || 0), 0) : 0;
                        const totalSeek = r.units ? r.units.reduce((acc, u) => acc + (u.behavioralMetrics?.seekBackCount || 0), 0) : 0;
                        return `<span style="font-family:monospace; color:#38bdf8; font-weight:bold;">${totalTES.toFixed(1)}</span> / <span style="font-family:monospace; color:#4ade80;">${totalSeek}</span>`;
                    })()}
                                    </td>
                                    <td style="padding:10px; font-size:0.9rem; color:#666;">
                                        ${r.updatedAt ? new Date(r.updatedAt).toLocaleString('zh-TW') : '-'}
                                    </td>
                                </tr>
                                `;
            }).join('')}
                        </tbody>
                    </table>
                </div>
            `;

        } catch (e) {
            console.error(e);
            content.innerHTML = `<p style="color:red;">載入失敗: ${e.message}</p>`;
        }
    }, 0);

    return div;
}

function renderAdmin() {
    const container = document.createElement('div');

    // 1. Admin Login Logic
    if (!state.adminLoggedIn) {
        container.innerHTML = `
        <div class="container" style="max-width: 400px; margin-top: 5rem; text-align: center;">
                 <h2 class="mb-4">管理員登入</h2>
                 <div style="background: white; padding: 2rem; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1);">
                    <input type="text" id="admin-user" placeholder="帳號" style="width: 100%; padding: 10px; margin-bottom: 1rem; border: 1px solid #ddd; border-radius: 4px;">
                    <input type="password" id="admin-pass" placeholder="密碼" style="width: 100%; padding: 10px; margin-bottom: 1rem; border: 1px solid #ddd; border-radius: 4px;">
                    <button class="btn full-width" id="btn-login" style="width:100%;">登入</button>
                    <p id="login-error" style="color: red; margin-top: 1rem; display: none;">帳號或密碼錯誤</p>
                 </div>
             </div>
    `;

        setTimeout(() => {
            const performLogin = () => {
                const u = container.querySelector('#admin-user').value;
                const p = container.querySelector('#admin-pass').value;
                if (u === 'admin' && p === 'mitachr') {
                    state.adminLoggedIn = true;
                    state.isAdmin = true;
                    sessionStorage.setItem('localAdminUser', 'true'); // Persist admin session
                    // Trigger a re-render of the main app container for the admin route
                    renderApp('#admin');
                } else {
                    container.querySelector('#login-error').style.display = 'block';
                }
            };

            container.querySelector('#btn-login').onclick = performLogin;

            // Add Enter key listener
            const inputs = container.querySelectorAll('#admin-user, #admin-pass');
            inputs.forEach(input => {
                input.addEventListener('keyup', (e) => {
                    if (e.key === 'Enter') {
                        performLogin();
                    }
                });
            });
        }, 0);
        return container;
    }

    // 2. Admin Workspace
    const courses = state.courses;

    // Common Header Helper
    function renderAdminHeader() {
        container.innerHTML = `
        <div class="full-width" style="background: var(--primary-color); color: white; padding: 1.5rem 0;">
            <div class="container">
                <div class="flex justify-between items-center mb-4">
                    <h1 style="margin:0;">後台管理系統</h1>
                </div>
                <div class="flex gap-2">
                    <button id="tab-courses" class="btn" style="${state.adminViewMode === 'courses' ? 'background:white; color:var(--primary-color);' : 'background:transparent; color:white; border:1px solid white;'}">課程列表</button>
                    <button id="tab-users" class="btn" style="${state.adminViewMode === 'users' ? 'background:white; color:var(--primary-color);' : 'background:transparent; color:white; border:1px solid white;'}">學員管理</button>
                    <button id="tab-behavior" class="btn" style="${state.adminViewMode === 'behavior' ? 'background:white; color:var(--primary-color);' : 'background:transparent; color:white; border:1px solid white;'}">行為分析</button>
                    <button id="tab-archives" class="btn" style="${state.adminViewMode === 'archives' ? 'background:white; color:var(--primary-color);' : 'background:transparent; color:white; border:1px solid white;'}">歷史封存</button>
                </div>
            </div>
        </div>
        <div id="admin-workspace" class="container mt-4 mb-4"></div>
        `;

        container.querySelector('#tab-courses').onclick = () => { state.adminViewMode = 'courses'; renderApp('#admin'); };
        container.querySelector('#tab-users').onclick = () => { state.adminViewMode = 'users'; renderApp('#admin'); };
        container.querySelector('#tab-behavior').onclick = () => { state.adminViewMode = 'behavior'; renderApp('#admin'); };
        container.querySelector('#tab-archives').onclick = () => { state.adminViewMode = 'archives'; renderApp('#admin'); };
    }

    // --- CSS for Tooltips ---
    const styleId = 'behavior-dashboard-styles';
    if (!document.getElementById(styleId)) {
        const style = document.createElement('style');
        style.id = styleId;
        style.textContent = `
            .tooltip-container {
                position: relative;
                display: inline-block;
                cursor: help;
                border-bottom: 1px dashed #666;
            }
            .tooltip-text {
                visibility: hidden;
                width: 250px;
                background-color: #333;
                color: #fff;
                text-align: left;
                border-radius: 6px;
                padding: 10px;
                position: absolute;
                z-index: 100;
                bottom: 125%;
                left: 50%;
                margin-left: -125px;
                opacity: 0;
                transition: opacity 0.3s;
                font-size: 0.85rem;
                line-height: 1.4;
                font-weight: normal;
                box-shadow: 0 4px 12px rgba(0,0,0,0.2);
            }
            .tooltip-text::after {
                content: "";
                position: absolute;
                top: 100%;
                left: 50%;
                margin-left: -5px;
                border-width: 5px;
                border-style: solid;
                border-color: #333 transparent transparent transparent;
            }
            .tooltip-container:hover .tooltip-text {
                visibility: visible;
                opacity: 1;
            }
            .kp-card {
                background: white;
                padding: 1.5rem;
                border-radius: 8px;
                box-shadow: 0 2px 8px rgba(0,0,0,0.05);
                flex: 1;
                text-align: center;
            }
            .kp-value {
                font-size: 2.5rem;
                font-weight: bold;
                color: var(--primary-color);
                margin: 0.5rem 0;
            }
            .kp-label {
                color: #666;
                font-size: 0.9rem;
            }
        `;
        document.head.appendChild(style);
    }

    function renderCourseList() {
        renderAdminHeader();
        const workspace = container.querySelector('#admin-workspace');

        const card = document.createElement('div');
        card.style.background = 'white';
        card.style.padding = '2rem';
        card.style.boxShadow = '0 4px 10px rgba(0,0,0,0.05)';

        // Sort Toggle
        const currentSort = state.adminSortBy || 'openDate';
        const sortLabel = currentSort === 'openDate' ? '線上開放日期' :
            currentSort === 'actualDate' ? '實際課程日期' : '上架狀態';

        const header = document.createElement('div');
        header.className = 'flex justify-between items-center mb-4 admin-header';
        header.innerHTML = `
        <div class="flex items-center gap-4 admin-title-group">
            <h2 style="margin:0; white-space: nowrap;">課程列表</h2>
            <div class="admin-sort-controls">
                <span class="sort-label">排序:</span>
                <select id="sort-select" class="sort-select">
                    <option value="openDate" ${currentSort === 'openDate' ? 'selected' : ''}>線上開放日期</option>
                    <option value="actualDate" ${currentSort === 'actualDate' ? 'selected' : ''}>實際課程日期</option>
                    <option value="status" ${currentSort === 'status' ? 'selected' : ''}>上架狀態</option>
                </select>
            </div>
        </div>
        <div class="flex gap-2 admin-actions">
             <button class="btn" id="btn-batch-delete" style="background-color: #dc3545; display: none;">🗑️ 刪除</button>
            <button class="btn" id="btn-export-progress" style="background-color: #28a745;">📊 匯出紀錄</button>
            <button class="btn" id="btn-add-course">+ 新增課程</button>
        </div>
    `;
        card.appendChild(header);

        // Batch Delete Logic
        header.querySelector('#btn-batch-delete').onclick = async () => {
            const selected = Array.from(document.querySelectorAll('.course-checkbox:checked')).map(cb => cb.value);
            if (selected.length === 0) return;

            if (confirm(`確定要刪除選取的 ${selected.length} 堂課程嗎？\n此動作無法復原。`)) {
                try {
                    const promises = selected.map(id => deleteDoc(doc(db, "courses", id)));
                    await Promise.all(promises);
                    await fetchCourses();
                    renderCourseList();
                    alert('刪除成功！');
                } catch (e) {
                    console.error("Batch delete failed", e);
                    alert("刪除失敗: " + e.message);
                }
            }
        };

        header.querySelector('#btn-export-progress').onclick = () => showExportDialog();
        header.querySelector('#sort-select').onchange = (e) => {
            state.adminSortBy = e.target.value;
            renderCourseList();
        };

        // Course List Container
        const listDiv = document.createElement('div');
        listDiv.style.borderTop = '1px solid #eee';
        listDiv.style.marginTop = '1rem';

        // Grouping Logic
        const groups = {}; // { year: { month: [courses] } }

        // Sort courses
        const sortedCourses = [...courses].sort((a, b) => {
            if (currentSort === 'status') {
                // 1. Status: ON AIR (true) > Ended (false)
                const statusA = isCourseAvailable(a);
                const statusB = isCourseAvailable(b);
                if (statusA !== statusB) {
                    return statusA ? -1 : 1; // True comes first
                }
                // 2. Date: End Date Ascending (Old -> New)
                const endA = a.endDate || '9999-99-99';
                const endB = b.endDate || '9999-99-99';
                return endA.localeCompare(endB);
            } else {
                // Default Date Sort Descending
                const dateA = currentSort === 'openDate' ? (a.startDate || '0000-00-00') : (a.actualStartDate || '0000-00-00');
                const dateB = currentSort === 'openDate' ? (b.startDate || '0000-00-00') : (b.actualStartDate || '0000-00-00');
                return dateB.localeCompare(dateA);
            }
        });

        sortedCourses.forEach(c => {
            if (currentSort === 'status') {
                // Group by Status
                const status = isCourseAvailable(c) ? 'ON AIR' : '已結束課程';
                // Fake Year/Month structure for compatibility or simplify?
                // Let's use Year = Status, Month = '列表'
                if (!groups[status]) groups[status] = {};
                if (!groups[status]['清單']) groups[status]['清單'] = [];
                groups[status]['清單'].push(c);
            } else {
                // Date Grouping
                const dateStr = currentSort === 'openDate' ? c.startDate : c.actualStartDate;
                let year = '其他';
                let month = '其他';

                if (dateStr) {
                    try {
                        const d = new Date(dateStr);
                        if (!isNaN(d.getTime())) {
                            year = d.getFullYear().toString();
                            month = (d.getMonth() + 1).toString().padStart(2, '0') + '月';
                        }
                    } catch (e) { }
                }

                if (!groups[year]) groups[year] = {};
                if (!groups[year][month]) groups[year][month] = [];
                groups[year][month].push(c);
            }
        });

        // Render Groups
        Object.keys(groups).sort((a, b) => b.localeCompare(a)).forEach(year => {
            const yearBlock = document.createElement('details');
            yearBlock.open = true;
            yearBlock.style.marginBottom = '1rem';

            const totalInYear = Object.values(groups[year]).reduce((acc, curr) => acc + curr.length, 0);

            yearBlock.innerHTML = `
                <summary style="font-weight: bold; font-size: 1.2rem; cursor: pointer; padding: 0.5rem 0; color: #333;">
                    ${year} 年度 (${totalInYear})
                </summary>
                <div class="year-content" style="padding-left: 1rem;"></div>
            `;

            const yearContainer = yearBlock.querySelector('.year-content');

            const months = groups[year];
            Object.keys(months).sort((a, b) => b.localeCompare(a)).forEach(month => {
                const monthBlock = document.createElement('details');
                monthBlock.open = true;
                monthBlock.style.marginBottom = '0.5rem';
                monthBlock.innerHTML = `
                    <summary style="font-weight: 500; font-size: 1rem; cursor: pointer; padding: 0.5rem 0; color: #666;">
                        ${month}
                    </summary>
                    <div class="month-content" style="padding-left: 0.5rem;"></div>
                `;

                const monthContainer = monthBlock.querySelector('.month-content');

                months[month].forEach(course => {
                    const row = document.createElement('div');
                    row.className = 'course-item flex justify-between items-center';
                    row.style.padding = '1rem';
                    row.style.borderBottom = '1px solid #eee';
                    row.style.background = '#fff';

                    const isOnAir = isCourseAvailable(course);
                    const statusHtml = isOnAir
                        ? `<span style="color: #d32f2f; font-weight: bold; margin-left: 0.5rem; font-size: 0.9rem;">● ON AIR</span>`
                        : `<span style="color: #999; margin-left: 0.5rem; font-size: 0.9rem;">(已結束)</span>`;

                    const courseUrl = `${window.location.origin}${window.location.pathname}#course/${course.id}`;

                    row.innerHTML = `
                        <div style="margin-right: 15px;">
                            <input type="checkbox" class="course-checkbox" value="${course.id}" style="transform: scale(1.3); cursor: pointer;">
                        </div>
                       <div class="flex items-center" style="flex: 1;">
                           <div style="width: 16px; height: 16px; border-radius: 50%; background: ${course.color || '#ccc'}; margin-right: 1rem; flex-shrink:0;"></div>
                           <div>
                               <div style="font-weight: bold; font-size: 1.05rem; margin-bottom: 0.2rem;">
                                   ${course.title} ${statusHtml}
                               </div>
                               <div style="font-size: 0.85rem; color: #666;">
                                   開放: ${course.startDate || '-'} ~ ${course.endDate || '-'}${course.actualStartDate ? ` | 實際: ${course.actualStartDate} ~ ${course.actualEndDate || '-'}` : ''}
                               </div>
                           </div>
                       </div>
                       <div class="flex gap-2">
                            <button class="btn view-stats-btn" style="background: #17a2b8; color: white; font-size: 0.8rem; padding: 4px 8px;">查看進度</button>
                            <button class="btn copy-link-btn" data-url="${courseUrl}" style="background: #e9ecef; color: #333; font-size: 0.8rem; padding: 4px 8px;">複製連結</button>
                            <button class="btn edit-btn" style="font-size: 0.8rem; padding: 4px 8px;">編輯</button>
                            <button class="btn delete-btn" style="background-color: #dc3545; color: white; font-size: 0.8rem; padding: 4px 8px;">刪除</button>
                        </div>
                    `;

                    // Checkbox handler
                    row.querySelector('.course-checkbox').onchange = () => {
                        const anyChecked = document.querySelectorAll('.course-checkbox:checked').length > 0;
                        const btn = document.getElementById('btn-batch-delete');
                        if (btn) btn.style.display = anyChecked ? 'block' : 'none';
                    };

                    row.querySelector('.view-stats-btn').onclick = async () => {
                        const workspace = container.querySelector('#admin-workspace');
                        workspace.innerHTML = '載入中...'; // Quick feedback
                        workspace.innerHTML = '';
                        workspace.appendChild(await renderCourseStats(course.id));
                    };

                    row.querySelector('.edit-btn').onclick = () => renderEditor(course);
                    row.querySelector('.delete-btn').onclick = async () => {
                        if (confirm(`確定要刪除課程「${course.title}」嗎？\n此動作無法復原。`)) {
                            await deleteDoc(doc(db, "courses", course.id));
                            await fetchCourses();
                            renderCourseList();
                        }
                    };
                    row.querySelector('.copy-link-btn').onclick = (e) => {
                        navigator.clipboard.writeText(e.target.dataset.url).then(() => {
                            const original = e.target.textContent;
                            e.target.textContent = 'Copied!';
                            setTimeout(() => e.target.textContent = original, 2000);
                        });
                    };

                    monthContainer.appendChild(row);
                });

                yearContainer.appendChild(monthBlock);
            });
            listDiv.appendChild(yearBlock);
        });

        card.appendChild(listDiv);
        workspace.appendChild(card);

        // Add Course
        header.querySelector('#btn-add-course').onclick = () => {
            const today = new Date().toISOString().split('T')[0];
            const nextYear = new Date();
            nextYear.setFullYear(nextYear.getFullYear() + 1);

            // Open template directly
            renderEditor({
                title: '新課程',
                color: '#0ABAB5',
                startDate: today,
                endDate: nextYear.toISOString().split('T')[0],
                parts: []
            });
        };
    }

    async function renderBehavioralDashboard() {
        console.log("Entering renderBehavioralDashboard");
        renderAdminHeader();
        const workspace = container.querySelector('#admin-workspace');
        workspace.innerHTML = '<p style="text-align:center; padding:2rem;">正在分析行為數據...</p>';

        try {
            console.log("Fetching progress data...");
            const allProgress = [];

            // Try enabling direct access or fallback
            if (typeof getAllProgress === 'function') {
                try {
                    const res = await getAllProgress();
                    res.forEach(p => allProgress.push(p));
                } catch (e) {
                    console.warn("getAllProgress failed", e);
                }
            }

            if (allProgress.length === 0) {
                // Fallback to direct DB fetch
                const snapshot = await getDocs(collection(db, "userProgress"));
                snapshot.forEach(doc => allProgress.push(doc.data()));
            }

            console.log("Progress records found:", allProgress.length);

            // Aggregation Logic
            let totalTES = 0;
            let totalSeekBacks = 0;
            let totalSessions = 0;
            const courseMetrics = {}; // { courseId: { title, tes, seeks, count } }

            allProgress.forEach(p => {
                if (p.units) {
                    p.units.forEach(u => {
                        if (u.behavioralMetrics) {
                            const tes = u.behavioralMetrics.trueEngagementScore || 0;
                            const seeks = u.behavioralMetrics.seekBackCount || 0;

                            totalTES += tes;
                            totalSeekBacks += seeks;
                            totalSessions++;

                            // Course Level Aggregation
                            if (!courseMetrics[p.courseId]) {
                                courseMetrics[p.courseId] = { title: p.courseName, tes: 0, seeks: 0, count: 0 };
                            }
                            courseMetrics[p.courseId].tes += tes;
                            courseMetrics[p.courseId].seeks += seeks;
                            courseMetrics[p.courseId].count++;
                        }
                    });
                }
            });

            console.log("Aggregation complete", { totalTES, totalSessions });

            const avgTES = totalSessions > 0 ? (totalTES / totalSessions).toFixed(1) : '0.0';

            // Generate View
            workspace.innerHTML = `
                <div class="container">
                    <h2 class="mb-4">📊 行為分析儀表板 (Behavioral Analytics)</h2>
                    
                    <!-- KPI Cards -->
                    <div class="flex gap-4 mb-4" style="flex-wrap: wrap;">
                        <div class="kp-card">
                            <div class="kp-label tooltip-container">
                                平均真實參與度 (TES)
                                <span class="tooltip-text">
                                    <strong>真實參與度 (True Engagement Score)</strong><br>
                                    綜合考量觀看時長、播放速度與專注度的加權分數，比單純的「觀看時數」更能反映學習成效與專注品質。
                                </span>
                            </div>
                            <div class="kp-value">${avgTES}</div>
                            <div style="font-size:0.8rem; color:#888;">每單元平均分數</div>
                        </div>
                        <div class="kp-card">
                            <div class="kp-label tooltip-container">
                                總興趣回放次數 (Seek Backs)
                                <span class="tooltip-text">
                                    <strong>興趣回放 (Seek Back)</strong><br>
                                    學員主動倒帶重看內容的次數 (倒退超過 5 秒)。<br>
                                    高回放次數通常代表該段落是重點難點，或具有高度學習價值。
                                </span>
                            </div>
                            <div class="kp-value" style="color: #4CAF50;">${totalSeekBacks}</div>
                            <div style="font-size:0.8rem; color:#888;">全平台累計</div>
                        </div>
                        <div class="kp-card">
                            <div class="kp-label">分析樣本數</div>
                            <div class="kp-value" style="color: #FF9800;">${totalSessions}</div>
                            <div style="font-size:0.8rem; color:#888;">學習單元紀錄</div>
                        </div>
                    </div>

                    <!-- Course Breakdown -->
                    <div style="background:white; padding:2rem; border-radius:8px; box-shadow:0 4px 10px rgba(0,0,0,0.05);">
                        <h3 class="mb-4">各課程參與度排行</h3>
                        <table style="width:100%; text-align:left; border-collapse: collapse;">
                            <thead style="background:#f8f9fa;">
                                <tr>
                                    <th style="padding:1rem;">課程名稱</th>
                                    <th style="padding:1rem;">平均 TES</th>
                                    <th style="padding:1rem;">興趣回放次數</th>
                                    <th style="padding:1rem;">紀錄數</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${Object.values(courseMetrics).sort((a, b) => (b.tes / b.count) - (a.tes / a.count)).map(c => `
                                    <tr style="border-bottom:1px solid #eee;">
                                        <td style="padding:1rem; font-weight:bold;">${c.title}</td>
                                        <td style="padding:1rem;">
                                            <div style="display:flex; align-items:center; gap:10px;">
                                                <div style="width:100px; height:8px; background:#eee; border-radius:4px;">
                                                    <div style="width:${Math.min(100, (c.tes / c.count) * 2)}%; height:100%; background:var(--primary-color); border-radius:4px;"></div>
                                                </div>
                                                <span>${(c.tes / c.count).toFixed(1)}</span>
                                            </div>
                                        </td>
                                        <td style="padding:1rem; color:#4CAF50; font-weight:bold;">${c.seeks}</td>
                                        <td style="padding:1rem; color:#888;">${c.count}</td>
                                    </tr>
                                `).join('')}
                                ${Object.keys(courseMetrics).length === 0 ? '<tr><td colspan="4" style="padding:2rem; text-align:center; color:#999;">目前尚無足夠數據進行分析</td></tr>' : ''}
                            </tbody>
                        </table>
                    </div>
                </div>
            `;

        } catch (e) {
            console.error("Dashboard render failed", e);
            workspace.innerHTML = `<p style="color:red;">載入失敗: ${e.message}</p>`;
        }
    }

    async function renderUserManagement() {
        renderAdminHeader();
        const workspace = container.querySelector('#admin-workspace');

        workspace.innerHTML = '<p style="text-align:center; padding:2rem;">正在讀取學員資料...</p>';

        try {
            const [allProgress, usersSnap] = await Promise.all([
                getAllProgress(),
                getDocs(collection(db, "users"))
            ]);

            const usersMap = {};

            // 1. Load registered users
            usersSnap.forEach(docSnap => {
                const data = docSnap.data();
                usersMap[docSnap.id] = {
                    userId: docSnap.id, // ID is doc ID
                    userName: data.userName || '',
                    email: data.email || '',
                    courses: [],
                    lastActive: data.createdAt || null // Fallback
                };
            });

            // 2. Merge Progress Data
            allProgress.forEach(p => {
                if (!usersMap[p.userId]) {
                    // User has progress but not in 'users' collection (legacy or error)
                    usersMap[p.userId] = {
                        userId: p.userId,
                        userName: p.userName,
                        email: '-', // No email known
                        courses: [],
                        lastActive: null
                    };
                }

                usersMap[p.userId].courses.push(p);

                // Update timestamps
                if (p.updatedAt) {
                    if (!usersMap[p.userId].lastActive || p.updatedAt > usersMap[p.userId].lastActive) {
                        usersMap[p.userId].lastActive = p.updatedAt;
                    }
                }
            });

            const userList = Object.values(usersMap).sort((a, b) => {
                const timeA = a.lastActive || '';
                const timeB = b.lastActive || '';
                return timeB.localeCompare(timeA);
            });

            const card = document.createElement('div');
            card.style.background = 'white';
            card.style.padding = '2rem';
            card.style.borderRadius = '8px';
            card.style.boxShadow = '0 4px 10px rgba(0,0,0,0.05)';

            card.innerHTML = `
                <div class="flex justify-between items-center mb-4">
                     <h2 style="margin:0;">學員管理 (${userList.length} 人)</h2>
                     <div class="flex gap-2">
                        <button class="btn" id="btn-batch-delete-users" style="background-color: #dc3545; display: none;">🗑️ 刪除所選學員</button>
                        <button class="btn" id="btn-add-user">+ 新增學員</button>
                     </div>
                </div>
                <div style="overflow-x: auto;">
                    <table style="width: 100%; border-collapse: collapse;">
                        <thead>
                            <tr style="background: #f8f9fa; border-bottom: 2px solid #eee;">
                                <th style="padding: 1rem; text-align: left;">
                                    <input type="checkbox" id="user-select-all" style="cursor: pointer; transform: scale(1.3);">
                                </th>
                                <th style="padding: 1rem; text-align: left;">員工編號</th>
                                <th style="padding: 1rem; text-align: left;">姓名</th>
                                <th style="padding: 1rem; text-align: left;">Email</th>
                                <th style="padding: 1rem; text-align: left;">參與課程數</th>
                                <th style="padding: 1rem; text-align: left;">最後活動時間</th>
                                <th style="padding: 1rem; text-align: left;">功能</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${userList.map(u => `
                                <tr style="border-bottom: 1px solid #eee;">
                                    <td style="padding: 1rem;">
                                        <input type="checkbox" class="user-checkbox" value="${u.userId}" style="cursor: pointer; transform: scale(1.3);">
                                    </td>
                                    <td style="padding: 1rem;" data-label="員工編號">${u.userId}</td>
                                    <td style="padding: 1rem;" data-label="姓名">${u.userName}</td>
                                    <td style="padding: 1rem;" data-label="Email">${u.email || '-'}</td>
                                    <td style="padding: 1rem;" data-label="參與課程數">${u.courses.length}</td>
                                    <td style="padding: 1rem; color: #666;" data-label="最後活動時間">${u.lastActive ? new Date(u.lastActive).toLocaleString('zh-TW') : '-'}</td>
                                    <td style="padding: 1rem; display: flex; gap: 0.5rem;" data-label="功能">
                                        <button class="btn view-user-progress-btn" data-userid="${u.userId}" style="padding: 4px 12px; font-size: 0.85rem; background:#17a2b8; color:white;">學習紀錄</button>
                                        <button class="btn edit-user-btn" data-userid="${u.userId}" style="padding: 4px 12px; font-size: 0.85rem; background:#ffc107; color:black;">編輯</button>
                                    </td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>
            `;

            // Bind Edit Buttons
            card.querySelectorAll('.edit-user-btn').forEach(btn => {
                btn.onclick = () => {
                    const userId = btn.dataset.userid;
                    const user = usersMap[userId];
                    renderUserEditor(user);
                };
            });

            // Bind View Progress Buttons
            card.querySelectorAll('.view-user-progress-btn').forEach(btn => {
                btn.onclick = async () => {
                    const userId = btn.dataset.userid;
                    const workspace = container.querySelector('#admin-workspace');
                    workspace.innerHTML = '載入中...';
                    workspace.innerHTML = '';
                    workspace.appendChild(await renderProgress(userId));
                };
            });

            // Bind Delete Buttons (Single)
            card.querySelectorAll('.delete-user-btn').forEach(btn => {
                btn.onclick = async () => {
                    const userId = btn.dataset.userid;
                    const userName = btn.dataset.username;
                    if (confirm(`確定要刪除學員「${userName} (${userId})」嗎？\n此動作將一併刪除該學員的所有學習紀錄，且無法復原。`)) {
                        try {
                            await deleteUser(userId);
                            renderUserManagement(); // Reload
                        } catch (e) {
                            alert('刪除失敗: ' + e.message);
                        }
                    }
                };
            });

            // Bind Checkbox Logic
            const selectAllCb = card.querySelector('#user-select-all');
            const rowCbs = card.querySelectorAll('.user-checkbox');
            const batchDeleteBtn = card.querySelector('#btn-batch-delete-users');

            const updateBatchBtn = () => {
                const checkedCount = card.querySelectorAll('.user-checkbox:checked').length;
                batchDeleteBtn.style.display = checkedCount > 0 ? 'block' : 'none';
                batchDeleteBtn.textContent = `🗑️ 刪除所選學員 (${checkedCount})`;
            };

            selectAllCb.onchange = (e) => {
                rowCbs.forEach(cb => cb.checked = e.target.checked);
                updateBatchBtn();
            };

            rowCbs.forEach(cb => {
                cb.onchange = () => {
                    updateBatchBtn();
                    // Update header cb state
                    const allChecked = Array.from(rowCbs).every(c => c.checked);
                    selectAllCb.checked = allChecked;
                };
            });

            // Bind Batch Delete Button
            batchDeleteBtn.onclick = async () => {
                const selectedIds = Array.from(card.querySelectorAll('.user-checkbox:checked')).map(cb => cb.value);
                if (selectedIds.length === 0) return;

                if (confirm(`確定要刪除選取的 ${selectedIds.length} 位學員嗎？\n這些學員的學習紀錄也將一併刪除，且無法復原。`)) {
                    try {
                        const btnText = batchDeleteBtn.textContent;
                        batchDeleteBtn.disabled = true;
                        batchDeleteBtn.textContent = '刪除中...';

                        await batchDeleteUsers(selectedIds);

                        renderUserManagement(); // Reload
                        alert('批次刪除成功！');
                    } catch (e) {
                        console.error(e);
                        alert('批次刪除部分或全部失敗: ' + e.message);
                        batchDeleteBtn.disabled = false;
                        renderUserManagement(); // Check what's left
                    }
                }
            };

            // Bind Add User Button
            card.querySelector('#btn-add-user').onclick = () => {
                renderUserEditor(null);
            };

            workspace.innerHTML = '';
            workspace.appendChild(card);

        } catch (e) {
            console.error(e);
            workspace.innerHTML = `<p style="color:red; text-align:center;">讀取失敗: ${e.message}</p>`;
        }

    }

    async function deleteUser(userId) {
        // 1. Delete user document
        await deleteDoc(doc(db, "users", userId));

        // 2. Delete user progress documents
        // Need to query all progress documents for this user
        const q = query(collection(db, 'userProgress'), where('userId', '==', userId));
        const snapshot = await getDocs(q);
        const deletePromises = [];
        snapshot.forEach(docSnap => {
            deletePromises.push(deleteDoc(doc(db, 'userProgress', docSnap.id)));
        });
        await Promise.all(deletePromises);
    }

    async function batchDeleteUsers(userIds) {
        // Parallel delete
        const promises = userIds.map(id => deleteUser(id));
        await Promise.all(promises);
    }

    function renderUserEditor(user) {
        const isNew = !user;
        const editingUser = user || { userId: '', userName: '', email: '' };

        const workspace = container.querySelector('#admin-workspace');

        const card = document.createElement('div');
        card.style.background = 'white';
        card.style.padding = '2rem';
        card.style.borderRadius = '8px';
        card.style.boxShadow = '0 4px 10px rgba(0,0,0,0.05)';

        const idInputHtml = isNew
            ? `<input type="text" id="edit-user-id" value="" placeholder="請輸入員工編號 (例如: EMP001)" style="width: 100%; padding: 10px; border: 1px solid #ddd;">`
            : `<input type="text" value="${editingUser.userId}" disabled style="width: 100%; padding: 10px; background: #f5f5f5; border: 1px solid #ddd; cursor: not-allowed;">
               <p style="font-size:0.85rem; color:#999; margin-top:0.25rem;">員工編號無法修改</p>`;

        card.innerHTML = `
            <div class="flex justify-between items-center mb-4">
                <h2 style="margin:0;">${isNew ? '新增學員' : '編輯學員資料'}</h2>
                <button class="btn" id="btn-back-users" style="background-color: #6c757d;">&larr; 返回列表</button>
            </div>
            
            <div style="max-width: 600px; margin: 2rem auto; border: 1px solid #eee; padding: 2rem; border-radius: 8px;">
                <div class="form-group margin-bottom: 1.5rem;">
                    <label style="display:block; margin-bottom:0.5rem; font-weight:bold;">員工編號</label>
                    ${idInputHtml}
                </div>
                
                <div class="form-group margin-bottom: 1.5rem;">
                    <label style="display:block; margin-bottom:0.5rem; font-weight:bold;">姓名</label>
                    <input type="text" id="edit-user-name" value="${editingUser.userName}" style="width: 100%; padding: 10px; border: 1px solid #ddd;">
                </div>
                
                <div class="form-group margin-bottom: 2rem;">
                    <label style="display:block; margin-bottom:0.5rem; font-weight:bold;">Email</label>
                    <input type="email" id="edit-user-email" value="${editingUser.email || ''}" style="width: 100%; padding: 10px; border: 1px solid #ddd;">
                </div>
                
                <div class="flex justify-end gap-2">
                    <button class="btn" id="btn-cancel-user" style="background: #ccc; color: #333;">取消</button>
                    <button class="btn" id="btn-save-user">${isNew ? '新增學員' : '儲存變更'}</button>
                </div>
            </div>
        `;

        const goBack = () => renderUserManagement();

        card.querySelector('#btn-back-users').onclick = goBack;
        card.querySelector('#btn-cancel-user').onclick = goBack;

        card.querySelector('#btn-save-user').onclick = async () => {
            let userId = editingUser.userId;

            // Check ID if new
            if (isNew) {
                const idInput = card.querySelector('#edit-user-id');
                if (idInput) {
                    userId = idInput.value.trim().toUpperCase();
                }
                if (!userId) {
                    alert('請輸入員工編號');
                    return;
                }
                // Check format (optional, e.g. alphanumeric)
                if (!/^[A-Z0-9]+$/i.test(userId)) {
                    alert('員工編號只能包含英數字');
                    return;
                }
            }

            const newName = card.querySelector('#edit-user-name').value.trim();
            const newEmail = card.querySelector('#edit-user-email').value.trim();

            if (!newName || !newEmail) {
                alert('請填寫所有欄位');
                return;
            }
            // Basic Email Regex
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            if (!emailRegex.test(newEmail)) {
                alert('請輸入有效的 Email 格式');
                return;
            }

            try {
                if (isNew) {
                    // Check if exists
                    const docRef = doc(db, "users", userId);
                    const docSnap = await getDoc(docRef);
                    if (docSnap.exists()) {
                        alert('此員工編號已存在');
                        return;
                    }

                    await setDoc(docRef, {
                        userId,
                        userName: newName,
                        email: newEmail,
                        createdAt: new Date().toISOString()
                    });
                    alert('新增成功');
                } else {
                    // Update Firestore
                    await setDoc(doc(db, "users", userId), {
                        userName: newName,
                        email: newEmail,
                        // Preserve createdAt? setDoc(..., {merge: true}) will preserve it.
                    }, { merge: true });
                    alert('儲存成功');
                }

                renderUserManagement();

            } catch (e) {
                console.error(e);
                alert('儲存失敗: ' + e.message);
            }
        };

        workspace.innerHTML = '';
        workspace.appendChild(card);
    }

    function renderEditor(course) {
        // Clone course to avoid mutating local state before save (optional preference, but good for "Cancel")
        // For simplicity here, we edit a local copy and push on save.
        let editingCourse = JSON.parse(JSON.stringify(course));

        const workspace = container.querySelector('#admin-workspace');
        workspace.innerHTML = '';

        // Determine if creating new
        const isNew = !course.id;

        const editorCard = document.createElement('div');
        editorCard.style.background = 'white';
        editorCard.style.padding = '2rem';
        editorCard.style.boxShadow = '0 4px 10px rgba(0,0,0,0.05)';

        editorCard.innerHTML = `
            <div class="flex justify-between items-center mb-4">
                <h2>${isNew ? '新增課程' : '編輯課程'}</h2>
                <button class="btn" id="btn-back-list" style="background-color: #6c757d;">&larr; 返回列表</button>
            </div>
        <div class="course-editor" style="border: 1px solid var(--border-color); padding: 2rem; margin-top: 2rem;">
            <div class="form-group mb-4"><label><strong>課程標題</strong></label><input type="text" id="edit-title" value="${editingCourse.title}" /></div>
            <div class="grid gap-4 mb-4" style="grid-template-columns: 1fr 1fr;">
                <div><label><strong>線上開放日期</strong></label><input type="date" id="edit-start" value="${editingCourse.startDate || ''}" style="width:100%; padding: 8px; border: 1px solid #ddd;" /></div>
                <div><label><strong>線上結束日期</strong></label><input type="date" id="edit-end" value="${editingCourse.endDate || ''}" style="width:100%; padding: 8px; border: 1px solid #ddd;" /></div>
            </div>
            <div class="grid gap-4 mb-4" style="grid-template-columns: 1fr 1fr;">
                <div><label><strong>實際課程開始日期</strong></label><input type="date" id="edit-actual-start" value="${editingCourse.actualStartDate || ''}" style="width:100%; padding: 8px; border: 1px solid #ddd;" /></div>
                <div><label><strong>實際課程結束日期</strong></label><input type="date" id="edit-actual-end" value="${editingCourse.actualEndDate || ''}" style="width:100%; padding: 8px; border: 1px solid #ddd;" /></div>
            </div>
            <div class="form-group mb-4">
                <label><strong>課程時數（小時）</strong></label>
                <input type="number" id="edit-course-hours" value="${editingCourse.courseHours || ''}" min="0" step="0.5" placeholder="例如: 8" style="width: 200px; padding: 8px; border: 1px solid #ddd;" />
            </div>
                <div class="flex items-center">
                    <input type="color" id="edit-color" value="${editingCourse.color || '#0ABAB5'}" style="height: 40px; width: 60px; padding: 0; border: none; cursor: pointer;" />
                    <span style="margin-left: 10px; color: #666;">點擊選擇顏色</span>
                </div>
            </div>
            
            <div class="form-group mb-4" style="background: #f8f9fa; padding: 1rem; border-radius: 4px; border: 1px solid #eee;">
                <div class="flex items-center mb-2">
                    <input type="checkbox" id="user-permission-toggle" ${(editingCourse.allowedUserIds && editingCourse.allowedUserIds.length > 0) ? 'checked' : ''} style="width: 18px; height: 18px; margin-right: 10px; cursor: pointer;">
                    <label for="user-permission-toggle" style="margin: 0; cursor: pointer; font-weight: bold;">僅限特定人員觀看</label>
                </div>
                
                <div id="permission-input-container" style="display: ${(editingCourse.allowedUserIds && editingCourse.allowedUserIds.length > 0) ? 'block' : 'none'}; padding-left: 1.8rem;">
                    
                    <div style="margin-bottom: 0.5rem; display: flex; gap: 10px; align-items: center; flex-wrap: wrap;">
                        <button id="btn-import-permissions" class="btn" style="padding: 4px 12px; font-size: 0.85rem; background: #17a2b8; color: white; border: none; border-radius: 4px; display: flex; align-items: center; gap: 4px;">
                            <span>📂</span> 匯入名單
                        </button>
                        <button id="btn-download-example" class="btn" style="padding: 4px 12px; font-size: 0.85rem; background: white; border: 1px solid #ddd; color: #666; border-radius: 4px; display: flex; align-items: center; gap: 4px;">
                            <span>⬇️</span> 下載範例檔
                        </button>
                        <input type="file" id="permission-file-input" accept=".csv,.txt" style="display: none;">
                        <span style="font-size: 0.8rem; color: #888;">支援 CSV, TXT 格式</span>
                    </div>

                    <div style="font-size: 0.85rem; color: #666; margin-bottom: 0.5rem;">
                        請輸入允許觀看此課程的員工編號，以逗號分隔 (例如: EMP001, EMP002)
                    </div>
                    <textarea id="edit-permissions" rows="3" style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px;" placeholder="EMP001, EMP002, ...">${(editingCourse.allowedUserIds || []).join(', ')}</textarea>
                </div>
            </div>
            <hr style="border:0; border-top:1px solid #eee; margin: 2rem 0;">
                <h4>單元管理</h4>
                <div id="unit-list-container"></div>
                <div class="flex gap-4 mt-4">
                    <button class="btn" id="btn-add-video" style="flex:1; background: transparent; border: 2px dashed var(--primary-color); color: var(--primary-color);">+ 新增單元 (影片)</button>
                    <button class="btn" id="btn-add-quiz" style="flex:1; background: transparent; border: 2px dashed #ff6b6b; color: #ff6b6b;">+ 新增課程測驗</button>
                </div>
                <div class="mt-4 flex justify-between">
                    <button class="btn" style="background: #ccc; color: #333;" id="btn-cancel">取消 / 返回</button>
                    <button class="btn" id="btn-save">儲存變更</button>
                </div>
        </div>
                    `;

        const unitContainer = editorCard.querySelector('#unit-list-container');
        const renderUnits = () => {
            unitContainer.innerHTML = '';
            let videoCount = 0;
            (editingCourse.parts || []).forEach((part, idx) => {
                if (part.type === 'video') videoCount++;
                const isQuiz = part.type === 'quiz';
                const row = document.createElement('div');
                row.style.cssText = `background: var(--light-gray); padding: 1rem; margin-bottom: 1rem; border-left: 4px solid ${isQuiz ? '#ff6b6b' : (editingCourse.color || '#0ABAB5')}`;

                row.innerHTML = `
                        <div class="flex justify-between items-center mb-2">
                        <h5 style="margin:0;"><span style="background:${isQuiz ? '#ff6b6b' : '#666'}; color:white; padding:2px 6px; border-radius:4px; font-size:0.8rem; margin-right:8px;">${isQuiz ? '測驗' : '影片單元'}</span>${part.title}</h5>
                        <button class="btn btn-danger delete-unit-btn" data-idx="${idx}" style="padding: 4px 8px; font-size: 0.8rem;">刪除</button>
                    </div>
                        <div class="grid gap-4" style="grid-template-columns: 1fr 1fr;">
                            <div><label style="font-size:0.9rem">顯示名稱</label><input type="text" class="unit-title-input" data-idx="${idx}" value="${part.title}" /></div>
                            <div>
                                <label style="font-size:0.9rem">${isQuiz ? 'Google 表單網址' : '影片網址'}</label>
                                <input type="text" class="unit-url-input" data-idx="${idx}" value="${part.url || ''}" />
                                ${isQuiz ? `
                                    <div style="margin-top:0.5rem;">
                                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 2px;">
                                            <label style="font-size:0.8rem; color:#666; margin:0;">防呆驗證碼 (選填)</label>
                                            <button class="btn toggle-quiz-instruction" style="background:none; border:none; padding:0; color:var(--primary-color); font-size:0.8rem; cursor:pointer; text-decoration:underline;">如何設定驗證碼?</button>
                                        </div>
                                        <input type="text" class="unit-code-input" data-idx="${idx}" value="${part.verificationCode || ''}" placeholder="例如: 1234" style="font-size:0.85rem; padding:4px; width: 100%; border: 1px solid #ddd; border-radius: 4px;" />
                                        
                                        <div class="quiz-instruction-box" style="display:none; margin-top:0.5rem; padding:0.8rem; background:#fff; border:1px solid #17a2b8; border-radius:4px; font-size:0.85rem; color:#555; box-shadow: 0 2px 5px rgba(0,0,0,0.05);">
                                            <strong style="color:#17a2b8;">💡 Google 表單設定步驟：</strong>
                                            <div style="margin-top:0.5rem; line-height:1.5;">
                                                Google 表單的「<strong>設定</strong>」->「<strong>簡報</strong>」->「<strong>確認訊息</strong>」->「<strong>編輯</strong>」，<br>
                                                填寫：「感謝您的填寫，您的完成驗證碼為：<strong>Pass123(自己設定</strong>」->「<strong>儲存</strong>」
                                            </div>
                                        </div>
                                    </div>
                                ` : ''}
                            </div>
                        </div>
                    `;
                unitContainer.appendChild(row);
            });

            // Bind inputs
            unitContainer.querySelectorAll('.unit-title-input').forEach(i => i.oninput = (e) => editingCourse.parts[e.target.dataset.idx].title = e.target.value);
            unitContainer.querySelectorAll('.unit-url-input').forEach(i => i.oninput = (e) => editingCourse.parts[e.target.dataset.idx].url = e.target.value);
            unitContainer.querySelectorAll('.unit-code-input').forEach(i => i.oninput = (e) => editingCourse.parts[e.target.dataset.idx].verificationCode = e.target.value);

            // Bind instruction toggles
            unitContainer.querySelectorAll('.toggle-quiz-instruction').forEach(btn => {
                btn.onclick = (e) => {
                    e.preventDefault();
                    const container = e.target.closest('div').parentElement;
                    const box = container.querySelector('.quiz-instruction-box');
                    if (box) {
                        const isHidden = box.style.display === 'none';
                        box.style.display = isHidden ? 'block' : 'none';
                        e.target.textContent = isHidden ? '隱藏設定說明' : '如何設定驗證碼?';
                    }
                };
            });

            unitContainer.querySelectorAll('.delete-unit-btn').forEach(btn => btn.onclick = (e) => {
                editingCourse.parts.splice(e.target.dataset.idx, 1);
                renderUnits();
            });
        };

        renderUnits();

        // Editor Bindings
        editorCard.querySelector('#edit-title').oninput = (e) => editingCourse.title = e.target.value;
        editorCard.querySelector('#edit-start').oninput = (e) => editingCourse.startDate = e.target.value;
        editorCard.querySelector('#edit-end').oninput = (e) => editingCourse.endDate = e.target.value;
        editorCard.querySelector('#edit-actual-start').oninput = (e) => editingCourse.actualStartDate = e.target.value;
        editorCard.querySelector('#edit-actual-end').oninput = (e) => editingCourse.actualEndDate = e.target.value;
        editorCard.querySelector('#edit-course-hours').oninput = (e) => editingCourse.courseHours = parseFloat(e.target.value) || null;
        editorCard.querySelector('#edit-color').oninput = (e) => { editingCourse.color = e.target.value; renderUnits(); };
        editorCard.querySelector('#user-permission-toggle').onchange = (e) => {
            const container = editorCard.querySelector('#permission-input-container');
            container.style.display = e.target.checked ? 'block' : 'none';
        };

        editorCard.querySelector('#edit-permissions').oninput = (e) => {
            const val = e.target.value;
            // Split by comma, trim, and remove empty strings
            editingCourse.allowedUserIds = val.split(/[,，\n]/).map(s => s.trim()).filter(s => s);
        };

        // --- Batch Import Logic ---

        // 1. Trigger File Input
        editorCard.querySelector('#btn-import-permissions').onclick = () => {
            editorCard.querySelector('#permission-file-input').click();
        };

        // 2. Handle File Selection
        editorCard.querySelector('#permission-file-input').onchange = (e) => {
            const file = e.target.files[0];
            if (!file) return;

            const reader = new FileReader();
            reader.onload = (event) => {
                const text = event.target.result;

                // 1. Split by newlines first to handle header
                let lines = text.split(/\r?\n/);

                // 2. Filter out header if it contains specific keywords
                if (lines.length > 0 && (lines[0].includes('員工編號') || lines[0].includes('Employee ID'))) {
                    lines.shift(); // Remove first line
                }

                // 3. Join remaining lines and parse IDs
                // Parse IDs: split by newlines or commas, remove quotes if CSV
                const remainingText = lines.join('\n');
                let ids = remainingText.split(/[\r\n,]+/)
                    .map(id => id.trim().replace(/^['"]|['"]$/g, '')) // remove surrounding quotes
                    .filter(id => id && !id.includes('員工編號') && !id.includes('Employee ID')); // Double check filter

                if (ids.length > 0) {
                    // Merge with existing or overwrite? Let's Merge and Deduplicate for better UX
                    const currentIds = editingCourse.allowedUserIds || [];
                    const newSet = new Set([...currentIds, ...ids]);
                    editingCourse.allowedUserIds = Array.from(newSet);

                    // Update UI
                    editorCard.querySelector('#edit-permissions').value = editingCourse.allowedUserIds.join(', ');
                    alert(`已匯入 ${ids.length} 筆資料`);
                } else {
                    alert('檔案中未找到有效資料');
                }
                // Reset input
                e.target.value = '';
            };
            reader.readAsText(file);
        };

        // 3. Download Example
        editorCard.querySelector('#btn-download-example').onclick = () => {
            // Add BOM for Excel to open UTF-8 correctly
            const bom = "\uFEFF";
            const exampleContent = bom + "員工編號 (Employee ID)\nEMP001\nEMP002\nEMP003";
            const blob = new Blob([exampleContent], { type: 'text/csv;charset=utf-8;' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.setAttribute('href', url);
            link.setAttribute('download', 'permission_import_example.csv');
            link.style.visibility = 'hidden';
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        };
        // --------------------------

        // Add Units
        editorCard.querySelector('#btn-add-video').onclick = () => {
            const vCount = editingCourse.parts.filter(p => p.type === 'video').length;
            editingCourse.parts.push({ type: 'video', title: `單元 ${vCount + 1} `, url: '' });
            renderUnits();
        };
        editorCard.querySelector('#btn-add-quiz').onclick = () => {
            editingCourse.parts.push({ type: 'quiz', title: '課後測驗', url: '' });
            renderUnits();
        };


        // Actions
        // Fix: Use renderCourseList, as renderList is not defined in this scope
        const goBack = () => renderCourseList();
        editorCard.querySelector('#btn-back-list').onclick = goBack;
        editorCard.querySelector('#btn-cancel').onclick = goBack;

        // SAVE TO FIREBASE
        editorCard.querySelector('#btn-save').onclick = async () => {
            try {
                if (confirm('確定要儲存變更嗎？')) {
                    // Check toggle state
                    const isRestricted = editorCard.querySelector('#user-permission-toggle').checked;
                    if (!isRestricted) {
                        editingCourse.allowedUserIds = [];
                    }

                    if (isNew) {
                        // CREATE
                        await addDoc(collection(db, "courses"), editingCourse);
                    } else {
                        // UPDATE
                        // Remove ID from object before saving (updateDoc takes ID separately)
                        const { id, ...dataToSave } = editingCourse;
                        await updateDoc(doc(db, "courses", course.id), dataToSave);
                    }

                    await fetchCourses(); // Refresh local
                    alert('儲存成功！');
                    renderCourseList();
                }
            } catch (e) {
                console.error(e);
                alert('儲存失敗: ' + e.message);
            }
        };

        workspace.appendChild(editorCard);
    }

    // Export Dialog
    function showExportDialog() {
        const modal = document.createElement('div');
        modal.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); display: flex; justify-content: center; align-items: center; z-index: 9999;';

        const dialog = document.createElement('div');
        dialog.style.cssText = 'background: white; padding: 2rem; border-radius: 8px; max-width: 600px; width: 90%; max-height: 80vh; overflow-y: auto;';

        // 1. Get Unique Years
        const years = Array.from(new Set(courses.map(c => {
            if (!c.startDate) return '未設定';
            try {
                return new Date(c.startDate).getFullYear().toString();
            } catch (e) { return '未設定'; }
        }))).sort().reverse();

        // 2. Build course selection options with data-year attribute
        let courseOptionsHTML = courses.map(course => {
            let year = '未設定';
            if (course.startDate) {
                try {
                    year = new Date(course.startDate).getFullYear().toString();
                } catch (e) { }
            }
            return `
                <div class="course-option-wrapper" data-year="${year}">
                    <label style="display: block; margin-bottom: 0.75rem; cursor: pointer;">
                        <input type="checkbox" class="export-course" value="${course.id}" checked>
                        <span style="margin-left: 0.5rem; display: inline-flex; align-items: center;">
                            <span style="display: inline-block; width: 12px; height: 12px; border-radius: 50%; background: ${course.color || '#0ABAB5'}; margin-right: 0.5rem;"></span>
                            ${course.title}
                            <span style="color: #999; font-size: 0.8rem; margin-left: 0.5rem;">(${year})</span>
                        </span>
                    </label>
                </div>
            `;
        }).join('');

        dialog.innerHTML = `
            <div style="margin-bottom: 1.5rem;">
                <h2 style="margin: 0 0 0.5rem 0;">匯出課程紀錄</h2>
                <p style="color: #666; font-size: 0.9rem;">請選擇要匯出的課程與欄位</p>
            </div>
            
            <div style="border: 1px solid #ddd; padding: 1.5rem; border-radius: 4px; margin-bottom: 1.5rem; background: #f8f9fa;">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem;">
                    <h4 style="margin: 0;">選擇課程</h4>
                    <div style="display: flex; gap: 0.5rem; align-items: center;">
                        <select id="export-year-filter" style="padding: 4px; border-radius: 4px; border: 1px solid #ddd; font-size: 0.85rem; margin-right: 0.5rem;">
                            <option value="all">所有年份</option>
                            ${years.map(y => `<option value="${y}">${y} 年</option>`).join('')}
                        </select>
                        <button id="btn-select-all-courses" class="btn" style="padding: 4px 12px; font-size: 0.85rem; background: transparent; border: 1px solid #0ABAB5; color: #0ABAB5;">全選</button>
                        <button id="btn-deselect-all-courses" class="btn" style="padding: 4px 12px; font-size: 0.85rem; background: transparent; border: 1px solid #6c757d; color: #6c757d;">取消全選</button>
                    </div>
                </div>
                <div style="max-height: 200px; overflow-y: auto;">
                    ${courseOptionsHTML}
                </div>
            </div>
            
            <div style="border: 1px solid #ddd; padding: 1.5rem; border-radius: 4px; margin-bottom: 1.5rem;">
                <h4 style="margin: 0 0 1rem 0;">基本資訊</h4>
                <label style="display: block; margin-bottom: 0.75rem; cursor: pointer;">
                    <input type="checkbox" class="export-field" value="userId" checked>
                    <span style="margin-left: 0.5rem;">員工編號</span>
                </label>
                <label style="display: block; margin-bottom: 0.75rem; cursor: pointer;">
                    <input type="checkbox" class="export-field" value="userName" checked>
                    <span style="margin-left: 0.5rem;">姓名</span>
                </label>
                <label style="display: block; margin-bottom: 0.75rem; cursor: pointer;">
                    <input type="checkbox" class="export-field" value="courseName" checked>
                    <span style="margin-left: 0.5rem;">課程名稱</span>
                </label>
            </div>
            
            <div style="border: 1px solid #ddd; padding: 1.5rem; border-radius: 4px; margin-bottom: 1.5rem;">
                <h4 style="margin: 0 0 1rem 0;">課程進度</h4>
                <label style="display: block; margin-bottom: 0.75rem; cursor: pointer;">
                    <input type="checkbox" class="export-field" value="status" checked>
                    <span style="margin-left: 0.5rem;">學習狀態（已完成/學習中/未開始）</span>
                </label>
                <label style="display: block; margin-bottom: 0.75rem; cursor: pointer;">
                    <input type="checkbox" class="export-field" value="completionRate" checked>
                    <span style="margin-left: 0.5rem;">完成度（%）</span>
                </label>
                <label style="display: block; margin-bottom: 0.75rem; cursor: pointer;">
                    <input type="checkbox" class="export-field" value="completedUnits" checked>
                    <span style="margin-left: 0.5rem;">已完成單元數</span>
                </label>
                <label style="display: block; margin-bottom: 0.75rem; cursor: pointer;">
                    <input type="checkbox" class="export-field" value="totalUnits" checked>
                    <span style="margin-left: 0.5rem;">總單元數</span>
                </label>
                <label style="display: block; margin-bottom: 0.75rem; cursor: pointer;">
                    <input type="checkbox" class="export-field" value="updatedAt">
                    <span style="margin-left: 0.5rem;">最後學習時間</span>
                </label>
            </div>
            
            <div style="border: 1px solid #ddd; padding: 1.5rem; border-radius: 4px; margin-bottom: 1.5rem;">
                <h4 style="margin: 0 0 1rem 0;">單元詳細資訊</h4>
                <label style="display: block; margin-bottom: 0.75rem; cursor: pointer;">
                    <input type="checkbox" class="export-field" value="unitDetails">
                    <span style="margin-left: 0.5rem;">各單元完成狀態（每個單元一欄）</span>
                </label>
                <label style="display: block; margin-bottom: 0.75rem; cursor: pointer;">
                    <input type="checkbox" class="export-field" value="unitProgress">
                    <span style="margin-left: 0.5rem;">各單元觀看進度（%）</span>
                </label>
                <label style="display: block; margin-bottom: 0.75rem; cursor: pointer;">
                    <input type="checkbox" class="export-field" value="viewCount">
                    <span style="margin-left: 0.5rem;">各單元觀看次數</span>
                </label>
            </div>
            
            <div style="display: flex; gap: 1rem; justify-content: flex-end;">
                <button id="btn-cancel-export" class="btn" style="background-color: #6c757d;">取消</button>
                <button id="btn-confirm-export" class="btn" style="background-color: #28a745;">確定匯出</button>
            </div>
                    `;

        modal.appendChild(dialog);
        document.body.appendChild(modal);

        // Close handlers
        const closeModal = () => document.body.removeChild(modal);
        modal.onclick = (e) => { if (e.target === modal) closeModal(); };
        dialog.querySelector('#btn-cancel-export').onclick = closeModal;

        // Year Filter Logic
        const filterSelect = dialog.querySelector('#export-year-filter');
        const courseWrappers = dialog.querySelectorAll('.course-option-wrapper');

        filterSelect.onchange = (e) => {
            const selectedYear = e.target.value;
            courseWrappers.forEach(wrapper => {
                if (selectedYear === 'all' || wrapper.dataset.year === selectedYear) {
                    wrapper.style.display = 'block';
                } else {
                    wrapper.style.display = 'none';
                }
            });
        };

        // Course selection handlers
        dialog.querySelector('#btn-select-all-courses').onclick = () => {
            // Only select visible
            let visibleCount = 0;
            courseWrappers.forEach(wrapper => {
                if (wrapper.style.display !== 'none') {
                    const cb = wrapper.querySelector('.export-course');
                    cb.checked = true;
                    visibleCount++;
                }
            });
        };
        dialog.querySelector('#btn-deselect-all-courses').onclick = () => {
            // Only deselect visible
            courseWrappers.forEach(wrapper => {
                if (wrapper.style.display !== 'none') {
                    const cb = wrapper.querySelector('.export-course');
                    cb.checked = false;
                }
            });
        };

        // Export handler
        dialog.querySelector('#btn-confirm-export').onclick = async () => {
            const selectedCourses = [];
            dialog.querySelectorAll('.export-course:checked').forEach(cb => {
                selectedCourses.push(cb.value);
            });

            if (selectedCourses.length === 0) {
                alert('請至少選擇一個課程');
                return;
            }

            const selectedFields = [];
            dialog.querySelectorAll('.export-field:checked').forEach(cb => {
                selectedFields.push(cb.value);
            });

            if (selectedFields.length === 0) {
                alert('請至少選擇一個欄位');
                return;
            }

            // Show loading
            const btn = dialog.querySelector('#btn-confirm-export');
            btn.textContent = '匯出中...';
            btn.disabled = true;

            try {
                await exportProgressToCSV(selectedFields, selectedCourses);
                closeModal();
            } catch (e) {
                alert('匯出失敗: ' + e.message);
                btn.textContent = '確定匯出';
                btn.disabled = false;
            }
        };
    }

    // Export to CSV function
    async function exportProgressToCSV(selectedFields, selectedCourseIds) {
        // Get all progress data
        const allProgress = await getAllProgress();

        // Filter by selected courses
        const filteredProgress = allProgress.filter(progress =>
            selectedCourseIds.includes(progress.courseId)
        );

        if (filteredProgress.length === 0) {
            alert('所選課程目前沒有任何學習紀錄可以匯出');
            return;
        }

        // Build CSV headers
        const headers = [];
        const fieldMap = {
            'userId': '員工編號',
            'userName': '姓名',
            'courseName': '課程名稱',
            'status': '學習狀態',
            'completionRate': '完成度(%)',
            'completedUnits': '已完成單元數',
            'totalUnits': '總單元數',
            'updatedAt': '最後學習時間'
        };

        selectedFields.forEach(field => {
            if (fieldMap[field]) {
                headers.push(fieldMap[field]);
            }
        });

        // Prepare rows
        const rows = [];

        // Check if we need unit details
        const needUnitDetails = selectedFields.includes('unitDetails');
        const needUnitProgress = selectedFields.includes('unitProgress');
        const needViewCount = selectedFields.includes('viewCount');

        // Find max unit count for header alignment
        let maxUnits = 0;
        if (needUnitDetails || needUnitProgress || needViewCount) {
            filteredProgress.forEach(progress => {
                const unitCount = progress.units?.length || 0;
                if (unitCount > maxUnits) maxUnits = unitCount;
            });
        }

        // Add unit headers if needed
        if (needUnitDetails) {
            for (let i = 0; i < maxUnits; i++) {
                headers.push(`單元${i + 1} _完成狀態`);
            }
        }
        if (needUnitProgress) {
            for (let i = 0; i < maxUnits; i++) {
                headers.push(`單元${i + 1} _觀看進度(%)`);
            }
        }
        if (needViewCount) {
            for (let i = 0; i < maxUnits; i++) {
                headers.push(`單元${i + 1} _觀看次數`);
            }
        }

        rows.push(headers);

        // Build data rows
        filteredProgress.forEach(progress => {
            const row = [];

            selectedFields.forEach(field => {
                if (field === 'userId') {
                    row.push(progress.userId || '');
                } else if (field === 'userName') {
                    row.push(progress.userName || '');
                } else if (field === 'courseName') {
                    row.push(progress.courseName || '');
                } else if (field === 'status') {
                    const statusText = progress.status === 'completed' ? '已完成' :
                        progress.status === 'in-progress' ? '學習中' : '未開始';
                    row.push(statusText);
                } else if (field === 'completionRate') {
                    row.push(progress.completionRate || 0);
                } else if (field === 'completedUnits') {
                    const completed = progress.units?.filter(u => u.completed || u.quizCompleted).length || 0;
                    row.push(completed);
                } else if (field === 'totalUnits') {
                    row.push(progress.units?.length || 0);
                } else if (field === 'updatedAt') {
                    const date = progress.updatedAt ? new Date(progress.updatedAt).toLocaleString('zh-TW') : '';
                    row.push(date);
                }
            });

            // Add unit details
            if (needUnitDetails) {
                for (let i = 0; i < maxUnits; i++) {
                    const unit = progress.units?.[i];
                    if (unit) {
                        const isCompleted = unit.completed || unit.quizCompleted;
                        row.push(isCompleted ? '已完成' : '未完成');
                    } else {
                        row.push('');
                    }
                }
            }

            if (needUnitProgress) {
                for (let i = 0; i < maxUnits; i++) {
                    const unit = progress.units?.[i];
                    if (unit && unit.duration > 0) {
                        const percent = Math.round((unit.lastPosition / unit.duration) * 100);
                        row.push(percent);
                    } else {
                        row.push('');
                    }
                }
            }

            if (needViewCount) {
                for (let i = 0; i < maxUnits; i++) {
                    const unit = progress.units?.[i];
                    row.push(unit?.viewCount || 0);
                }
            }

            rows.push(row);
        });

        // Convert to CSV
        const csvContent = rows.map(row => {
            return row.map(cell => {
                // Escape quotes and wrap in quotes if contains comma or newline
                const cellStr = String(cell);
                if (cellStr.includes(',') || cellStr.includes('\n') || cellStr.includes('"')) {
                    return '"' + cellStr.replace(/"/g, '""') + '"';
                }
                return cellStr;
            }).join(',');
        }).join('\n');

        // Add BOM for Excel UTF-8 support
        const BOM = '\uFEFF';
        const blob = new Blob([BOM + csvContent], { type: 'text/csv;charset=utf-8;' });

        // Download
        const link = document.createElement('a');
        const url = URL.createObjectURL(blob);
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
        link.setAttribute('href', url);
        link.setAttribute('download', `課程紀錄_${timestamp}.csv`);
        link.style.visibility = 'hidden';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);

        alert('匯出成功！');
    }

    if (state.adminViewMode === 'users') {
        setTimeout(renderUserManagement, 0);
    } else if (state.adminViewMode === 'behavior') {
        setTimeout(renderBehavioralDashboard, 0);
    } else if (state.adminViewMode === 'archives') {
        setTimeout(renderArchivesView, 0);
    } else {
        setTimeout(renderCourseList, 0);
    }
    return container;
}

// ============== V5: ARCHIVES VIEW ==============
async function renderArchivesView() {
    const workspace = document.querySelector('#admin-workspace');
    workspace.innerHTML = '<p style="text-align:center;">載入中...</p>';

    try {
        const q = query(collection(db, "users"), where("status", "==", "archived"));
        const snapshot = await getDocs(q);
        const archivedUsers = [];
        snapshot.forEach(d => archivedUsers.push({ uid: d.id, ...d.data() }));

        workspace.innerHTML = `
            <div style="background:white; padding:2rem; border-radius:8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
                <h2 style="margin-bottom: 1.5rem; color: var(--primary-color);">📦 歷史封存庫</h2>
                <p style="color: #666; margin-bottom: 2rem;">共 ${archivedUsers.length} 筆封存紀錄</p>
                
                <table class="full-width" style="border-collapse: collapse;">
                    <thead>
                        <tr style="background: #f8f9fa; text-align:left; border-bottom:2px solid #dee2e6;">
                            <th style="padding:12px;">姓名</th>
                            <th style="padding:12px;">Email</th>
                            <th style="padding:12px;">員工編號</th>
                            <th style="padding:12px;">封存原因</th>
                            <th style="padding:12px;">封存日期</th>
                            <th style="padding:12px;">操作</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${archivedUsers.length === 0 ?
                '<tr><td colspan="6" style="text-align:center; padding:3rem; color:#999;">暫無封存記錄</td></tr>' :
                archivedUsers.map(u => `
                                <tr style="border-bottom:1px solid #eee;">
                                    <td style="padding:12px;">${u.userName || '-'}</td>
                                    <td style="padding:12px;"><small>${u.email || '-'}</small></td>
                                    <td style="padding:12px;">${u.employeeId || '未綁定'}</td>
                                    <td style="padding:12px;">
                                        ${u.archivedReason === 'merged' ?
                        '<span style="color:#9c27b0;">🔗 已合併</span>' :
                        '<span style="color:#f44336;">🗑️ 已刪除</span>'}
                                    </td>
                                    <td style="padding:12px;"><small>${u.archivedAt ? new Date(u.archivedAt).toLocaleString('zh-TW') : '-'}</small></td>
                                    <td style="padding:12px;">
                                        ${u.archivedReason === 'merged' && u.mergedTarget ?
                        `<small style="color:#666;">→ ${u.mergedTarget.substring(0, 8)}...</small>` :
                        `<button class="btn-sm" style="background:#4caf50; color:white;" data-uid="${u.uid}" data-name="${u.userName}" onclick="window.restoreArchivedUser(this)">復原</button>`}
                                    </td>
                                </tr>
                            `).join('')
            }
                    </tbody>
                </table>
            </div>
        `;

        window.restoreArchivedUser = async function (btn) {
            const uid = btn.getAttribute('data-uid');
            const name = btn.getAttribute('data-name');

            if (confirm(`確定要復原學員「${name}」嗎？`)) {
                try {
                    await updateDoc(doc(db, "users", uid), {
                        status: 'active',
                        restoredAt: new Date().toISOString()
                    });
                    alert('復原成功！');
                    renderArchivesView();
                } catch (e) {
                    alert('復原失敗: ' + e.message);
                }
            }
        };

    } catch (e) {
        console.error('[Archives] Error loading archived users:', e);
        workspace.innerHTML = `<p style="color:red; text-align:center;">載入失敗: ${e.message}</p>`;
    }
}
