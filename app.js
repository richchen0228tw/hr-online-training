import { db } from './firebase-config.js';
import { collection, getDocs, addDoc, updateDoc, doc, deleteDoc, query, where, setDoc, getDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

// State
const state = {
    currentRoute: '',
    courses: [],
    adminLoggedIn: false,
    loading: true,
    currentUser: null // { userId, userName }
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

// Helper: Check Availability
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
                    <label>員工編號 *</label>
                    <input type="text" id="user-id" placeholder="例如: EMP001" required />
                </div>
                <div class="form-group">
                    <label>姓名 *</label>
                    <input type="text" id="user-name" placeholder="請輸入您的姓名" required />
                </div>
                <p id="user-error" style="color: #ff6b6b; font-size: 0.9rem; margin-top: 1rem; display: none;">請填寫所有欄位</p>
                <button class="btn full-width" id="btn-user-submit" style="margin-top: 1.5rem;">開始學習</button>
                <div style="text-align: center; margin-top: 15px;">
                    <a href="#" id="admin-login-link" style="font-size: 0.85rem; color: #aaa; text-decoration: none;">管理員後台</a>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        const submitBtn = overlay.querySelector('#btn-user-submit');
        const userIdInput = overlay.querySelector('#user-id');
        const userNameInput = overlay.querySelector('#user-name');
        const errorMsg = overlay.querySelector('#user-error');

        const submit = () => {
            const userId = userIdInput.value.trim();
            const userName = userNameInput.value.trim();

            if (!userId || !userName) {
                errorMsg.style.display = 'block';
                return;
            }

            const user = { userId, userName };
            sessionStorage.setItem('hr_training_user', JSON.stringify(user));
            state.currentUser = user;

            document.body.removeChild(overlay);
            resolve(true);
        };

        submitBtn.onclick = submit;
        userIdInput.addEventListener('keyup', (e) => { if (e.key === 'Enter') userNameInput.focus(); });
        userNameInput.addEventListener('keyup', (e) => { if (e.key === 'Enter') submit(); });

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
    const coursesToRender = state.courses.filter(c => isCourseAvailable(c));

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
            <div class="course-meta" style="font-size:0.8rem; margin-top:0.5rem; color:#888;">開放時間: ${course.startDate || '未設定'} ~ ${course.endDate || '未設定'}</div>
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

    const themeColor = course.color || '#0ABAB5';
    const div = document.createElement('div');

    // 載入或初始化進度
    let userProgress = null;
    let unitProgressData = [];

    if (state.currentUser) {
        userProgress = await loadProgress(state.currentUser.userId, id);
        if (userProgress && userProgress.units) {
            unitProgressData = userProgress.units;
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
            // 清除之前的自動儲存（直接影片檔案）
            if (progressSaveInterval) {
                clearInterval(progressSaveInterval);
                progressSaveInterval = null;
            }

            // 清除 YouTube Player
            cleanupYouTubePlayer();

            currentUnitIndex = index;
            contentDisplay.innerHTML = '';

            // 增加觀看次數
            if (!unitProgressData[index].viewCount) unitProgressData[index].viewCount = 0;
            unitProgressData[index].viewCount++;

            if (part.type === 'quiz') {
                // Render Form Iframe
                if (part.url) {
                    contentDisplay.style.background = 'white';
                    contentDisplay.innerHTML = `
                        <div style="width: 100%; height: 100%;">
                            <iframe src="${part.url}" width="100%" height="800px" frameborder="0" marginheight="0" marginwidth="0">載入中...</iframe>
                            <div style="text-align: center; padding: 1rem; background: white;">
                                <button class="btn" id="mark-quiz-complete" style="background-color: ${themeColor};">標記測驗已完成</button>
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

    // 渲染進度列表
    let html = '<div class="progress-list" style="display: grid; gap: 1.5rem;">';

    for (const progress of progressList) {
        const statusColor = progress.status === 'completed' ? '#4CAF50' :
            progress.status === 'in-progress' ? '#FF9800' : '#999';
        const statusText = progress.status === 'completed' ? '已完成' :
            progress.status === 'in-progress' ? '學習中' : '未開始';

        const lastUpdate = progress.updatedAt ? new Date(progress.updatedAt).toLocaleString('zh-TW') : '無';

        // 找到對應的課程以獲取顏色
        const course = state.courses.find(c => c.id === progress.courseId);
        const themeColor = course?.color || '#0ABAB5';

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
            </div >
        `;
    }

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

    function renderList() {
        container.innerHTML = `
        <div class="full-width" style="background: var(--primary-color); color: white; padding: 2rem;">
            <div class="container flex justify-between items-center">
                <div>
                    <h1>後台管理系統</h1>
                    <p>課程內容、影片、測驗與配置管理</p>
                </div>
                <button id="btn-logout" class="btn" style="background: rgba(255,255,255,0.2); border: 1px solid white;">登出</button>
            </div>
            </div>
        <div id="admin-workspace" class="container mt-4 mb-4"></div>
    `;

        // Bind Logout
        container.querySelector('#btn-logout').onclick = () => {
            state.adminLoggedIn = false;
            location.hash = '#home'; // Redirect to home or reload
            location.reload();
        };

        const workspace = container.querySelector('#admin-workspace');

        const card = document.createElement('div');
        card.style.background = 'white';
        card.style.padding = '2rem';
        card.style.boxShadow = '0 4px 10px rgba(0,0,0,0.05)';

        const header = document.createElement('div');
        header.className = 'flex justify-between items-center mb-4';
        header.innerHTML = `
        <h2>課程列表</h2>
            <button class="btn" id="btn-add-course">+ 新增課程</button>
    `;
        card.appendChild(header);

        const listDiv = document.createElement('div');
        listDiv.style.borderTop = '1px solid #eee';

        courses.forEach(course => {
            const row = document.createElement('div');
            row.className = 'flex justify-between items-center';
            row.style.padding = '1rem 0';
            row.style.borderBottom = '1px solid #eee';

            // Generate Full URL
            const courseUrl = `${window.location.origin}${window.location.pathname}#course/${course.id}`;

            row.innerHTML = `
        <div class="flex items-center" style="max-width: 60%;">
                    <div style="width: 20px; height: 20px; border-radius: 50%; background: ${course.color || '#ccc'}; margin-right: 1rem; flex-shrink:0;"></div>
                    <div>
                        <div style="font-weight: bold; font-size: 1.1rem; margin-bottom: 0.25rem;">${course.title}</div>
                        <div style="font-size: 0.85rem; color: #666;">
                            時間: ${course.startDate || '未設定'} ~ ${course.endDate || '未設定'}<br>
                            連結: <a href="${courseUrl}" target="_blank" style="color: var(--primary-color);">${courseUrl}</a>
                        </div>
                    </div>
                </div>
        <div class="flex gap-2">
            <button class="btn copy-link-btn" data-url="${courseUrl}" style="background: #e9ecef; color: #333; font-size: 0.9rem;">複製連結</button>
            <button class="btn edit-btn" style="font-size: 0.9rem;">編輯</button>
            <button class="btn delete-btn" style="background-color: #dc3545; color: white; font-size: 0.9rem;">刪除</button>
        </div>
    `;

            row.querySelector('.edit-btn').onclick = () => renderEditor(course);
            row.querySelector('.copy-link-btn').onclick = (e) => {
                const url = e.target.dataset.url;
                navigator.clipboard.writeText(url).then(() => {
                    const originalText = e.target.textContent;
                    e.target.textContent = 'Copied!';
                    setTimeout(() => e.target.textContent = originalText, 2000);
                });
            };

            // Delete Functionality
            row.querySelector('.delete-btn').onclick = async () => {
                if (confirm(`確定要刪除課程「${course.title}」嗎？\n此動作無法復原。`)) {
                    try {
                        await deleteDoc(doc(db, "courses", course.id));
                        await fetchCourses(); // Refresh
                        renderAdmin(); // Re-render
                    } catch (e) {
                        console.error(e);
                        alert('刪除失敗: ' + e.message);
                    }
                }
            };

            listDiv.appendChild(row);
        });

        card.appendChild(listDiv);
        workspace.appendChild(card);

        // Add Course (Sync to Firebase)
        card.querySelector('#btn-add-course').onclick = async () => {
            const today = new Date().toISOString().split('T')[0];
            const nextYear = new Date();
            nextYear.setFullYear(nextYear.getFullYear() + 1);

            const newCourseData = {
                title: '新課程',
                color: '#0ABAB5',
                startDate: today,
                endDate: nextYear.toISOString().split('T')[0],
                parts: []
            };

            try {
                await addDoc(collection(db, "courses"), newCourseData);
                await fetchCourses(); // Refresh local state
                renderAdmin(); // Refresh UI
            } catch (e) {
                console.error(e);
                alert('建立課程失敗');
            }
        };
    }

    function renderEditor(course) {
        // Clone course to avoid mutating local state before save (optional preference, but good for "Cancel")
        // For simplicity here, we edit a local copy and push on save.
        let editingCourse = JSON.parse(JSON.stringify(course));

        const workspace = container.querySelector('#admin-workspace');
        workspace.innerHTML = '';

        const editorCard = document.createElement('div');
        editorCard.style.background = 'white';
        editorCard.style.padding = '2rem';
        editorCard.style.boxShadow = '0 4px 10px rgba(0,0,0,0.05)';

        editorCard.innerHTML = `
        <div class="flex justify-between items-center mb-4">
                <h2>編輯課程</h2>
                <button class="btn" id="btn-back-list" style="background-color: #6c757d;">&larr; 返回列表</button>
            </div>
        <div class="course-editor" style="border: 1px solid var(--border-color); padding: 2rem; margin-top: 2rem;">
            <div class="form-group mb-4"><label><strong>課程標題</strong></label><input type="text" id="edit-title" value="${editingCourse.title}" /></div>
            <div class="grid gap-4 mb-4" style="grid-template-columns: 1fr 1fr;">
                <div><label><strong>開始日期</strong></label><input type="date" id="edit-start" value="${editingCourse.startDate || ''}" style="width:100%; padding: 8px; border: 1px solid #ddd;" /></div>
                <div><label><strong>結束日期</strong></label><input type="date" id="edit-end" value="${editingCourse.endDate || ''}" style="width:100%; padding: 8px; border: 1px solid #ddd;" /></div>
            </div>
            <div class="form-group mb-4">
                <label><strong>主題顏色</strong></label>
                <div class="flex items-center">
                    <input type="color" id="edit-color" value="${editingCourse.color || '#0ABAB5'}" style="height: 40px; width: 60px; padding: 0; border: none; cursor: pointer;" />
                    <span style="margin-left: 10px; color: #666;">點擊選擇顏色</span>
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
                row.style.cssText = `background: var(--light - gray); padding: 1rem; margin - bottom: 1rem; border - left: 4px solid ${isQuiz ? '#ff6b6b' : (editingCourse.color || '#0ABAB5')} `;

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
        editorCard.querySelector('#edit-color').oninput = (e) => { editingCourse.color = e.target.value; renderUnits(); };

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
        const goBack = () => renderList();
        editorCard.querySelector('#btn-back-list').onclick = goBack;
        editorCard.querySelector('#btn-cancel').onclick = goBack;

        // SAVE TO FIREBASE
        editorCard.querySelector('#btn-save').onclick = async () => {
            try {
                if (confirm('確定要儲存變更嗎？')) {
                    // Remove ID from object before saving (updateDoc takes ID separately)
                    const { id, ...dataToSave } = editingCourse;
                    await updateDoc(doc(db, "courses", course.id), dataToSave);
                    await fetchCourses(); // Refresh local
                    alert('儲存成功！');
                    goBack();
                }
            } catch (e) {
                console.error(e);
                alert('儲存失敗: ' + e.message);
            }
        };

        workspace.appendChild(editorCard);
    }

    setTimeout(renderList, 0);
    return container;
}
