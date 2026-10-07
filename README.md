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

## Phase 3 · 醫院 AMR 協作模擬（Kachaka × 緯創 BestShape VS）

`src/phase3_scene.html` 是一個 Three.js 3D 場景：Kachaka Pro 在四層樓醫院中搭電梯跨樓層，執行生命徵象巡房、藥品配送與樓層巡邏，並和護理師、藥師、醫師互動。畫面上下左右的側欄即時顯示機器人遙測、生理波形、任務進度與事件。

### 執行

- 用 VS Code Live Server（`.vscode` 已設定 port 5501）開啟 `src/phase3_scene.html`，或在 `src/` 執行 `python3 -m http.server` 後開啟 <http://localhost:8000/phase3_scene.html>
- 需要網路載入 three.js r170（jsDelivr CDN）與 Google Fonts
- 程式使用 ES modules，無法直接以 `file://` 開啟

### 場景

- 1F 門診大廳・藥局・機器人站（充電座、可對接家具的停放點）
- 2F 檢驗科・中央供應（巡邏路線）
- 3F 內科病房 A、4F 呼吸照護病房（每間兩床，含護理站）
- 外掛玻璃電梯：機器人透過電梯 IoT API 呼叫電梯，進出時 `mute_sensors=True`，抵達後 `switch_map(..., inherit_docking_state_and_docked_shelf=True)`

### 任務（在「任務排程」點選即可直接切換情境）

1. **生命徵象巡房**：對接生理量測車 → 3F、4F 共七床 → 在床邊 1 公尺內非接觸量測 30 秒心率與呼吸 → 經 MQTT 寫入護理紀錄；數值異常時推播護理站，護理師到床邊處置
2. **藥品配送**：護理站派單 → 藥師備藥並上鎖 → `move_shelf` 送到 3F 護理站 → 護理師取件簽收 → `return_shelf`
3. **樓層巡邏**：2F 四個巡檢點掃描並做物件偵測（`PERSON`、`DOOR`），走廊遇到醫師時減速禮讓
4. **回充待命**：`return_home` 充電，時間快轉到下一輪

### 響應式版面

- 寬螢幕：上（KPI、模擬時間、速度）／左（機器人遙測、LiDAR、API 指令、電梯）／中（3D）／右（生理監視器、量測紀錄）／下（任務排程、即時事件）
- 平板：3D 全寬，面板兩欄並排
- 手機：3D 固定在頂端，其餘面板依重要性往下排；3D 底部的「目前動作」列顯示當下的重點數值
- 支援淺色／深色主題與 `prefers-reduced-motion`

### 程式結構（`src/js/phase_3/`）

| 檔案                 | 內容                                               |
| -------------------- | -------------------------------------------------- |
| `main.js`            | 場景組裝、主迴圈                                   |
| `hospital.js`        | 樓層、房間、家具、導航點、LiDAR 用牆面              |
| `elevator.js`        | 電梯塔、車廂、樓層門、樓層顯示器                    |
| `kachaka.js`         | 機器人模型、差速運動、LiDAR、物件偵測、API 指令、跨樓層 |
| `furniture.js`       | 生理量測車、藥品櫃（可對接家具）                    |
| `vitals.js`          | BestShape VS 量測流程、波形、雷達波束、判讀門檻      |
| `people.js`          | 醫護人員與臥床病患                                 |
| `missions.js`        | 任務劇本與情境切換                                 |
| `camera.js`          | 自動導播（跟隨／全景／自由）與樓層剖面淡出          |
| `labels.js`          | 3D 標籤與對話泡泡                                  |
| `dashboard.js`       | 側欄資料、監視器掃描波形、LiDAR 俯視圖              |
| `kachakaMeshData.js` | 由 `tools/kachaka_stl_to_js.py` 從 kachaka-api STL 轉出 |

主控台可用 `hospitalDemo.advance(秒數)` 快轉、`hospitalDemo.missions.jumpTo(0~3)` 切換任務。

### 資料來源與聲明

- Kachaka 尺寸、最高速度 0.3 m/s、API 指令名稱、gRPC 埠與 STL 模型取自 [pf-robotics/kachaka-api](https://github.com/pf-robotics/kachaka-api)（Apache-2.0，授權見 `src/assets/kachaka/LICENSE`）
- 緯創醫學 BestShape VS 以毫米波雷達非接觸量測呼吸與心跳，依公開報導描述
- 病患、數值與醫院皆為虛構；本模擬與 Preferred Robotics、緯創醫學、西格瑪機器人無官方關聯
