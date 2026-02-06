
// ============== V5: ARCHIVES VIEW ==============
async function renderArchivesView() {
    const workspace = document.querySelector('#admin-workspace');
    workspace.innerHTML = '<p style="text-align:center;">載入中...</p>';

    try {
        // 查詢所有已封存的學員
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
                        '<button class="btn-sm" style="background:#4caf50; color:white;" data-uid="${u.uid}" data-name="${u.userName}" onclick="restoreUser(this)">復原</button>'}
                                    </td>
                                </tr>
                            `).join('')
            }
                    </tbody>
                </table>
            </div>
        `;

        // 綁定復原按鈕 (如果需要)
        window.restoreUser = async function (btn) {
            const uid = btn.getAttribute('data-uid');
            const name = btn.getAttribute('data-name');

            if (confirm(`確定要復原學員「${name}」嗎？`)) {
                try {
                    await updateDoc(doc(db, "users", uid), {
                        status: 'active',
                        restoredAt: new Date().toISOString()
                    });
                    alert('復原成功！');
                    renderArchivesView(); // 重新載入
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
