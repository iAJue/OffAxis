<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { updateOffAxisCamera } from '@/lib/offAxisCamera.js'

const mountEl = ref(null)

const trackingEnabled = ref(false)
const trackingStatus = ref('Manual')
const lastFaceConfidence = ref(null)
const eyeText = ref('')

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

let renderer
let scene
let camera
let animationHandle = 0

const screenHeight = 1.0
let screenWidth = 1.0

const pa = new THREE.Vector3()
const pb = new THREE.Vector3()
const pc = new THREE.Vector3()
const pd = new THREE.Vector3()

const baseEye = new THREE.Vector3(0, 0.7, 1.25)
const baseModelZ = -2.4
const targetModelSize = 1.25
const manualOffset = new THREE.Vector3(0, 0, 0)
const trackedOffset = new THREE.Vector3(0, 0, 0)
const eye = new THREE.Vector3()

let screenFrame

let isDragging = false
let lastPointerX = 0
let lastPointerY = 0

const pressedKeys = new Set()
let lastTime = performance.now()
let lastUiTime = 0

let videoEl = null
let mediaStream = null
let faceLandmarker = null
let faceBaselineWidth = null
let lastDetectTime = 0
const tmpVec3a = new THREE.Vector3()
const tmpVec3b = new THREE.Vector3()

function setTrackingEnabled(nextEnabled) {
  trackingEnabled.value = nextEnabled
  if (trackingEnabled.value) {
    if (!window.isSecureContext) {
      trackingEnabled.value = false
      trackingStatus.value = 'Webcam failed: insecure context（请用 http://localhost 打开，或 https）'
      return
    }
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

async function startHeadTracking() {
  trackingStatus.value = 'Requesting camera permission...'

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

  const vision = await import('@mediapipe/tasks-vision')
  const fileset = await vision.FilesetResolver.forVisionTasks('/vendor/mediapipe/wasm')

  const localModelPath = '/vendor/mediapipe/models/face_landmarker.task'
  const remoteModelPath =
    'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task'

  try {
    trackingStatus.value = 'Loading face model (local)...'
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
        `Failed to load FaceLandmarker model. Put it at ${localModelPath} (run: npm run setup:mediapipe -- --download-model)`,
      )
    }
  }

  faceBaselineWidth = null
  lastFaceConfidence.value = null
  trackingStatus.value = 'Webcam on'
}

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

function resetEye() {
  manualOffset.set(0, 0, 0)
  trackedOffset.set(0, 0, 0)
  faceBaselineWidth = null
}

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

function applyWheel(deltaY) {
  const maxZ = 2.25
  const minZ = 0.35

  const zoom = deltaY * 0.0012
  manualOffset.z = clamp(manualOffset.z + zoom, minZ - baseEye.z, maxZ - baseEye.z)
}

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

function renderFrame(nowMs) {
  animationHandle = requestAnimationFrame(renderFrame)

  const dtSeconds = clamp((nowMs - lastTime) / 1000, 0, 0.05)
  lastTime = nowMs

  applyKeyboard(dtSeconds)
  updateHeadTracking(nowMs)
  updateCamera()

  if (nowMs - lastUiTime > 100) {
    lastUiTime = nowMs
    eyeText.value = `eye = (${eye.x.toFixed(3)}, ${eye.y.toFixed(3)}, ${eye.z.toFixed(3)})`
  }

  renderer.render(scene, camera)
}

function initThree() {
  scene = new THREE.Scene()
  scene.background = new THREE.Color('#0b0f16')

  camera = new THREE.PerspectiveCamera(60, 1, 0.05, 60)

  const canvas = document.createElement('canvas')
  renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: false,
    powerPreference: 'high-performance',
  })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio ?? 1, 2))

  mountEl.value.appendChild(canvas)

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

      root.add(model)
      root.updateMatrixWorld(true)

      const box = new THREE.Box3().setFromObject(model)
      const size = box.getSize(new THREE.Vector3())

      const maxDim = Math.max(1e-6, size.x, size.y, size.z)
      const scale = targetModelSize / maxDim
      model.scale.setScalar(scale)
      root.updateMatrixWorld(true)

      box.setFromObject(model)
      box.getSize(size)
      const center = box.getCenter(new THREE.Vector3())
      const minY = box.min.y

      model.position.x -= center.x
      model.position.z -= center.z
      model.position.y -= minY
      root.updateMatrixWorld(true)

      root.position.set(0, 0, baseModelZ)
      trackingStatus.value = trackingEnabled.value ? 'Webcam on' : 'Manual'
    },
    undefined,
    (err) => {
      trackingStatus.value = `Model load failed: ${err?.message ?? String(err)}`
    },
  )
}

function addDomEvents() {
  const canvas = renderer.domElement

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

  const onWheel = (ev) => {
    ev.preventDefault()
    applyWheel(ev.deltaY)
  }

  canvas.addEventListener('pointerdown', onPointerDown, { passive: true })
  canvas.addEventListener('pointermove', onPointerMove, { passive: true })
  canvas.addEventListener('pointerup', onPointerUp, { passive: true })
  canvas.addEventListener('pointercancel', onPointerUp, { passive: true })
  canvas.addEventListener('wheel', onWheel, { passive: false })

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

onMounted(() => {
  initThree()
  loadModel()
  addDomEvents()
  renderFrame(performance.now())
})

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
