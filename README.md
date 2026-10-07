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

## Phase 3 · 長照機構 AMR 協作模擬（Kachaka × 緯創 BestShape VS）

`src/phase3_scene.html` 是一個 Three.js 3D 場景：Kachaka Pro 在四層樓的長照機構（榮家型態）中搭電梯跨樓層，執行住民生命徵象巡房、藥品配送與失智照顧專區巡視，並和護理師、照服員、藥師互動。畫面上下左右的側欄即時顯示機器人遙測、量測數值、任務進度與事件。

### 離線播放（簡報、展示用）

- 直接雙擊 `dist/kachaka-ltc-demo.html` 即可播放，不需要網路，也不需要架伺服器（three.js、字型、程式都已內嵌在這個檔案）
- 修改 `src/` 後重新產生：`npm install` → `npm run build:offline`

### 開發

- 用 VS Code Live Server（`.vscode` 已設定 port 5501）開啟 `src/phase3_scene.html`，或在 `src/` 執行 `python3 -m http.server` 後開啟 <http://localhost:8000/phase3_scene.html>
- three.js r170 放在 `src/vendor/three/`、英數字型放在 `src/assets/fonts/`，開發版同樣不需要網路；中文使用系統字型（PingFang TC／微軟正黑體／Noto Sans CJK）
- 開發版使用 ES modules，必須透過 http 開啟；要用 `file://` 直接開請用 `dist/` 的離線檔

### 場景

- 1F 服務大廳・醫務室：醫務室藥局、機器人站（充電座、可對接家具的停放點）、診間、復健室、餐廳、家屬會客區
- 2F 失智照顧專區：住民房、照服站、活動室、電梯廳出入管制
- 3F 養護區 A、4F 養護區 B：住民房（每間兩床，含衣櫃、輪椅）、護理站、備藥室、交誼廳
- 外掛玻璃電梯：透過電梯系統串接呼叫電梯，進出時 `mute_sensors=True`，抵達後 `switch_map(..., inherit_docking_state_and_docked_shelf=True)`

### 任務（在「任務排程」點選即可直接切換情境）

1. **生命徵象巡房**：對接生理量測車 → 3F、4F 共七床 → 在床邊 1 公尺內非接觸量測 30 秒心率與呼吸（只顯示數值）→ 經 MQTT 寫入護理紀錄；心率超過 110 或呼吸超過 24 時推播護理站與 LINE 群組，護理師到床邊處置
2. **藥品配送**：護理站派單 → 醫務室藥師備藥並上鎖 → `move_shelf` 送到 3F 護理站 → 護理師取件簽收 → `return_shelf`
3. **失智專區巡視**：2F 四個巡檢點掃描並做物件偵測（`PERSON`、`DOOR`）；發現住民往出入口移動時，機器人停下來和住民說話並通知照服員，照服員陪住民回活動室
4. **回充待命**：`return_home` 充電，時間快轉到下一輪

### 響應式版面

- 寬螢幕：上（KPI、模擬時間、速度）／左（機器人遙測、LiDAR、API 指令、電梯）／中（3D）／右（量測數值、通報、量測紀錄）／下（任務排程、即時事件）
- 平板：3D 全寬，面板兩欄並排
- 手機：3D 固定在頂端，其餘面板依重要性往下排；3D 底部的「目前動作」列顯示當下的重點數值
- 支援淺色／深色主題與 `prefers-reduced-motion`

### 程式結構（`src/js/phase_3/`）

| 檔案                 | 內容                                                     |
| -------------------- | -------------------------------------------------------- |
| `main.js`            | 場景組裝、主迴圈                                         |
| `hospital.js`        | 建築：樓層、住民房、家具、導航點、LiDAR 用牆面            |
| `elevator.js`        | 電梯塔、車廂、樓層門、樓層顯示器                          |
| `kachaka.js`         | 機器人模型、差速運動、LiDAR、物件偵測、API 指令、跨樓層     |
| `furniture.js`       | 生理量測車、藥品櫃（可對接家具）                          |
| `vitals.js`          | BestShape VS 量測流程、雷達波束、判讀門檻                  |
| `people.js`          | 護理師、照服員、藥師、家屬與住民                          |
| `missions.js`        | 任務劇本與情境切換                                       |
| `camera.js`          | 自動導播（跟隨／全景／自由）與樓層剖面淡出                |
| `labels.js`          | 3D 標籤與對話泡泡                                        |
| `dashboard.js`       | 側欄資料、LiDAR 俯視圖                                   |
| `kachakaMeshData.js` | 由 `tools/kachaka_stl_to_js.py` 從 kachaka-api STL 轉出   |

`tools/build_offline.mjs` 用 esbuild 把以上模組、three.js 和字型打包成 `dist/kachaka-ltc-demo.html`。主控台可用 `hospitalDemo.advance(秒數)` 快轉、`hospitalDemo.missions.jumpTo(0~3)` 切換任務。

### 資料來源與聲明

- Kachaka 尺寸、最高速度 0.3 m/s、API 指令名稱、gRPC 埠與 STL 模型取自 [pf-robotics/kachaka-api](https://github.com/pf-robotics/kachaka-api)（Apache-2.0，授權見 `src/assets/kachaka/LICENSE`）
- three.js（MIT，`src/vendor/three/LICENSE`）；Barlow Semi Condensed、JetBrains Mono（SIL OFL 1.1，`src/assets/fonts/LICENSE`）
- 緯創醫學 BestShape VS 以毫米波雷達非接觸量測呼吸與心跳，依公開報導描述
- 住民、數值與機構皆為虛構；本模擬與 Preferred Robotics、緯創醫學、西格瑪機器人無官方關聯
