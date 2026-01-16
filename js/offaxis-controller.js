import * as THREE from "three";

/**
 * 裸眼 3D（off-axis 透视投影）控制器。
 *
 * 这不是“真正的眼动追踪硬件”，而是一个可运行的最小实现：
 * - 摄像头模式：用 MediaPipe FaceLandmarker 得到双眼 2D 位置 + 眼距（像素/归一化），粗略估计头部平移 + 深度变化
 * - 无摄像头模式：用鼠标在画布上移动模拟头部平移
 *
 * off-axis 原理简述：
 * - 传统透视相机的视锥体是左右对称的（中心在屏幕中央）
 * - 当观察者（眼睛）不在屏幕法线中心时，视锥体应当变成“非对称”，这样屏幕上的像素对应真实视线
 * - 本实现把“屏幕”抽象成世界坐标系下的一个矩形平面（由中心点 + 高度 + 当前画布宽高比得到）
 * - 每帧用观察点 eye 计算出 frustum 的 l/r/t/b，然后写入 camera.projectionMatrix
 *
 * 重要约定：
 * - 我们把“屏幕平面”放在模型前方一点点（setDefaultsFromModel 里），只是为了让效果明显
 * - 更真实的效果需要做显示器物理标定（屏幕尺寸/距离/相机内参等），这里不做
 */
export function createOffAxisController({
  camera,
  controls,
  canvas,
  webcamPane,
  webcamVideo,
  setStatus,
  getParallaxGain
}) {
  const state = {
    // enabled：off-axis 模式开关。开启后会禁用 OrbitControls，并直接写 camera.matrixWorld/projectionMatrix
    enabled: false,
    // tracking：是否启用摄像头追踪（不追踪时用鼠标模拟）
    tracking: false,
    // screenOrigin：屏幕矩形的中心点（世界坐标）
    screenOrigin: new THREE.Vector3(0, 0, 0),
    // screenHeight：屏幕矩形高度（世界单位），宽度由 screenHeight * aspect 得到
    screenHeight: 1,
    // baseDistance：默认观察距离（世界单位），会被“眼距变化”映射为 z 深度
    baseDistance: 2,
    // head / headTarget：观察点相对 screenOrigin 的偏移（x,y）与距离（z）
    head: new THREE.Vector3(0, 0, 2),
    headTarget: new THREE.Vector3(0, 0, 2),
    // refEyeDist：参考眼距（第一次检测到的眼距），用来把 eyeDist 变化映射为 depthRatio
    refEyeDist: null,
    // stream：getUserMedia 返回的视频流
    stream: null,
    // faceLandmarker：MediaPipe 实例（懒加载）
    faceLandmarker: null,
    // lastVideoTime：避免对同一帧视频重复推理
    lastVideoTime: -1
  };

  // 用于关闭 off-axis 时恢复普通相机/controls 状态
  const normalCameraState = {
    position: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    target: new THREE.Vector3()
  };

  // 大量向量/矩阵对象复用，减少 GC 抖动
  const tmp = {
    pa: new THREE.Vector3(),
    pb: new THREE.Vector3(),
    pc: new THREE.Vector3(),
    vr: new THREE.Vector3(),
    vu: new THREE.Vector3(),
    vn: new THREE.Vector3(),
    va: new THREE.Vector3(),
    vb: new THREE.Vector3(),
    vc: new THREE.Vector3(),
    eye: new THREE.Vector3(),
    basis: new THREE.Matrix4()
  };

  /**
   * 开关 off-axis。
   * - 开启：记录普通相机状态，关闭 matrixAutoUpdate，提示可用鼠标模拟
   * - 关闭：恢复普通相机状态，重新启用 controls
   */
  function setEnabled(enabled) {
    state.enabled = Boolean(enabled);
    controls.enabled = !state.enabled;

    if (state.enabled) {
      normalCameraState.position.copy(camera.position);
      normalCameraState.quaternion.copy(camera.quaternion);
      normalCameraState.target.copy(controls.target);
      camera.matrixAutoUpdate = false;
      if (!state.tracking) setStatus("提示：移动鼠标可模拟头动");
      return;
    }

    camera.matrixAutoUpdate = true;
    camera.position.copy(normalCameraState.position);
    camera.quaternion.copy(normalCameraState.quaternion);
    controls.target.copy(normalCameraState.target);
    controls.update();
    setStatus("");
  }

  /**
   * 根据模型尺寸做一套“默认屏幕/视距”参数。
   * 这相当于一个“自动标定”的近似：让效果对不同模型大小都比较明显。
   *
   * @param {import('three').Vector3} center 模型中心点（世界坐标）
   * @param {number} maxDim 模型最大边长（世界单位）
   */
  function setDefaultsFromModel(center, maxDim) {
    // 屏幕中心放在模型中心略上方、略前方
    state.screenOrigin.copy(center).add(new THREE.Vector3(0, maxDim * 0.05, maxDim * 0.18));
    // 屏幕高度按模型尺寸缩放；宽度会按 canvas 宽高比自动计算
    state.screenHeight = Math.max(maxDim * 0.95, 1);
    // 默认观察距离：离模型稍远一点，避免近裁剪
    state.baseDistance = Math.max(maxDim * 1.35, 1.2);
    if (!state.tracking) state.headTarget.set(0, 0, state.baseDistance);
    if (!state.tracking) state.head.copy(state.headTarget);
    state.refEyeDist = null;
  }

  /**
   * 鼠标模拟：把鼠标位置映射到“观察点相对屏幕中心的偏移”。
   * 仅在 off-axis 开启且未启用摄像头追踪时有效。
   */
  function handlePointerMove(e) {
    if (!state.enabled) return;
    if (state.tracking) return;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width === 0 || height === 0) return;
    const aspect = width / height;
    const screenWidth = state.screenHeight * aspect;
    const gain = getParallaxGain();
    const x = (e.clientX / width - 0.5) * screenWidth * gain;
    const y = -(e.clientY / height - 0.5) * state.screenHeight * gain;
    state.headTarget.set(x, y, state.baseDistance);
  }

  /**
   * 每帧更新：
   * 1) 若 tracking 开启，则从摄像头帧更新 headTarget（x,y,z）
   * 2) 平滑插值到 head（避免抖动）
   * 3) 由 head 计算 off-axis 投影矩阵 + 相机位姿
   */
  function update() {
    updateHeadTracking();
    if (state.enabled) {
      state.head.lerp(state.headTarget, state.tracking ? 0.22 : 0.18);
      updateOffAxisCamera();
    }
  }

  /**
   * 摄像头追踪：从 MediaPipe 得到双眼关键点，粗略估计头部位置。
   *
   * 说明：FaceLandmarker 的 landmarks 是归一化坐标（0~1）。
   * - 我们用两眼中心点 (centerX, centerY) 映射到屏幕平面上的 x/y 偏移
   * - 用两眼距离 eyeDist 的变化估计 z 深度（离得近眼距变大 => z 变小）
   *
   * 这是非常粗糙的近似，但足够演示“视差 + 离轴投影”的感觉。
   */
  function updateHeadTracking() {
    if (!state.tracking) return;
    if (!state.faceLandmarker) return;
    if (webcamVideo.readyState < 2) return;

    const nowMs = performance.now();
    if (webcamVideo.currentTime === state.lastVideoTime) return;
    state.lastVideoTime = webcamVideo.currentTime;

    const result = state.faceLandmarker.detectForVideo(webcamVideo, nowMs);
    const landmarks = result?.faceLandmarks?.[0];
    if (!landmarks) return;

    // 这里选用左右眼外侧附近的点位（MediaPipe 的固定索引）
    const leftEye = landmarks[33];
    const rightEye = landmarks[263];
    if (!leftEye || !rightEye) return;

    const centerX = (leftEye.x + rightEye.x) * 0.5;
    const centerY = (leftEye.y + rightEye.y) * 0.5;
    const eyeDist = Math.hypot(leftEye.x - rightEye.x, leftEye.y - rightEye.y);
    if (!Number.isFinite(eyeDist) || eyeDist <= 0) return;
    if (!state.refEyeDist) state.refEyeDist = eyeDist;

    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width === 0 || height === 0) return;
    const aspect = width / height;
    const screenWidth = state.screenHeight * aspect;
    const gain = getParallaxGain();

    // x/y：以画面中心为 0，向右/向上为正（y 取反让屏幕坐标更直观）
    const x = (centerX - 0.5) * screenWidth * gain;
    const y = -(centerY - 0.5) * state.screenHeight * gain;

    // z：用“参考眼距 / 当前眼距”估计深度比例（范围做 clamp 防止爆炸）
    const depthRatio = THREE.MathUtils.clamp(state.refEyeDist / eyeDist, 0.7, 1.8);
    const z = state.baseDistance * depthRatio;

    state.headTarget.set(x, y, z);
  }

  /**
   * 核心：由“屏幕平面 + 观察点”计算非对称 frustum。
   *
   * 这里采用经典推导：
   * - 在屏幕平面上取三个点 pa/pb/pc 形成矩形的下左/下右/上左
   * - 计算屏幕的基向量 vr/vu（右/上）和法向 vn
   * - 以 eye 为原点看向屏幕，求出 near 平面上的 l/r/b/t
   * - 写入 camera.projectionMatrix，并构造相机 world matrix（basis + eye）
   */
  function updateOffAxisCamera() {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width === 0 || height === 0) return;

    const aspect = width / height;
    const screenWidth = state.screenHeight * aspect;
    const origin = state.screenOrigin;

    // 屏幕矩形三个点（世界坐标）
    tmp.pa.set(origin.x - screenWidth / 2, origin.y - state.screenHeight / 2, origin.z);
    tmp.pb.set(origin.x + screenWidth / 2, origin.y - state.screenHeight / 2, origin.z);
    tmp.pc.set(origin.x - screenWidth / 2, origin.y + state.screenHeight / 2, origin.z);

    // 屏幕坐标系的三个轴：右 vr / 上 vu / 法线 vn
    tmp.vr.subVectors(tmp.pb, tmp.pa).normalize();
    tmp.vu.subVectors(tmp.pc, tmp.pa).normalize();
    tmp.vn.crossVectors(tmp.vr, tmp.vu).normalize();

    // 观察点 eye：屏幕中心 + head 偏移
    tmp.eye.copy(origin).add(state.head);

    // 观察点到屏幕三个点的向量
    tmp.va.subVectors(tmp.pa, tmp.eye);
    tmp.vb.subVectors(tmp.pb, tmp.eye);
    tmp.vc.subVectors(tmp.pc, tmp.eye);

    // d：观察点到屏幕平面的“有符号距离”（投影到法线）
    const d = Math.max(0.01, -tmp.va.dot(tmp.vn));
    const near = camera.near;
    const far = camera.far;

    // 计算 near 平面上的左右上下边界（非对称）
    const l = (tmp.vr.dot(tmp.va) * near) / d;
    const r = (tmp.vr.dot(tmp.vb) * near) / d;
    const b = (tmp.vu.dot(tmp.va) * near) / d;
    const t = (tmp.vu.dot(tmp.vc) * near) / d;

    // 写入投影矩阵（off-axis frustum）
    camera.projectionMatrix.makePerspective(l, r, t, b, near, far);
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();

    // 写入相机位姿：相机的 x/y/z 轴分别为 vr/vu/vn，位置为 eye
    tmp.basis.makeBasis(tmp.vr, tmp.vu, tmp.vn);
    tmp.basis.setPosition(tmp.eye);
    camera.matrixWorld.copy(tmp.basis);
    camera.matrixWorldInverse.copy(tmp.basis).invert();
    camera.position.copy(tmp.eye);
  }

  /**
   * 开启摄像头追踪：
   * - 懒加载 MediaPipe tasks-vision（纯 ESM，CDN）
   * - getUserMedia 获取摄像头视频流
   * - FaceLandmarker 每帧推理
   *
   * 注意：摄像头只能在 https 或 http://localhost 下工作。
   */
  async function startTracking() {
    try {
      setStatus("请求摄像头权限…");
      webcamPane.style.display = "block";

      if (!state.faceLandmarker) {
        setStatus("加载追踪模型…");
        const vision = await import(
          "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs"
        );
        const fileset = await vision.FilesetResolver.forVisionTasks(
          "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
        );
        state.faceLandmarker = await vision.FaceLandmarker.createFromOptions(fileset, {
          baseOptions: {
            modelAssetPath:
              "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
            delegate: "GPU"
          },
          runningMode: "VIDEO",
          numFaces: 1
        });
      }

      state.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user" },
        audio: false
      });
      webcamVideo.srcObject = state.stream;
      await webcamVideo.play();

      state.tracking = true;
      state.lastVideoTime = -1;
      state.refEyeDist = null;
      // 开启追踪时如果 off-axis 还没开，自动打开（否则相机不跟随）
      if (!state.enabled) setEnabled(true);
      setStatus("追踪中（单人）");
    } catch (err) {
      console.error(err);
      stopTracking();
      setStatus("开启追踪失败（检查权限/摄像头）");
    }
  }

  /**
   * 关闭追踪并释放摄像头资源（stop tracks）。
   */
  function stopTracking() {
    state.tracking = false;
    state.refEyeDist = null;
    state.lastVideoTime = -1;
    webcamPane.style.display = "none";
    if (state.stream) {
      for (const t of state.stream.getTracks()) t.stop();
      state.stream = null;
    }
    webcamVideo.srcObject = null;
    setStatus(state.enabled ? "提示：移动鼠标可模拟头动" : "");
  }

  return {
    get enabled() {
      return state.enabled;
    },
    get tracking() {
      return state.tracking;
    },
    setEnabled,
    setDefaultsFromModel,
    handlePointerMove,
    update,
    startTracking,
    stopTracking
  };
}
