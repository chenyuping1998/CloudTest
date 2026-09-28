# 美術資源替換指南

遊戲目前的材質與模型全部由程式產生（暫代美術）。美術只要把檔案放進這個資料夾，
**不用改任何程式碼**，重新建置（`npm run dev` 會即時載入、`npm run build` / `npm run dist` 打包）就會換上。
沒有放檔案的部分會自動沿用程序化美術，所以可以一張一張慢慢替換。

```
art/
├── blocks/      ← 放方塊材質：<tile 名稱>.png（16×16）
├── models/      ← 放角色 / 怪物 / NPC 模型：<key>.glb
├── templates/   ← 目前的程序化材質（範本，由 npm run art:export 產生，不會被遊戲讀取）
└── examples/    ← 範例模型（不會被遊戲讀取，複製到 models/ 即可試用）
```

## 1. 方塊材質（blocks/）

1. 執行 `npm run art:export`，到 `art/templates/blocks/` 找到要改的材質，例如 `grass_top.png`。
   `art/templates/atlas-preview.png` 是全部材質的總覽。
2. 用 Aseprite / Photoshop / Blockbench 的材質編輯器修改，**維持 16×16、RGBA PNG**。
3. 存到 `art/blocks/grass_top.png`（檔名必須和範本相同）。

規則：

- 尺寸不是 16×16 會被縮放（最近鄰取樣）並在主控台警告。
- 透明像素只在植物、玻璃類材質有效（`tallgrass`、`flower_*`、`glass`）。
- 遊戲會依面向自動加明暗（頂面最亮、側面較暗）與角落環境光遮蔽，**材質本身不要畫陰影**，畫固有色即可。
- `water` 會半透明並加上波光動畫；`portal` 會閃爍。

完整 tile 清單見 `templates/tiles.json`。

## 2. 模型（models/）

用 [Blockbench](https://www.blockbench.net/) 建立「Generic Model」，完成後
**File → Export → Export glTF Model**，勾選 *Binary (.glb)* 與 *Export Animations*。
存成 `art/models/<key>.glb`。

### key 命名

| 類型 | key | 例 |
|---|---|---|
| 玩家職業 | `class_<職業 id>` | `class_knight.glb` |
| 怪物 | `monster_<怪物 id>` | `monster_jelly_slime.glb` |
| NPC | `npc_shop`、`npc_market`、`npc_guide` | `npc_guide.glb` |

全部 key 與中文名稱見 `templates/models.json`（`npm run art:export` 產生）。

### 模型規格

- **正面朝 +Z**。放進遊戲後若發現方向相反，在 Blockbench 把整個模型繞 Y 軸轉 180° 再匯出即可。
- **尺寸與單位不用管**：遊戲會把模型等比縮放到原本方塊模型的高度、腳底貼地、水平置中。
  建議仍照 Minecraft 比例（人形 32 像素高），像素密度才會和場景一致。
- 材質用 16× 倍數的像素貼圖，遊戲會自動套最近鄰取樣保持像素銳利。
- 盡量一個模型一張貼圖；方塊數量建議 < 60。
- 點擊判定沿用原本方塊模型的範圍，模型輪廓差太多時請告知程式調整。

### 動畫

動畫名稱**包含**以下字即可（不分大小寫，例如 `walk`、`Walk_Loop`、`attack_1`）：

| 片段 | 何時播放 | 注意 |
|---|---|---|
| `idle` | 站著 | 循環 |
| `walk` | 移動中 | 循環，約 0.5~0.8 秒一步 |
| `attack` | 攻擊 / 施法 | 播一次，建議 0.25~0.35 秒 |

沒有動畫的模型也能用：遊戲會在移動時讓它上下彈跳、攻擊時前傾。
受擊閃紅由遊戲處理，不用做動畫。

### 試用範例

```bash
cp art/examples/monster_jelly_slime.glb art/models/
npm run dev    # 果凍史萊姆會變成戴皇冠的粉紅方塊，有 idle / walk / attack 動畫
```

## 3. 版權

所有美術必須是原創或取得商用授權（Steam 上架需要）。**不可使用天堂、RO、Minecraft 的任何素材或臨摹。**
外包時合約要寫明著作財產權歸屬。字型使用俐方體 11 號（SIL OFL，可商用）。
