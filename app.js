import { db } from './firebase-config.js';
import { collection, getDocs, addDoc, updateDoc, doc, deleteDoc, query, where, setDoc, getDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

// State
const state = {
    currentRoute: '',
    courses: [],
    adminLoggedIn: false,
    loading: true,
    currentUser: null, // { userId, userName }
    adminViewMode: 'courses', // 'courses' or 'users'
    adminSortBy: 'openDate'   // 'openDate' or 'actualDate'
};

// YouTube Player Management
let currentYouTubePlayer = null;
let youtubeSaveInterval = null;
let isYouTubeAPIReady = false;

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

    // If specific users are allowed, must be logged in
    if (!userId) return false;

    // Check if user is in the allowed list
    return course.allowedUserIds.includes(userId);
}

// ============== 使用者識別模組 ==============
function initializeUser() {
    // 檢查 sessionStorage (Browser Session) 是否已有使用者資訊
    const stored = sessionStorage.getItem('hr_training_user');
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

async function updateVideoPosition(userId, courseId, courseName, unitIndex, position, duration, allUnits) {
    // 計算是否完成（觀看 >= 90%）
    const completed = duration > 0 && (position / duration) >= 0.9;

    // 更新單元進度
    if (!allUnits[unitIndex].viewCount) allUnits[unitIndex].viewCount = 0;
    allUnits[unitIndex].lastPosition = position;
    allUnits[unitIndex].duration = duration;
    allUnits[unitIndex].completed = completed;
    allUnits[unitIndex].lastAccessTime = new Date().toISOString();

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

    // 先識別使用者
    await initializeUser();

    // 再載入課程
    await fetchCourses();
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

    if (route === '#home') {
        content.appendChild(renderHome());
    } else if (route === '#course') {
        const courseDetail = await renderCourseDetail(id);
        content.appendChild(courseDetail);
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


    // Logo Logic: 總是顯示為連結，並使用 CSS 定義的顏色
    const logoHtml = '<a href="#home">MiTAC 線上學習平台</a>';

    const userInfo = state.currentUser
        ? `<span style="color: #666; margin-right: 1rem;">👤 ${state.currentUser.userName}</span>`
        : '';

    const progressBtnHtml = state.currentUser && !state.adminLoggedIn
        ? '<a href="#progress" class="btn" style="background:transparent; color: var(--primary-color); border: 1px solid var(--primary-color); margin-right: 0.5rem;">我的學習紀錄</a>'
        : '';

    // 管理員按鈕：只在管理員登入狀態下顯示（因為登入頁已有連結，且一般登入不需要看到）
    const adminBtnHtml = state.adminLoggedIn
        ? '<a href="#admin" class="btn" style="background:transparent; color: var(--primary-color); border: 1px solid var(--primary-color); margin-right: 0.5rem;">管理員後台</a>'
        : '';

    // 登出按鈕：只要有登入就顯示
    const logoutBtnHtml = state.currentUser
        ? `<button id="btn-logout" class="btn" style="background:#f44336; color: white; border: none; padding: 0.5rem 1rem;">登出</button>`
        : '';

    nav.innerHTML = `
        <div class="logo">
            ${logoHtml}
        </div>
        <div class="nav-links" style="display: flex; align-items: center;">
            ${userInfo}
            ${progressBtnHtml}
            ${adminBtnHtml}
            ${logoutBtnHtml}
        </div>
    `;

    // Bind Logout Event
    setTimeout(() => {
        const logoutBtn = nav.querySelector('#btn-logout');
        if (logoutBtn) {
            logoutBtn.onclick = () => {
                if (confirm('確定要登出嗎？')) {
                    sessionStorage.removeItem('hr_training_user');
                    window.location.reload();
                }
            };
        }
    }, 0);

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
    if (course.allowedUserIds && course.allowedUserIds.length > 0) {
        const userId = state.currentUser ? state.currentUser.userId : null;
        if (!userId || !course.allowedUserIds.includes(userId)) {
            return createErrorView('您沒有權限觀看此課程');
        }
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
                            unitProgressData
                        );
                        console.log(`[YouTube] 每 10 秒自動儲存: ${time.toFixed(1)}秒 / ${duration.toFixed(1)}秒`);
                    }
                }
            }, 10000);
        }

        async function onPlayerStateChange(event) {
            if (!currentYouTubePlayer || !currentYouTubePlayer.getCurrentTime) return;

            const time = currentYouTubePlayer.getCurrentTime();
            const duration = currentYouTubePlayer.getDuration();

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
                        unitProgressData
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
                    unitProgressData
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
                                    onclick="window.open('${part.url}', '_blank', 'width=1000,height=800')" 
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
                                    style="
                                        background-color: #4CAF50; 
                                        color: white;
                                        border: none;
                                        font-size: 1rem;
                                        padding: 0.8rem 2rem;
                                        width: 100%;
                                    "
                                >
                                    ✓ 標記測驗已完成
                                </button>
                                
                                <p style="color: #999; font-size: 0.85rem; margin-top: 1.5rem;">
                                    💡 提示：測驗將在新視窗開啟
                                </p>
                            </div>
                        </div>
                    `;

                    // 標記測驗完成
                    setTimeout(() => {
                        const markBtn = contentDisplay.querySelector('#mark-quiz-complete');
                        if (markBtn) {
                            markBtn.onclick = async () => {
                                await markUnitCompleted(state.currentUser.userId, id, course.title, index, unitProgressData, true);
                                btn.innerHTML = btn.textContent.replace(' ✓', '') + ' <span style="color: #4CAF50;">✓</span>';
                                updateCourseProgress();
                                markBtn.textContent = '✓ 已完成';
                                markBtn.disabled = true;
                                markBtn.style.opacity = '0.7';
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
                                    // 記錄影片總時長
                                    unitProgressData[index].duration = video.duration;

                                    // 恢復上次播放位置
                                    const lastPos = unitProgressData[index].lastPosition || 0;
                                    if (lastPos > 0 && lastPos < video.duration) {
                                        video.currentTime = lastPos;
                                        console.log(`[進度追蹤] 恢復播放位置: ${lastPos.toFixed(1)}秒`);
                                    }
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
                                                unitProgressData
                                            );

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
                                            unitProgressData
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
                                            unitProgressData
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
                                        unitProgressData
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
async function renderProgress() {
    const div = document.createElement('div');

    if (!state.currentUser) {
        div.innerHTML = '<h2 style="text-align:center; color:#666;">請先登入以查看學習紀錄</h2>';
        return div;
    }

    div.innerHTML = `
    <div style="max-width: 1000px; margin: 0 auto;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem;">
            <h1 style="margin: 0;">我的學習紀錄</h1>
            <a href="#home" class="btn" style="background-color: #6c757d;">&larr; 回首頁</a>
        </div>
        <p style="color: #666; margin-bottom: 3rem;">使用者：${state.currentUser.userName} (${state.currentUser.userId})</p>
        <div id="progress-content" style="min-height: 300px;">
            <p style="text-align: center; color: #888;">載入中...</p>
        </div>
    </div>
    `;

    const progressContent = div.querySelector('#progress-content');

    // 載入進度資料
    const progressList = await getAllUserProgress(state.currentUser.userId);

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
                        <a href="#course/${progress.courseId}" class="btn" style="background-color: ${themeColor};">繼續學習</a>
                    </div>
                    
                    <div class="progress-bar" style="margin-bottom: 1rem;">
                        <div class="progress-fill" style="width: ${progress.completionRate}%; background-color: ${themeColor};"></div>
                    </div>
                    
                    <div style="display: flex; justify-content: space-between; font-size: 0.9rem; color: #888; margin-bottom: 1rem;">
                        <span>完成度：${progress.completionRate}%</span>
                        <span>${progress.units.filter(u => u.completed || u.quizCompleted).length} / ${progress.units.length} 單元</span>
                    </div>
                    
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
                    <button id="btn-logout" class="btn" style="background: rgba(255,255,255,0.1); border: 1px solid white;">登出</button>
                </div>
                <div class="flex gap-2">
                    <button id="tab-courses" class="btn" style="${state.adminViewMode === 'courses' ? 'background:white; color:var(--primary-color);' : 'background:transparent; color:white; border:1px solid white;'}">課程列表</button>
                    <button id="tab-users" class="btn" style="${state.adminViewMode === 'users' ? 'background:white; color:var(--primary-color);' : 'background:transparent; color:white; border:1px solid white;'}">學員管理</button>
                </div>
            </div>
        </div>
        <div id="admin-workspace" class="container mt-4 mb-4"></div>
        `;

        container.querySelector('#btn-logout').onclick = () => {
            if (confirm('確定要登出嗎？')) {
                // Prevent routing logic from triggering when we clear the hash
                window.removeEventListener('hashchange', handleRoute);

                state.adminLoggedIn = false;
                // Clear app content immediately to prevent flashing frontend before reload
                document.getElementById('app').innerHTML = '';

                // Reset URL to root and reload
                window.location.hash = '';
                window.location.reload();
            }
        };
        container.querySelector('#tab-courses').onclick = () => { state.adminViewMode = 'courses'; renderApp('#admin'); };
        container.querySelector('#tab-users').onclick = () => { state.adminViewMode = 'users'; renderApp('#admin'); };
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
        header.className = 'flex justify-between items-center mb-4';
        header.innerHTML = `
            <div class="flex items-center gap-4">
                <h2 style="margin:0;">課程列表</h2>
                <div style="font-size: 0.9rem;">
                    排序依據: 
                    <select id="sort-select" style="padding: 4px; border-radius: 4px; border: 1px solid #ddd;">
                        <option value="openDate" ${currentSort === 'openDate' ? 'selected' : ''}>線上開放日期</option>
                        <option value="actualDate" ${currentSort === 'actualDate' ? 'selected' : ''}>實際課程日期</option>
                        <option value="status" ${currentSort === 'status' ? 'selected' : ''}>上架狀態</option>
                    </select>
                </div>
            </div>
            <div class="flex gap-2">
                 <button class="btn" id="btn-batch-delete" style="background-color: #dc3545; display: none;">🗑️ 刪除所選課程</button>
                <button class="btn" id="btn-export-progress" style="background-color: #28a745;">📊 匯出課程紀錄</button>
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
                                    <td style="padding: 1rem;">${u.userId}</td>
                                    <td style="padding: 1rem;">${u.userName}</td>
                                    <td style="padding: 1rem;">${u.email || '-'}</td>
                                    <td style="padding: 1rem;">${u.courses.length}</td>
                                    <td style="padding: 1rem; color: #666;">${u.lastActive ? new Date(u.lastActive).toLocaleString('zh-TW') : '-'}</td>
                                    <td style="padding: 1rem; display: flex; gap: 0.5rem;">
                                        <button class="btn edit-user-btn" data-userid="${u.userId}" style="padding: 4px 12px; font-size: 0.85rem;">編輯</button>
                                        <button class="btn delete-user-btn" data-userid="${u.userId}" data-username="${u.userName}" style="padding: 4px 12px; font-size: 0.85rem; background-color: #dc3545; color: white;">刪除</button>
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
                            <div><label style="font-size:0.9rem">${isQuiz ? 'Google 表單網址' : '影片網址'}</label><input type="text" class="unit-url-input" data-idx="${idx}" value="${part.url || ''}" /></div>
                        </div>
                    `;
                unitContainer.appendChild(row);
            });

            // Bind inputs
            unitContainer.querySelectorAll('.unit-title-input').forEach(i => i.oninput = (e) => editingCourse.parts[e.target.dataset.idx].title = e.target.value);
            unitContainer.querySelectorAll('.unit-url-input').forEach(i => i.oninput = (e) => editingCourse.parts[e.target.dataset.idx].url = e.target.value);
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
    } else {
        setTimeout(renderCourseList, 0);
    }
    return container;
}
