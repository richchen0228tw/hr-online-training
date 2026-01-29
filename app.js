import { db } from './firebase-config.js';
import { collection, getDocs, addDoc, updateDoc, doc, deleteDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

// State
const state = {
    currentRoute: '',
    courses: [],
    adminLoggedIn: false,
    loading: true
};

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

// Initialization
window.addEventListener('load', async () => {
    window.addEventListener('hashchange', handleRoute);
    await fetchCourses();
});

// Render Functions
// Render Functions
function renderApp(route, id) {
    const app = document.getElementById('app');
    app.innerHTML = ''; // Clear current content

    // Determines Navbar State
    let showAdminBtn = false;
    let enableLogoLink = true;

    if (route === '#home') {
        showAdminBtn = true;
    }

    // Special Check for Restricted Course Access
    if (route === '#course') {
        const course = state.courses.find(c => c.id === id);
        // If course exists and is NOT available, strict mode active
        if (course && !isCourseAvailable(course)) {
            enableLogoLink = false;
        }
    }

    // Render Navbar
    app.appendChild(createNavbar(showAdminBtn, enableLogoLink));

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
        content.appendChild(renderCourseDetail(id));
    } else if (route === '#admin') {
        content.appendChild(renderAdmin());
    } else {
        content.innerHTML = '<h2>404 Not Found</h2>';
    }

    app.appendChild(content);
}

function createNavbar(showAdminBtn = true, enableLogoLink = true) {
    const nav = document.createElement('nav');
    nav.className = 'navbar';

    const logoHtml = enableLogoLink
        ? '<a href="#home">MiTAC 線上學習平台</a>'
        : '<span style="color: white; font-weight: bold; font-size: 1.2rem;">MiTAC 線上學習平台</span>';

    const adminBtnHtml = showAdminBtn
        ? '<a href="#admin" class="btn" style="background:transparent; color: var(--primary-color); border: 1px solid var(--primary-color);">管理員後台</a>'
        : '';

    nav.innerHTML = `
        <div class="logo">
            ${logoHtml}
        </div>
        <div class="nav-links">
            ${adminBtnHtml}
        </div>
    `;
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

    coursesToRender.forEach(course => {
        const card = document.createElement('div');
        card.className = 'course-card';
        // Apply dynamic color to top border or shadow
        card.style.borderTop = `5px solid ${course.color || '#0ABAB5'}`;

        card.innerHTML = `
            <div class="course-title">${course.title}</div>
            <div class="course-meta">${course.parts ? course.parts.length : 0} 個單元</div>
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

function renderCourseDetail(id) {
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

    div.innerHTML = `
        <div style="max-width: 900px; margin: 0 auto; padding-bottom: 2rem;">
            <!-- Back Button -->
            <div style="margin-bottom: 2rem;">
                 <a href="#home" class="btn" style="background-color: #6c757d; border-color: #6c757d;">&larr; 回首頁</a>
            </div>

            <!-- Course Title & Navigation -->
            <div style="text-align:center; margin-bottom: 2rem;">
                <h2 style="margin-bottom: 1.5rem;">${course.title}</h2>
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
            <!-- Helper text for users -->
            <p style="text-align:center; margin-top:1rem; color:#888; font-size:0.9rem;">
                若影片無法播放，請確認瀏覽器支援或網址權限
            </p>
        </div>
    `;

    const btnContainer = div.querySelector('#unit-buttons-container');
    const contentDisplay = div.querySelector('#content-display');

    // Helper: Convert YouTube URL to Embed URL
    const getEmbedUrl = (url) => {
        if (!url) return '';
        // Handle standard youtube.com/watch?v=ID or youtu.be/ID
        let videoId = '';
        if (url.includes('youtube.com/watch')) {
            const urlParams = new URLSearchParams(new URL(url).search);
            videoId = urlParams.get('v');
        } else if (url.includes('youtu.be/')) {
            videoId = url.split('youtu.be/')[1].split('?')[0];
        } else if (url.includes('youtube.com/embed/')) {
            return url; // Already embed code
        }

        return videoId ? `https://www.youtube.com/embed/${videoId}` : url;
    };

    // Render Buttons
    let videoCount = 0;
    (course.parts || []).forEach((part, index) => {
        const btn = document.createElement('button');

        // Determine Button Text and Tooltip based on Type
        if (part.type === 'video') {
            videoCount++;
            btn.textContent = `單元 ${videoCount}`;
            btn.title = part.title; // Show custom title on hover
        } else {
            btn.textContent = part.title; // Quiz keeps its name
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

        const renderContent = () => {
            // Clear previous content
            contentDisplay.innerHTML = '';

            if (part.type === 'quiz') {
                // Render Form Iframe
                if (part.url) {
                    contentDisplay.style.background = 'white'; // White background for forms
                    contentDisplay.innerHTML = `
                        <iframe src="${part.url}" width="100%" height="800px" frameborder="0" marginheight="0" marginwidth="0">載入中...</iframe>
                    `;
                } else {
                    contentDisplay.style.background = '#f8f9fa';
                    contentDisplay.innerHTML = `<div style="color:#666; padding:2rem;">尚未設定測驗網址</div>`;
                }
            } else {
                // Render Video
                contentDisplay.style.background = 'black';
                if (part.url) {
                    // Check for direct file extensions
                    const isDirectFile = part.url.match(/\.(mp4|webm|ogg)$/i);

                    if (isDirectFile) {
                        contentDisplay.innerHTML = `
                            <video controls width="100%" style="max-height: 500px;" src="${part.url}"></video>
                        `;
                    } else {
                        const embedSrc = getEmbedUrl(part.url);
                        contentDisplay.innerHTML = `
                            <iframe width="100%" height="500" src="${embedSrc}" title="Video player" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>
                        `;
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
                row.style.cssText = `background:var(--light-gray); padding:1rem; margin-bottom:1rem; border-left:4px solid ${isQuiz ? '#ff6b6b' : (editingCourse.color || '#0ABAB5')}`;

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
            editingCourse.parts.push({ type: 'video', title: `單元 ${vCount + 1}`, url: '' });
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
