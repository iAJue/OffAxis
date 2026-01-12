<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { updateOffAxisCamera } from '@/lib/offAxisCamera.js'

/**
 * OffAxisViewer：离轴透视投影 Demo
 *
 * 核心思路：
 * - 在世界坐标里放一个“屏幕平面”（z=0 的矩形），用 pa/pb/pc 三点定义它的方向与尺寸。
 * - 维护一个“眼睛位置 eye”（世界坐标），由鼠标/键盘/摄像头头部追踪驱动变化。
 * - 每帧根据 (pa/pb/pc + eye) 计算【非对称视锥】并写入 camera.projectionMatrix，
 *   同时把相机坐标系对齐到屏幕坐标系（见 src/lib/offAxisCamera.js）。
 */

const mountEl = ref(null)

// ===== HUD/UI 状态 =====
const trackingEnabled = ref(false)
const trackingStatus = ref('Manual')
const lastFaceConfidence = ref(null)
const eyeText = ref('')

// HUD 操作提示：根据是否启用摄像头动态切换
const instructions = computed(() => {
  if (trackingEnabled.value) {
    return [
      '摄像头模式：移动头部/身体查看离轴透视',
      'R：重置视点；Esc：退出摄像头模式',
    ].join(' · ')
  }
  return [
    '拖拽：移动视点 XY',
    '滚轮 / Q / E：移动视点 Z',
    '方向键：微调 XY · R：重置',
    '开启摄像头：用头部追踪驱动视点',
  ].join(' · ')
})

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

// ===== three.js 对象（手动管理生命周期）=====
let renderer
let scene
let camera
let animationHandle = 0

// ===== 屏幕平面（定义离轴投影的“真实屏幕”）=====
// 约定：屏幕放在 z=0，屏幕高度固定为 1，宽度随 viewport aspect 改变。
const screenHeight = 1.0
let screenWidth = 1.0

// 屏幕矩形四个角点：pa(左下) pb(右下) pc(左上) pd(右上)
const pa = new THREE.Vector3()
const pb = new THREE.Vector3()
const pc = new THREE.Vector3()
const pd = new THREE.Vector3()

// ===== 眼睛位置 eye =====
// 默认把 eye 的 y 抬高（更接近“站立视角”，避免贴地导致画面上下不舒适）
const baseEye = new THREE.Vector3(0, 0.1, 1.25)
// 模型整体放在屏幕后方（z 负方向），便于观察
const baseModelZ = -2.4
// 把模型缩放到一个近似统一的大小（不同 glb 也能在同一交互尺度下体验）
const targetModelSize = 1.25
// manualOffset：鼠标/键盘造成的偏移；trackedOffset：摄像头追踪造成的偏移
const manualOffset = new THREE.Vector3(0, 0, 0)
const trackedOffset = new THREE.Vector3(0, 0, 0)
// 最终 eye = baseEye + manualOffset (+ trackedOffset)
const eye = new THREE.Vector3()

let screenFrame

// ===== 鼠标拖拽状态 =====
let isDragging = false
let lastPointerX = 0
let lastPointerY = 0

// ===== 键盘状态：按住持续移动 =====
const pressedKeys = new Set()
let lastTime = performance.now()
let lastUiTime = 0

// ===== 摄像头头部追踪（MediaPipe FaceLandmarker）=====
let videoEl = null
let mediaStream = null
let faceLandmarker = null
// 记录“初始脸宽”，用于粗略估算前后移动（脸变大=靠近，脸变小=远离）
let faceBaselineWidth = null
let lastDetectTime = 0
// 复用临时向量，避免频繁 new（降低 GC 抖动）
const tmpVec3a = new THREE.Vector3()
const tmpVec3b = new THREE.Vector3()

// 开关：启用/禁用头部追踪（失败会自动回退到 Manual）
function setTrackingEnabled(nextEnabled) {
  trackingEnabled.value = nextEnabled
  if (trackingEnabled.value) {
    // getUserMedia 只能在安全上下文使用（localhost/https）
    if (!window.isSecureContext) {
      trackingEnabled.value = false
      trackingStatus.value = 'Webcam failed: insecure context（请用 http://localhost 打开，或 https）'
      return
    }
    // 兜底：部分环境可能不支持
    if (!navigator.mediaDevices?.getUserMedia) {
      trackingEnabled.value = false
      trackingStatus.value = 'Webcam failed: getUserMedia not supported'
      return
    }
    startHeadTracking().catch((err) => {
      trackingEnabled.value = false
      stopHeadTracking({ keepStatus: true })
      trackingStatus.value = `Webcam failed: ${formatWebcamError(err)}`
    })
  } else {
    stopHeadTracking()
  }
}

// 把常见摄像头错误转换为更易懂的提示
function formatWebcamError(err) {
  const name = err?.name ?? ''
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
    return 'permission denied（请允许浏览器使用摄像头）'
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return 'no camera device found'
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return 'camera is busy/unreadable（可能被其他应用占用）'
  }
  if (name === 'SecurityError') {
    return 'insecure context（请用 http://localhost 打开，或 https）'
  }
  return err?.message ?? String(err)
}

/**
 * 启动头部追踪：
 * 1) getUserMedia 打开摄像头
 * 2) 创建 video 元素承载 stream
 * 3) 加载 MediaPipe wasm（本地 /vendor/mediapipe/wasm）
 * 4) 加载 FaceLandmarker 模型（优先本地，其次远程）
 */
async function startHeadTracking() {
  trackingStatus.value = 'Requesting camera permission...'

  // 避免重复启动：先清掉旧资源
  stopHeadTracking()

  mediaStream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: 'user',
      width: { ideal: 1280 },
      height: { ideal: 720 },
    },
    audio: false,
  })

  videoEl = document.createElement('video')
  videoEl.playsInline = true
  videoEl.muted = true
  videoEl.autoplay = true
  videoEl.srcObject = mediaStream
  await videoEl.play()

  trackingStatus.value = 'Loading face model...'

  // 动态 import：只在需要时加载，减少首屏体积
  const vision = await import('@mediapipe/tasks-vision')
  // WASM 本地化：不依赖 jsdelivr
  const fileset = await vision.FilesetResolver.forVisionTasks('/vendor/mediapipe/wasm')

  const localModelPath = '/vendor/mediapipe/models/face_landmarker.task'
  const remoteModelPath =
    'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task'

  try {
    trackingStatus.value = 'Loading face model (local)...'
    // 本地模型：推荐使用 npm 脚本下载/放置，避免网络不通
    faceLandmarker = await vision.FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: localModelPath },
      runningMode: 'VIDEO',
      numFaces: 1,
    })
  } catch (err) {
    try {
      trackingStatus.value = 'Loading face model (remote)...'
      faceLandmarker = await vision.FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: remoteModelPath },
        runningMode: 'VIDEO',
        numFaces: 1,
      })
    } catch (err2) {
      throw new Error(
        `Failed to load FaceLandmarker model. Put it at ${localModelPath} (run: npm run setup:mediapipe:model)`,
      )
    }
  }

  faceBaselineWidth = null
  lastFaceConfidence.value = null
  trackingStatus.value = 'Webcam on'
}

/**
 * 停止头部追踪并释放资源：
 * - faceLandmarker.close()
 * - mediaStream tracks stop()
 * - 清理 videoEl
 */
function stopHeadTracking({ keepStatus = false } = {}) {
  if (faceLandmarker?.close) faceLandmarker.close()
  faceLandmarker = null
  faceBaselineWidth = null
  lastFaceConfidence.value = null

  if (videoEl) {
    videoEl.pause?.()
    videoEl.srcObject = null
    videoEl = null
  }

  if (mediaStream) {
    for (const track of mediaStream.getTracks()) track.stop()
    mediaStream = null
  }

  trackedOffset.set(0, 0, 0)
  if (!keepStatus) trackingStatus.value = 'Manual'
}

/**
 * 根据当前 viewport 更新屏幕平面三点 pa/pb/pc：
 * - 屏幕在 z=0
 * - 高度固定为 1
 * - 宽度随 aspect 变化
 */
function updateScreenFromViewport() {
  if (!renderer) return
  const size = renderer.getSize(new THREE.Vector2())
  const aspect = size.x / Math.max(1, size.y)

  screenWidth = screenHeight * aspect

  const z = 0
  pa.set(-screenWidth / 2, -screenHeight / 2, z)
  pb.set(screenWidth / 2, -screenHeight / 2, z)
  pc.set(-screenWidth / 2, screenHeight / 2, z)
  pd.copy(pb).add(pc).sub(pa)

  if (screenFrame) {
    const positions = screenFrame.geometry.attributes.position.array
    positions[0] = pa.x
    positions[1] = pa.y
    positions[2] = pa.z
    positions[3] = pb.x
    positions[4] = pb.y
    positions[5] = pb.z
    positions[6] = pd.x
    positions[7] = pd.y
    positions[8] = pd.z
    positions[9] = pc.x
    positions[10] = pc.y
    positions[11] = pc.z
    screenFrame.geometry.attributes.position.needsUpdate = true
  }
}

// 重置视点：清空手动/追踪偏移，并重置“距离基准”
function resetEye() {
  manualOffset.set(0, 0, 0)
  trackedOffset.set(0, 0, 0)
  faceBaselineWidth = null
}

// 键盘持续移动：按住方向键/QE，按 dt 移动偏移量
function applyKeyboard(dtSeconds) {
  const maxX = screenWidth * 0.45
  const maxY = screenHeight * 0.45
  const maxZ = 2.25
  const minZ = 0.35

  const speedXY = screenHeight * 0.9
  const speedZ = 1.25

  if (pressedKeys.has('ArrowLeft')) manualOffset.x -= speedXY * dtSeconds
  if (pressedKeys.has('ArrowRight')) manualOffset.x += speedXY * dtSeconds
  if (pressedKeys.has('ArrowUp')) manualOffset.y += speedXY * dtSeconds
  if (pressedKeys.has('ArrowDown')) manualOffset.y -= speedXY * dtSeconds
  if (pressedKeys.has('KeyQ')) manualOffset.z -= speedZ * dtSeconds
  if (pressedKeys.has('KeyE')) manualOffset.z += speedZ * dtSeconds

  manualOffset.x = clamp(manualOffset.x, -maxX, maxX)
  manualOffset.y = clamp(manualOffset.y, -maxY, maxY)
  manualOffset.z = clamp(manualOffset.z, minZ - baseEye.z, maxZ - baseEye.z)
}

// 鼠标拖拽：把屏幕像素位移映射成屏幕平面单位位移（用于改变 eye 的 X/Y）
function applyPointerDelta(deltaX, deltaY) {
  const maxX = screenWidth * 0.45
  const maxY = screenHeight * 0.45

  const canvas = renderer?.domElement
  if (!canvas) return

  const rect = canvas.getBoundingClientRect()
  const dx = (deltaX / Math.max(1, rect.width)) * screenWidth
  const dy = (-deltaY / Math.max(1, rect.height)) * screenHeight

  manualOffset.x = clamp(manualOffset.x + dx, -maxX, maxX)
  manualOffset.y = clamp(manualOffset.y + dy, -maxY, maxY)
}

// 滚轮：改变 eye 的 Z（靠近/远离屏幕）
function applyWheel(deltaY) {
  const maxZ = 2.25
  const minZ = 0.35

  const zoom = deltaY * 0.0012
  manualOffset.z = clamp(manualOffset.z + zoom, minZ - baseEye.z, maxZ - baseEye.z)
}

/**
 * 头部追踪更新（最多 30fps）：
 * - 用人脸关键点的包围盒中心 -> x/y 偏移
 * - 用人脸宽度相对初始值 -> z 偏移
 * - 用 lerp 做平滑，减少抖动
 */
function updateHeadTracking(nowMs) {
  if (!trackingEnabled.value) return
  if (!faceLandmarker || !videoEl) return
  if (videoEl.readyState < 2) return

  const minInterval = 1000 / 30
  if (nowMs - lastDetectTime < minInterval) return
  lastDetectTime = nowMs

  const result = faceLandmarker.detectForVideo(videoEl, nowMs)
  const landmarks = result?.faceLandmarks?.[0]
  if (!landmarks?.length) {
    lastFaceConfidence.value = null
    tmpVec3a.set(0, 0, 0)
    trackedOffset.lerp(tmpVec3a, 0.2)
    trackingStatus.value = 'Webcam on (no face)'
    return
  }

  let minLandmarkX = 1
  let maxLandmarkX = 0
  let minLandmarkY = 1
  let maxLandmarkY = 0

  for (const p of landmarks) {
    minLandmarkX = Math.min(minLandmarkX, p.x)
    maxLandmarkX = Math.max(maxLandmarkX, p.x)
    minLandmarkY = Math.min(minLandmarkY, p.y)
    maxLandmarkY = Math.max(maxLandmarkY, p.y)
  }

  const centerX = (minLandmarkX + maxLandmarkX) / 2
  const centerY = (minLandmarkY + maxLandmarkY) / 2
  const faceWidth = Math.max(1e-6, maxLandmarkX - minLandmarkX)

  if (!faceBaselineWidth) faceBaselineWidth = faceWidth

  const xNorm = (centerX - 0.5) * 2
  const yNorm = (centerY - 0.5) * 2
  const zNorm = (faceBaselineWidth / faceWidth - 1)

  const maxX = screenWidth * 0.35
  const maxY = screenHeight * 0.35
  const maxZ = 0.7
  const minZ = -0.55

  tmpVec3b.set(
    clamp(xNorm * maxX, -maxX, maxX),
    clamp(-yNorm * maxY, -maxY, maxY),
    clamp(zNorm * 0.9, minZ, maxZ),
  )

  trackedOffset.lerp(tmpVec3b, 0.18)
  lastFaceConfidence.value = faceWidth
  trackingStatus.value = 'Webcam on'
}

// 计算最终 eye 并更新离轴相机（投影矩阵 + 相机世界矩阵）
function updateCamera() {
  const maxX = screenWidth * 0.45
  const maxY = screenHeight * 0.45
  const maxZ = 2.25
  const minZ = 0.35

  eye.copy(baseEye)
  eye.add(manualOffset)
  if (trackingEnabled.value) eye.add(trackedOffset)

  eye.x = clamp(eye.x, baseEye.x - maxX, baseEye.x + maxX)
  eye.y = clamp(eye.y, baseEye.y - maxY, baseEye.y + maxY)
  eye.z = clamp(eye.z, minZ, maxZ)

  // 离轴投影：由 (eye + 屏幕三点) 计算非对称视锥
  updateOffAxisCamera({
    camera,
    eye,
    pa,
    pb,
    pc,
    near: 0.05,
    far: 60,
  })
}

// RAF 渲染循环：输入/追踪 -> 更新相机 -> render
function renderFrame(nowMs) {
  animationHandle = requestAnimationFrame(renderFrame)

  const dtSeconds = clamp((nowMs - lastTime) / 1000, 0, 0.05)
  lastTime = nowMs

  applyKeyboard(dtSeconds)
  updateHeadTracking(nowMs)
  updateCamera()

  // HUD 文字节流更新，避免每帧触发 Vue 更新
  if (nowMs - lastUiTime > 100) {
    lastUiTime = nowMs
    eyeText.value = `eye = (${eye.x.toFixed(3)}, ${eye.y.toFixed(3)}, ${eye.z.toFixed(3)})`
  }

  renderer.render(scene, camera)
}

// 初始化 three.js 场景、网格、屏幕平面，以及 ResizeObserver
function initThree() {
  scene = new THREE.Scene()
  scene.background = new THREE.Color('#0b0f16')

  camera = new THREE.PerspectiveCamera(60, 1, 0.05, 60)

  // 生成 canvas 并挂到容器里
  const canvas = document.createElement('canvas')
  renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: false,
    powerPreference: 'high-performance',
  })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio ?? 1, 2))

  mountEl.value.appendChild(canvas)

  // 灯光：简单但足够让 glb 看清楚
  const ambient = new THREE.AmbientLight(0xffffff, 0.6)
  scene.add(ambient)

  const dir = new THREE.DirectionalLight(0xffffff, 1.1)
  dir.position.set(2, 3, 2)
  scene.add(dir)

  const grid = new THREE.GridHelper(8, 16, 0x2a3350, 0x1d2336)
  grid.position.z = baseModelZ
  scene.add(grid)

  const axes = new THREE.AxesHelper(0.6)
  axes.position.z = baseModelZ
  scene.add(axes)

  // 屏幕边框（可视化“投影屏幕”）
  const frameGeom = new THREE.BufferGeometry()
  frameGeom.setAttribute(
    'position',
    new THREE.BufferAttribute(new Float32Array(12), 3),
  )
  screenFrame = new THREE.LineLoop(
    frameGeom,
    new THREE.LineBasicMaterial({ color: 0x8ab4ff, transparent: true, opacity: 0.55 }),
  )
  scene.add(screenFrame)

  // 屏幕半透明面（帮助理解屏幕位置）
  const screenPlaneGeom = new THREE.PlaneGeometry(1, 1, 1, 1)
  const screenPlane = new THREE.Mesh(
    screenPlaneGeom,
    new THREE.MeshBasicMaterial({
      color: 0x8ab4ff,
      transparent: true,
      opacity: 0.06,
      side: THREE.DoubleSide,
    }),
  )
  screenPlane.position.z = 0
  scene.add(screenPlane)

  function updateScreenPlane() {
    screenPlane.scale.set(screenWidth, screenHeight, 1)
  }

  // 监听容器尺寸变化：更新 renderer 尺寸 + 屏幕平面
  const resizeObserver = new ResizeObserver(() => {
    const { width, height } = mountEl.value.getBoundingClientRect()
    renderer.setSize(Math.max(1, Math.floor(width)), Math.max(1, Math.floor(height)), true)
    updateScreenFromViewport()
    updateScreenPlane()
  })
  resizeObserver.observe(mountEl.value)

  onBeforeUnmount(() => {
    resizeObserver.disconnect()
  })

  updateScreenFromViewport()
  updateScreenPlane()
}

// 加载 public/1.glb，并把模型缩放/对齐到更适合展示的位置（脚底贴地 + X/Z 居中）
function loadModel() {
  const loader = new GLTFLoader()

  const root = new THREE.Group()
  scene.add(root)
  root.position.set(0, 0, 0)

  trackingStatus.value = 'Loading /1.glb ...'
  loader.load(
    '/1.glb',
    (gltf) => {
      const model = gltf.scene

      // 加入场景后再算包围盒（setFromObject 需要在树上）
      root.add(model)
      root.updateMatrixWorld(true)

      // 第一次包围盒：估算缩放比例
      const box = new THREE.Box3().setFromObject(model)
      const size = box.getSize(new THREE.Vector3())

      const maxDim = Math.max(1e-6, size.x, size.y, size.z)
      const scale = targetModelSize / maxDim
      model.scale.setScalar(scale)
      root.updateMatrixWorld(true)

      // 缩放后重新算一次包围盒：用于对齐脚底/居中
      box.setFromObject(model)
      box.getSize(size)
      const center = box.getCenter(new THREE.Vector3())
      const minY = box.min.y

      model.position.x -= center.x
      model.position.z -= center.z
      model.position.y -= minY
      root.updateMatrixWorld(true)

      // 模型整体放到屏幕平面后方
      root.position.set(0, 0, baseModelZ)
      trackingStatus.value = trackingEnabled.value ? 'Webcam on' : 'Manual'
    },
    undefined,
    (err) => {
      trackingStatus.value = `Model load failed: ${err?.message ?? String(err)}`
    },
  )
}

// DOM 交互：鼠标拖拽、滚轮、键盘
function addDomEvents() {
  const canvas = renderer.domElement

  // pointer 事件：左键拖拽移动视点 X/Y
  const onPointerDown = (ev) => {
    if (ev.button !== 0) return
    isDragging = true
    lastPointerX = ev.clientX
    lastPointerY = ev.clientY
    canvas.setPointerCapture?.(ev.pointerId)
  }

  const onPointerMove = (ev) => {
    if (!isDragging) return
    const dx = ev.clientX - lastPointerX
    const dy = ev.clientY - lastPointerY
    lastPointerX = ev.clientX
    lastPointerY = ev.clientY
    applyPointerDelta(dx, dy)
  }

  const onPointerUp = (ev) => {
    if (ev.button !== 0) return
    isDragging = false
    canvas.releasePointerCapture?.(ev.pointerId)
  }

  // wheel：移动视点 Z
  const onWheel = (ev) => {
    ev.preventDefault()
    applyWheel(ev.deltaY)
  }

  canvas.addEventListener('pointerdown', onPointerDown, { passive: true })
  canvas.addEventListener('pointermove', onPointerMove, { passive: true })
  canvas.addEventListener('pointerup', onPointerUp, { passive: true })
  canvas.addEventListener('pointercancel', onPointerUp, { passive: true })
  canvas.addEventListener('wheel', onWheel, { passive: false })

  // key：Esc 退出摄像头；R 重置；其余加入 pressedKeys 让 render loop 持续处理
  const onKeyDown = (ev) => {
    if (ev.code === 'Escape' && trackingEnabled.value) {
      setTrackingEnabled(false)
      return
    }
    if (ev.code === 'KeyR') {
      resetEye()
      return
    }
    pressedKeys.add(ev.code)
  }

  const onKeyUp = (ev) => {
    pressedKeys.delete(ev.code)
  }

  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)

  // 组件卸载时解绑事件
  onBeforeUnmount(() => {
    canvas.removeEventListener('pointerdown', onPointerDown)
    canvas.removeEventListener('pointermove', onPointerMove)
    canvas.removeEventListener('pointerup', onPointerUp)
    canvas.removeEventListener('pointercancel', onPointerUp)
    canvas.removeEventListener('wheel', onWheel)
    window.removeEventListener('keydown', onKeyDown)
    window.removeEventListener('keyup', onKeyUp)
  })
}

// 组件挂载：初始化场景、加载模型、绑定交互、启动渲染循环
onMounted(() => {
  initThree()
  loadModel()
  addDomEvents()
  renderFrame(performance.now())
})

// 组件卸载：停止 RAF、释放摄像头、释放 renderer
onBeforeUnmount(() => {
  cancelAnimationFrame(animationHandle)
  stopHeadTracking()

  pressedKeys.clear()

  if (renderer) {
    renderer.dispose()
    renderer = null
  }
})
</script>

<template>
  <div class="root">
    <div ref="mountEl" class="viewport" />

    <div class="hud">
      <div class="row">
        <label class="toggle">
          <input
            type="checkbox"
            :checked="trackingEnabled"
            @change="setTrackingEnabled($event.target.checked)"
          />
          <span>摄像头头部追踪</span>
        </label>
        <button class="btn" @click="resetEye">R 重置视点</button>
      </div>

      <div class="meta">
        <div class="line">
          <span class="label">状态</span>
          <span class="value">{{ trackingStatus }}</span>
        </div>
        <div class="line">
          <span class="label">视点</span>
          <span class="value">{{ eyeText }}</span>
        </div>
        <div class="line">
          <span class="label">提示</span>
          <span class="value">{{ instructions }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.root {
  position: relative;
  height: 100%;
}

.viewport {
  position: absolute;
  inset: 0;
}

.viewport :deep(canvas) {
  width: 100%;
  height: 100%;
  touch-action: none;
}

.hud {
  position: absolute;
  left: 14px;
  top: 14px;
  max-width: min(720px, calc(100% - 28px));
  background: var(--panel);
  border: 1px solid var(--panel-border);
  border-radius: 12px;
  padding: 12px 12px;
  backdrop-filter: blur(10px);
}

.row {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
}

.toggle {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  user-select: none;
  color: var(--text);
}

.toggle input {
  transform: translateY(1px);
}

.btn {
  border: 1px solid var(--panel-border);
  background: rgba(255, 255, 255, 0.06);
  color: var(--text);
  border-radius: 10px;
  padding: 6px 10px;
  cursor: pointer;
}

.btn:hover {
  background: rgba(255, 255, 255, 0.1);
}

.meta {
  margin-top: 10px;
  display: grid;
  gap: 6px;
  color: var(--muted);
  font-size: 13px;
  line-height: 1.35;
}

.line {
  display: grid;
  grid-template-columns: 46px 1fr;
  gap: 10px;
}

.label {
  color: rgba(255, 255, 255, 0.68);
}

.value {
  color: rgba(255, 255, 255, 0.9);
}
</style>
