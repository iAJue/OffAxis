import * as THREE from 'three'

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

const _vr = new THREE.Vector3()
const _vu = new THREE.Vector3()
const _vn = new THREE.Vector3()
const _va = new THREE.Vector3()
const _vb = new THREE.Vector3()
const _vc = new THREE.Vector3()

export function computeScreenBasis({ pa, pb, pc, eye, outVr = _vr, outVu = _vu, outVn = _vn }) {
  outVr.subVectors(pb, pa).normalize()
  outVu.subVectors(pc, pa).normalize()
  outVn.crossVectors(outVr, outVu).normalize()

  _va.subVectors(pa, eye)
  const d = -_va.dot(outVn)
  if (d < 0) outVn.multiplyScalar(-1)

  return { vr: outVr, vu: outVu, vn: outVn }
}

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

  const d = -_va.dot(vn)
  const safeD = clamp(d, 1e-6, Number.POSITIVE_INFINITY)

  const left = vr.dot(_va) * near / safeD
  const right = vr.dot(_vb) * near / safeD
  const bottom = vu.dot(_va) * near / safeD
  const top = vu.dot(_vc) * near / safeD

  camera.projectionMatrix.makePerspective(left, right, top, bottom, near, far)
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert()

  camera.matrixAutoUpdate = false
  camera.matrixWorld.set(
    vr.x, vu.x, vn.x, eye.x,
    vr.y, vu.y, vn.y, eye.y,
    vr.z, vu.z, vn.z, eye.z,
    0, 0, 0, 1,
  )
  camera.matrixWorldInverse.copy(camera.matrixWorld).invert()
}
