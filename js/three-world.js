import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";

/**
 * 创建 three.js “基础世界”对象。
 *
 * 这里放的是“通用三件套 + 灯光 + loader”初始化，不耦合具体业务：
 * - renderer / scene / camera / controls
 * - GLTFLoader（可加载 .glb）+ DRACOLoader（可选的 draco 压缩解码）
 *
 * 说明：
 * - 本项目不使用打包器，所以 three 通过 importmap + ESM 直接从 CDN 载入。
 * - DRACO 解码器也通过 Google CDN 获取（如果模型没用 draco 压缩也不会触发）。
 */
export function createThreeWorld({ canvas }) {
  // 渲染器：开启抗锯齿 + 颜色空间设置（保证贴图颜色更接近预期）
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  // 场景：背景交给“二次元天空”模块渲染，所以这里设为 null
  const scene = new THREE.Scene();
  scene.background = null;

  // 相机：基础透视相机（普通模式由 OrbitControls 控制；off-axis 模式会覆盖投影矩阵）
  const camera = new THREE.PerspectiveCamera(50, 1, 0.01, 10_000);
  camera.position.set(2, 1.2, 2.2);

  // 控制器：普通模式下可旋转/缩放；off-axis 开启后会被禁用
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;

  // 灯光：半球光做全局填充 + 方向光做主光（带阴影）+ 侧后方补光做“边缘光”
  scene.add(new THREE.HemisphereLight(0xffffff, 0x223344, 1.05));
  const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
  dirLight.position.set(3, 6, 4);
  dirLight.castShadow = true;
  dirLight.shadow.mapSize.set(2048, 2048);
  dirLight.shadow.bias = -0.00008;
  scene.add(dirLight);
  scene.add(dirLight.target);

  const rimLight = new THREE.DirectionalLight(0xffe4f1, 0.55);
  rimLight.position.set(-4, 2, -3);
  scene.add(rimLight);

  // 模型加载器：GLTFLoader + 可选 draco 解码
  const loader = new GLTFLoader();
  const dracoLoader = new DRACOLoader();
  dracoLoader.setDecoderPath("https://www.gstatic.com/draco/v1/decoders/");
  loader.setDRACOLoader(dracoLoader);

  return { THREE, renderer, scene, camera, controls, loader, dirLight, rimLight };
}
