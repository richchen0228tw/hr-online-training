# MiTAC 線上教育訓練系統 (HR Online Training System)

![Version](https://img.shields.io/badge/version-5.0.0-blue.svg)
![Status](https://img.shields.io/badge/status-Active-brightgreen.svg)
![Type](https://img.shields.io/badge/type-Enterprise-orange.svg)

這是一個專為企業內部量身打造的教育訓練管理平台，結合了現代化的學習體驗與強大的數據分析功能。系統基於 Firebase 雲端架構開發，提供穩定、安全且高效的教學環境。

---

## 🚀 核心功能亮點

### 🎯 學習體驗 (Student Experience)
- **智慧進度追蹤**：自動記錄影片觀看位置，支援中斷點續看。
- **防止跳轉機制**：內建反作弊邏輯，確保學員完整觀看教學內容，未達觀看比例無法標記完成。
- **直覺式儀表板**：清晰流暢的課程卡片與個人學習進度條，支援按年份收折瀏覽。
- **多元測驗整合**：無縫接軌 Google Forms 測驗，並設有倒數防呆機制確保作弊防範。

### 🛠️ 管理功能 (Admin Suite)
- **進階課程管理**：拖拽式排程管理，支援批次編輯、隱藏、歸檔與刪除課程。
- **精準數據報表**：一鍵匯出 CSV 報表，包含學員基本資料、完成率及詳細的單元學習數據。
- **行為分析系統 (TES)**：
    - **真實參與度 (True Engagement Score)**：透過觀看行為演算法評估學員參與品質。
    - **興趣回放統計**：分析學員重看片段，挖掘課程中的熱點與難點。
- **靈活帳號配置**：支援 Google 帳號與員工編號綁定，簡化登入流程同時確保企業識別。

---

## 🛠️ 技術架構 (Technical Stack)

- **Frontend**: Vanilla JavaScript (ES6+), CSS3 (Modern UI/UX), HTML5 Semantic Tags.
- **Backend-as-a-Service**: Firebase
  - **Firestore**: 即時非關聯式資料庫，儲存課程、使用者與進度數據。
  - **Authentication**: 整合 Google OAuth 2.0 與自訂員工資料驗證 (v5)。
  - **Hosting**: 全球節點發布，提供極速存取體驗。
- **Deployment**: GitHub Actions 自動化部署 (CI/CD)。

---

## 📂 專案結構

```text
├── .github/workflows/      # CI/CD 自動化部署設定
├── app.js                  # 核心邏輯 (路由、資料庫交互、UI 渲染)
├── firebase-config.js      # Firebase 初始化設定
├── firestore.rules         # 資料庫安全規則
├── index.html              # 入口頁面
├── style.css               # 視覺設計與排版系統
├── test-system.html        # 測試沙盒環境
└── DEPLOYMENT.md           # 詳細部署手冊
```

---

## ⚙️ 快速上手

### 開發者環境設定
1. 確保已安裝 [Firebase CLI](https://firebase.google.com/docs/cli)。
2. 複製專案後，在根目錄執行：
   ```bash
   firebase login
   firebase use <your-project-id>
   ```
3. 本地預覽：
   ```bash
   firebase serve
   ```

### 部署流程
1. 將程式碼推送到 `main` 分支。
2. GitHub Actions 會自動啟動並部署至 Firebase Hosting。
3. 若需手動部署：
   ```bash
   firebase deploy
   ```

---

## 👥 使用者指南

### 1. 登入與驗證 (v5 更新)
- **Google 登入**：點擊 Google 登入後，系統會自動核對員工資料庫。
- **身分綁定**：首次使用需輸入員工編號進行身分鎖定，確保學習紀錄歸人。

### 2. 學習規範
- **觀看限制**：影片必須觀看至 **90%** 以上才算完成。
- **進度調整**：系統管理員有權在後台手動修正異常的學習進度。

---

## 🛠️ 管理員權限 (管理員帳戶)
- **預設最高權限**：將用戶 `role` 欄位設為 `admin` 即可進入後台。
- **資料庫管理**：建議透過後台進行「課程歸檔」而非直接刪除，以保留歷史紀錄。

---

*最後更新日期: 2026-02-11*
*維護團隊: MiTAC HR & IT Team*
