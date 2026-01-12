import * as THREE from 'three'

/**
 * 离轴透视（Off-axis / Generalized Perspective）核心：
 *
 * 目标：让相机的投影不再是“以相机光心为中心对称”的视锥，而是根据一个真实的“屏幕平面”
 * 和“眼睛位置 eye”计算出一个【非对称视锥】。
 *
 * 这里采用常见的 Kooima (2009) generalized perspective 思路：
 * - 用屏幕平面的三个点 pa/pb/pc 定义一个矩形屏幕：
 *     pa: 左下角
 *     pb: 右下角
 *     pc: 左上角
 *   那么屏幕的右方向 vr = normalize(pb - pa)
 *         屏幕的上方向 vu = normalize(pc - pa)
 *         屏幕法线 vn = normalize(vr x vu)
 * - 用 eye（眼睛位置）到 pa/pb/pc 的向量投影到 vr/vu/vn 上，
 *   得到 near 平面的 left/right/top/bottom（注意这是“非对称”）。
 * - 同时把相机的世界矩阵设置为“以屏幕坐标系为相机坐标系”：
 *     X 轴对齐 vr，Y 轴对齐 vu，Z 轴对齐 vn，位置为 eye。
 *
 * 这样你移动 eye（鼠标/键盘/摄像头头部追踪）时，投影会产生强烈的“透视随视点变化”效果，
 * 也就是常见的窗户/全息屏幕那种“站起来/左右移动看到不同角度”的感觉。
 */

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

const _vr = new THREE.Vector3()
const _vu = new THREE.Vector3()
const _vn = new THREE.Vector3()
const _va = new THREE.Vector3()
const _vb = new THREE.Vector3()
const _vc = new THREE.Vector3()

/**
 * 计算屏幕平面的基向量（右/上/法线）。
 * @param {THREE.Vector3} pa 屏幕左下
 * @param {THREE.Vector3} pb 屏幕右下
 * @param {THREE.Vector3} pc 屏幕左上
 * @param {THREE.Vector3} eye 眼睛位置
 * @param {THREE.Vector3} outVr 输出：右方向
 * @param {THREE.Vector3} outVu 输出：上方向
 * @param {THREE.Vector3} outVn 输出：法线方向（朝向 eye）
 */
export function computeScreenBasis({ pa, pb, pc, eye, outVr = _vr, outVu = _vu, outVn = _vn }) {
  outVr.subVectors(pb, pa).normalize()
  outVu.subVectors(pc, pa).normalize()
  outVn.crossVectors(outVr, outVu).normalize()

  _va.subVectors(pa, eye)
  const d = -_va.dot(outVn)
  // 约定：vn 要指向“从屏幕指向 eye”的那一侧。
  // 如果 d < 0 说明法线方向反了，翻转 vn。
  if (d < 0) outVn.multiplyScalar(-1)

  return { vr: outVr, vu: outVu, vn: outVn }
}

/**
 * 根据 eye 与屏幕平面 pa/pb/pc 更新相机：
 * - projectionMatrix：非对称视锥（left/right/top/bottom）
 * - matrixWorld：相机坐标系对齐屏幕坐标系（vr/vu/vn）且位置为 eye
 *
 * 重要：这里不使用 camera.lookAt()，而是直接写入矩阵，避免和 Three 的自动更新互相打架。
 */
export function updateOffAxisCamera({
  camera,
  eye,
  pa,
  pb,
  pc,
  near = 0.05,
  far = 100,
}) {
  const { vr, vu, vn } = computeScreenBasis({ pa, pb, pc, eye })

  _va.subVectors(pa, eye)
  _vb.subVectors(pb, eye)
  _vc.subVectors(pc, eye)

  // d 是 eye 到屏幕平面的“有符号距离”（沿 vn 方向）。
  // d 越小，视锥越“夸张”；d <= 0 会导致投影无意义，所以做一个最小值保护。
  const d = -_va.dot(vn)
  const safeD = clamp(d, 1e-6, Number.POSITIVE_INFINITY)

  // 把屏幕三个点投影到 vr/vu 上，再按相似三角形缩放到 near 平面。
  // 注意 Three.js makePerspective 的参数顺序是 (left, right, top, bottom, near, far)。
  const left = vr.dot(_va) * near / safeD
  const right = vr.dot(_vb) * near / safeD
  const bottom = vu.dot(_va) * near / safeD
  const top = vu.dot(_vc) * near / safeD

  camera.projectionMatrix.makePerspective(left, right, top, bottom, near, far)
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert()

  // 固定相机矩阵：避免 three 自动用 position/rotation 覆盖我们手写的矩阵。
  camera.matrixAutoUpdate = false

  // camera.matrixWorld 的列向量对应相机的 X/Y/Z 轴（再加平移）。
  // 我们让相机坐标系直接对齐屏幕坐标系：
  // - X 轴 = vr（屏幕向右）
  // - Y 轴 = vu（屏幕向上）
  // - Z 轴 = vn（屏幕法线，朝向 eye）
  // - 平移 = eye
  camera.matrixWorld.set(
    vr.x, vu.x, vn.x, eye.x,
    vr.y, vu.y, vn.y, eye.y,
    vr.z, vu.z, vn.z, eye.z,
    0, 0, 0, 1,
  )
  camera.matrixWorldInverse.copy(camera.matrixWorld).invert()
}
