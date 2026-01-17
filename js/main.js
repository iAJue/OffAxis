/**
 * 应用入口：负责
 * - 读取 DOM
 * - 初始化 three world
 * - 初始化各功能 controller（模型、二次元风格、裸眼3D）
 * - 绑定 UI 事件
 * - 驱动渲染循环
 *
 * 本文件尽量只做“拼装”，具体实现下沉到各模块。
 */
import { MODELS } from "./models.js";
import { createThreeWorld } from "./three-world.js";
import { createAnimeController } from "./anime-controller.js";
import { createOffAxisController } from "./offaxis-controller.js";
import { createModelController } from "./model-controller.js";

// 页面元素（尽量只在 main.js 里触碰 DOM，其他模块只收“引用/回调”）
const canvas = document.getElementById("c");
const statusEl = document.getElementById("status");
const selectEl = document.getElementById("modelSelect");
const reloadBtn = document.getElementById("reloadBtn");
const animeToggleEl = document.getElementById("animeToggle");
const roomToggleEl = document.getElementById("roomToggle");
const offAxisToggleEl = document.getElementById("offAxisToggle");
const parallaxGainEl = document.getElementById("parallaxGain");
const trackBtn = document.getElementById("trackBtn");
const webcamPane = document.getElementById("webcamPane");
const webcamVideo = document.getElementById("webcam");

/**
 * 左上角状态提示（加载进度/追踪状态等）。
 * @param {string} text
 */
function setStatus(text) {
  statusEl.textContent = text ?? "";
}

// three.js 基础对象：renderer/scene/camera/controls/loader 等
const { renderer, scene, camera, controls, loader, dirLight } = createThreeWorld({ canvas });
// 二次元风格：Toon + 描边 + 渐变天空 + 地面 + 粒子
const anime = createAnimeController({ scene, dirLight });
// 裸眼3D：off-axis 投影 + 可选（摄像头）头动追踪；未启用追踪时可用鼠标模拟
const offAxis = createOffAxisController({
  camera,
  controls,
  canvas,
  webcamPane,
  webcamVideo,
  setStatus,
  getParallaxGain: () => Number(parallaxGainEl.value)
});

// 模型加载/切换
const modelController = createModelController({
  scene,
  loader,
  camera,
  controls,
  setStatus,
  onModelChanged: ({ root, box, center, maxDim }) => {
    // 1) 把新模型交给“二次元风格”模块（用于 toon/描边等）
    anime.setCurrentRoot(root);
    // 2) 基于包围盒，重设地面/阴影/粒子等环境
    anime.updateForModel({ box, center, maxDim });
    // 3) 裸眼3D：把“屏幕平面/默认视距”等参数按模型尺寸重标定
    if (center && Number.isFinite(maxDim)) offAxis.setDefaultsFromModel(center, maxDim);
  }
});

// 构造下拉菜单选项
for (const m of MODELS) {
  const opt = document.createElement("option");
  opt.value = m.url;
  opt.textContent = m.name;
  selectEl.appendChild(opt);
}

// 切换模型
selectEl.addEventListener("change", () => {
  const model = MODELS.find((m) => m.url === selectEl.value) ?? MODELS[0];
  if (!model) return;
  modelController.loadModel(model);
});

// 重载（重新从网络/缓存加载 glb，并重新应用 transform/取景）
reloadBtn.addEventListener("click", () => {
  const model = MODELS.find((m) => m.url === selectEl.value) ?? MODELS[0];
  if (!model) return;
  modelController.loadModel(model);
});

// 二次元场景开关
animeToggleEl.addEventListener("change", () => {
  anime.setEnabled(animeToggleEl.checked);
});

// 房间环境开关
roomToggleEl.addEventListener("change", () => {
  anime.setRoomEnabled(roomToggleEl.checked);
});

// 裸眼3D（off-axis）开关：开启后会禁用 OrbitControls，改为离轴相机驱动
offAxisToggleEl.addEventListener("change", () => {
  offAxis.setEnabled(offAxisToggleEl.checked);
});

// 摄像头追踪按钮（同一个按钮在“开启/停止”之间切换）
trackBtn.addEventListener("click", async () => {
  if (offAxis.tracking) {
    offAxis.stopTracking();
    trackBtn.textContent = "开启追踪";
  } else {
    await offAxis.startTracking();
    trackBtn.textContent = offAxis.tracking ? "停止追踪" : "开启追踪";
    offAxisToggleEl.checked = offAxis.enabled;
  }
});

// 鼠标模拟头动（仅在“裸眼3D开启 && 未启用摄像头追踪”时生效）
window.addEventListener(
  "pointermove",
  (e) => {
    offAxis.handlePointerMove(e);
  },
  { passive: true }
);

/**
 * 画布尺寸自适应：
 * - 普通模式：更新 camera.aspect
 * - off-axis 模式：投影矩阵由 off-axis 算法生成，这里不动 aspect
 */
function resize() {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (width === 0 || height === 0) return;
  renderer.setSize(width, height, false);
  if (!offAxis.enabled) {
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }
}

/**
 * 主循环：
 * - 普通模式：OrbitControls update
 * - off-axis：由 controller 直接写 camera.matrixWorld/projectionMatrix
 * - anime：更新粒子/天空
 */
function animate() {
  resize();
  if (!offAxis.enabled) controls.update();
  offAxis.update();
  anime.update(camera, performance.now() * 0.001);
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}

async function init() {
  // 初始化时应用 UI 默认值
  anime.setEnabled(animeToggleEl.checked);
  anime.setRoomEnabled(roomToggleEl.checked);
  offAxis.setEnabled(offAxisToggleEl.checked);

  // 默认加载第一个模型（或当前 select 的值）
  const initial = MODELS.find((m) => m.url === selectEl.value) ?? MODELS[0];
  if (initial) await modelController.loadModel(initial);
  animate();
}

init();
