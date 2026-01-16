import * as THREE from "three";

/**
 * 根据物体包围盒（AABB）自动“居中取景”。
 *
 * 核心思路：
 * 1) 用 Box3 计算 object3d 的包围盒、中心点、最大边长
 * 2) 将 OrbitControls 的 target 指向中心点
 * 3) 按相机 fov 估算一个能包住物体的距离 distance
 * 4) 设置 near/far，避免裁剪导致模型缺块或精度太差
 *
 * @param {object} args
 * @param {import('three').PerspectiveCamera} args.camera
 * @param {import('three/addons/controls/OrbitControls.js').OrbitControls} args.controls
 * @param {import('three').Object3D} args.object3d
 * @returns {{box: import('three').Box3|null, center: import('three').Vector3|null, maxDim: number|null}}
 */
export function fitCameraToObject({ camera, controls, object3d }) {
  const box = new THREE.Box3().setFromObject(object3d);
  if (!Number.isFinite(box.min.x) || box.isEmpty()) return { box: null, center: null, maxDim: null };

  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);

  controls.target.copy(center);
  controls.update();

  const fov = THREE.MathUtils.degToRad(camera.fov);
  // 1.25 是“留白系数”，避免模型贴边
  const distance = (maxDim / (2 * Math.tan(fov / 2))) * 1.25;

  // 用一个略带俯视的角度：y 方向抬高一点，看起来更“展示台”
  camera.position.copy(center).add(new THREE.Vector3(distance, distance * 0.35, distance));
  // near/far 随距离自适应（太小会裁剪，太大又会损失深度精度）
  camera.near = Math.max(distance / 200, 0.01);
  camera.far = Math.max(distance * 50, 100);
  camera.updateProjectionMatrix();

  controls.update();

  return { box, center, maxDim };
}
