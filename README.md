# amr-smr-sim

The code will appear as the course progresses and will be divided into parts as follows:

1. SMR movement mechanics
2. Road definition
3. Artificial sensors
4. Collision detection
5. Traffic simulation
6. Neural network
7. Visualizing neural networks
8. Optimizing neural networks
9. Fine-tuning

### 1. SMR movement mechanics

- add lane
- add smr sprite
- add controls to move forward, backward, left and right

### 2. Road definition

### 3. Artificial sensors

- add Lidar with lazer visualization

### 4. Collision detection

- add polygon
- add damage access

### 5. Traffic simulation

- add control type
- add traffic

### 6. Neural network

- add neural network

### 7. Visualizing Neural network

### 8. Optimizing Neural network

### 9. Fine-tuning

## Phase 3 · 長照機構 AMR 車隊協作模擬（Kachaka × 緯創 BestShape VS）

`src/phase3_scene.html` 是一個 Three.js 3D 場景：多台 Kachaka Pro（預設 3 台，可調 1–5 台）在四層樓的長照機構（榮家型態）中分工，執行住民生命徵象巡房、異常複測、藥品配送與失智照顧專區巡視，共用一部電梯與四個充電座，並和護理師、照服員、藥師互動。畫面上下左右的側欄即時顯示車隊狀態、任務佇列與派工理由、量測數值與事件。

### 離線播放（簡報、展示用）

- 直接雙擊 `dist/kachaka-ltc-demo.html` 即可播放，不需要網路，也不需要架伺服器（three.js、字型、程式都已內嵌在這個檔案）
- 修改 `src/` 後重新產生：`npm install` → `npm run build:offline`

### 開發

- 用 VS Code Live Server（`.vscode` 已設定 port 5501）開啟 `src/phase3_scene.html`，或在 `src/` 執行 `python3 -m http.server` 後開啟 <http://localhost:8000/phase3_scene.html>
- three.js r170 放在 `src/vendor/three/`、英數字型放在 `src/assets/fonts/`，開發版同樣不需要網路；中文使用系統字型（PingFang TC／微軟正黑體／Noto Sans CJK）
- 開發版使用 ES modules，必須透過 http 開啟；要用 `file://` 直接開請用 `dist/` 的離線檔

### 場景與資源

- 1F 服務大廳・醫務室：藥局（藥品櫃 MED-01～03）、機器人站（充電座 C1、C2）、大廳待命點 S1、S2
- 2F 失智照顧專區：住民房、照服站、活動室、出入管制
- 3F 養護區 A、4F 養護區 B：住民房、護理站、被服室（各放一台生理量測車 VS-3F／VS-4F 與充電座 C3／C4）
- 外掛玻璃電梯：透過電梯系統串接，一次載一台；進出時 `mute_sensors=True`，抵達後 `switch_map(..., inherit_docking_state_and_docked_shelf=True)`

### 任務

| 任務 | 優先級 | 內容 |
| ---- | ------ | ---- |
| 生命徵象巡房 | P3 | 對接該樓層量測車，逐床在 1 公尺內量 30 秒心率與呼吸，經 MQTT 寫入護理紀錄；心率 > 110 或呼吸 > 24 推播護理站與 LINE 群組 |
| 異常複測 | P2 | 異常後 10 分鐘（可調）自動建立 |
| 藥品配送 | P3／P1 | 藥師備藥上鎖 → `move_shelf` 送到護理站 → 簽收 → `return_shelf`；心率異常時護理師會發出 P1 緊急用藥 |
| 失智專區巡視 | P4 | 2F 四個巡檢點；發現住民往出入口移動時停下來對話並通知照服員 |

任務會依排程自動產生（間隔可調），也可以在「任務佇列與派工」按 ＋配送、＋緊急配送、＋巡房、＋巡視、電梯尖峰、低電量交接 現場示範。

### 任務派發策略（可在「調度設定」切換）

1. **佇列排序**：依「有效優先級 → 建立時間」。優先級老化：每等候 N 分鐘升一級（最多到 P2，不與真正的 P1 搶先）
2. **資源檢查**：巡房／複測需要該樓層量測車；配送需要藥品櫃，預設保留最後一櫃給 P1
3. **候選機器人**：閒置、未在低電量充電、電量 ≥ 可派工最低電量，且預估完成任務並回到充電座後仍高於強制回充門檻 5% 以上（充電座上補電中的機器人可直接接單）
4. **挑選方式**
   - 綜合評分：`成本 = 行程時間×w1 + (100−電量)×1.5×w2 + 搭電梯×(40+25×排隊數)×w3`，取最低（權重可調）
   - 最近優先：預估到達時間（含電梯排隊）最短
   - 樓層責任區：交給負責該樓層的機器人，忙碌時可改派最近者
   - 輪流指派：K1→K2→K3… 依序，跳過忙碌或電量不足者
5. **合併派工**：複測併入同樓層進行中的巡房；同樓層配送在備藥前併成一趟（最多 3 份）
6. **P1 插單**：無空閒機器人時，若有機器人即將歸還藥品櫃就等它；否則中斷一台執行 P3／P4 的機器人，在安全點（量完一床、走完一個巡檢點）歸還量測車後接手，原任務保留進度回到佇列，由其他機器人接手

每筆指派的理由與各機器人的分數會顯示在任務卡片與事件記錄（可篩選 派工／交通／充電／照護）。

### 交通管制

- 走廊雙向車道、靠右行駛（東行靠前側、西行靠房間側），同向跟車保持可調中心距，遇人減速禮讓
- 住民房、藥局、機器人站、被服室、護理站取件點為單一通行區：在自己車道、門前約 1 公尺處預約，佔用時就地等候；放行順序可選先到先過或優先級
- 機器人必須先離開原區域回到車道才會等待下一個區域，因此不會形成循環等待；停在充電座的機器人不佔用走道
- 交會時在車道上直行者優先，互相擋住時由優先級高者先行
- 電梯一次載一台；機器人在電梯廳沿牆的等候點排隊，排程可選先到先服務／任務優先級／最近樓層，等候超過 2 分鐘者優先；電梯會先移到下一個要接的樓層

### 充電管理

- 閒置時低於回充門檻就去充電，充到恢復派工電量前不接新任務；工作中低於強制回充門檻時在安全點交接任務
- 充電座分配：最近可用（含電梯排隊的行程最短）或固定歸屬
- 充電座不足（例如 5 台機器人）時，低電量者先到待命點排隊，已充飽且閒置的機器人會讓出充電座
- 電量變化預設加速 8 倍以便示範（可調）

### 響應式版面

- 寬螢幕：上（KPI、模擬時間、速度、調度設定）／左（車隊、選定機器人遙測、LiDAR、電梯排隊）／中（3D）／右（量測數值、通報、量測紀錄）／下（任務看板、即時事件）
- 平板：3D 全寬，面板兩欄並排
- 手機：3D 固定在頂端，依序是車隊、任務看板、量測、統計、事件；調度設定改為底部抽屜
- 支援淺色／深色主題與 `prefers-reduced-motion`；設定值存在瀏覽器（無法儲存時仍可使用）

### 程式結構（`src/js/phase_3/`）

| 檔案                 | 內容                                                     |
| -------------------- | -------------------------------------------------------- |
| `main.js`            | 場景組裝、主迴圈                                         |
| `fleet.js`           | 車隊管理：任務佇列、派工、P1 插單、合併、充電座分配、排程 |
| `dispatch.js`        | 派工策略、行程與電量估算、派工理由                        |
| `tasks.js`           | 巡房、複測、配送、巡視的執行腳本與人員互動                |
| `traffic.js`         | 單一通行區預約（房間、藥局、取件點）                      |
| `lift.js`            | 電梯系統串接：叫車佇列與排程策略                          |
| `settings.js`        | 可調參數、預設值與設定表單描述                            |
| `hospital.js`        | 建築：樓層、住民房、充電座、待命點、導航點、LiDAR 用牆面    |
| `elevator.js`        | 電梯塔、車廂、樓層門、樓層顯示器                          |
| `kachaka.js`         | 機器人模型、差速運動、車道路徑、讓行、LiDAR、API 指令      |
| `furniture.js`       | 生理量測車、藥品櫃（可對接家具）                          |
| `vitals.js`          | BestShape VS 量測流程、雷達波束、判讀門檻                  |
| `people.js`          | 護理師、照服員、藥師、家屬與住民                          |
| `camera.js`          | 自動導播（挑最值得看的機器人）、跟隨、全景、自由與樓層剖面 |
| `labels.js`          | 3D 標籤與對話泡泡                                        |
| `dashboard.js`       | 側欄、任務看板、調度設定抽屜、LiDAR 俯視圖                 |
| `kachakaMeshData.js` | 由 `tools/kachaka_stl_to_js.py` 從 kachaka-api STL 轉出   |

`tools/build_offline.mjs` 用 esbuild 把以上模組、three.js 和字型打包成 `dist/kachaka-ltc-demo.html`。主控台可用 `hospitalDemo.advance(秒數)` 快轉、`hospitalDemo.fleet.quickAdd("stat")` 新增緊急配送、`hospitalDemo.fleet.restart()` 重新開始。

### 資料來源與聲明

- Kachaka 尺寸、最高速度 0.3 m/s、API 指令名稱、gRPC 埠與 STL 模型取自 [pf-robotics/kachaka-api](https://github.com/pf-robotics/kachaka-api)（Apache-2.0，授權見 `src/assets/kachaka/LICENSE`）
- three.js（MIT，`src/vendor/three/LICENSE`）；Barlow Semi Condensed、JetBrains Mono（SIL OFL 1.1，`src/assets/fonts/LICENSE`）
- 緯創醫學 BestShape VS 以毫米波雷達非接觸量測呼吸與心跳，依公開報導描述
- 派工、交通與充電策略為本模擬的示範設計，並非 Kachaka 或任何車隊管理產品的實際功能
- 住民、數值與機構皆為虛構；本模擬與 Preferred Robotics、緯創醫學、西格瑪機器人無官方關聯
