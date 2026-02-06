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
    currentUser: null, // { uid, userName, employeeId, email, role }
    adminViewMode: 'courses', // 'courses', 'users', 'archives'
    adminSortBy: 'openDate',   // 'openDate' or 'actualDate'
    authInitialized: false
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

// Wait for YouTube API
function waitForYouTubeAPI(maxAttempts = 50) {
    return new Promise((resolve) => {
        let attempts = 0;
        const checkAPI = setInterval(() => {
            attempts++;
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
        }, 100);
    });
}

function cleanupYouTubePlayer() {
    if (youtubeSaveInterval) { clearInterval(youtubeSaveInterval); youtubeSaveInterval = null; }
    if (youtubeRestrictionInterval) { clearInterval(youtubeRestrictionInterval); youtubeRestrictionInterval = null; }
    if (currentYouTubePlayer) {
        try { currentYouTubePlayer.destroy(); } catch (e) { console.warn('[YouTube] Cleaning error:', e); }
        currentYouTubePlayer = null;
    }
}

// ============== AUTH MANAGER (V5) ==============
const AuthManager = {
    init: () => {
        onAuthStateChanged(auth, async (user) => {
            if (user) {
                console.log('[Auth] User detected:', user.uid);
                await AuthManager.handleUserLogin(user);
            } else {
                console.log('[Auth] No user.');
                state.currentUser = null;
                state.adminLoggedIn = false;
                state.authInitialized = true;
                handleRoute();
            }
        });
    },

    handleUserLogin: async (firebaseUser) => {
        try {
            state.loading = true;
            const userRef = doc(db, "users", firebaseUser.uid);
            const userSnap = await getDoc(userRef);

            let userData = null;

            if (userSnap.exists()) {
                userData = userSnap.data();

                // 檢查是否已封存
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

            // 檢查是否需要強制綁定編號
            if (!userData.employeeId) {
                console.log('[Auth] No Employee ID, triggering binding...');
                AuthManager.showMandatoryBindingModal(firebaseUser.uid);
            } else {
                await fetchCourses();
                handleRoute();
            }

        } catch (e) {
            console.error('[Auth] Login handling error:', e);
            state.loading = false;
            alert('登入處理發生錯誤: ' + e.message);
        }
    },

    loginWithGoogle: async () => {
        try {
            await signInWithPopup(auth, googleProvider);
            // onAuthStateChanged 會處理後續
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

    // 管理員邀請學員 (使用 Secondary App)
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
            // 1. 產生臨時密碼
            const tempPassword = Math.random().toString(36).slice(-8) + "Aa1!";

            // 2. 建立使用者
            const userCred = await (await import("https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js")).createUserWithEmailAndPassword(secondaryAuth, email, tempPassword);
            const uid = userCred.user.uid;

            // 3. 立即發送密碼重設信
            await (await import("https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js")).sendPasswordResetEmail(secondaryAuth, email);

            // 4. 建立 Firestore 文件
            await setDoc(doc(db, "users", uid), {
                email: email,
                userName: name,
                createdAt: new Date().toISOString(),
                status: 'active',
                role: 'user',
                employeeId: '' // 由學員首次登入時填寫
            });

            // 5. 登出 Secondary Auth
            await (await import("https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js")).signOut(secondaryAuth);

            return true;

        } catch (e) {
            console.error("[Admin] Invite Error", e);
            throw e;
        }
    },

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

                // 更新 Local State
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

// Router
function handleRoute() {
    const hash = window.location.hash || '#home';
    const path = hash.split('/')[0];
    const id = hash.split('/')[1];

    // 若未登入且不在登入頁,轉到登入頁
    if (state.authInitialized && !state.currentUser && path !== '#login') {
        window.location.hash = '#login';
        return;
    }

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
    } catch (e) {
        console.error("Error fetching courses: ", e);
        alert("讀取課程失敗，請檢查網路或 Firebase 設定");
    } finally {
        state.loading = false;
    }
}

// Helper: Check Availability (Date only)
function isCourseAvailable(course) {
    if (!course.startDate || !course.endDate) return true;
    const now = new Date();
    const start = new Date(course.startDate);
    const end = new Date(course.endDate);
    end.setHours(23, 59, 59, 999);
    return now >= start && now <= end;
}

// Helper: Check Permission
function canUserViewCourse(course, userId) {
    if (!isCourseAvailable(course)) return false;
    if (!course.allowedUserIds || course.allowedUserIds.length === 0) return true;
    if (state.adminLoggedIn) return true;
    if (!userId) return false;

    // 使用 employeeId 檢查權限
    const empId = state.currentUser?.employeeId;
    if (!empId) return false;
    return course.allowedUserIds.includes(empId);
}

console.log('[App] v5 app.js loaded - this is a new authentication system using Firebase Auth');
export { state };
