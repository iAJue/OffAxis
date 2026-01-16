import * as THREE from "three";
import { applyModelTransform, disposeObject3D } from "./model-utils.js";
import { fitCameraToObject } from "./camera-utils.js";

/**
 * 模型控制器：负责
 * - 通过 GLTFLoader 加载 glb
 * - 切换模型时释放旧模型资源
 * - 应用初始 transform（position/rotation/scale）
 * - 自动取景（fitCameraToObject）
 * - 把“包围盒信息”回调给外部（用于地面/阴影/off-axis 标定）
 */
export function createModelController({ scene, loader, camera, controls, setStatus, onModelChanged }) {
  let currentRoot = null;

  /**
   * 加载并切换模型。
   * @param {{url: string, transform?: any}} args
   * @returns {Promise<{root: import('three').Object3D, box: import('three').Box3|null, center: import('three').Vector3|null, maxDim: number|null}>}
   */
  async function loadModel({ url, transform }) {
    setStatus("加载中…");
    return new Promise((resolve, reject) => {
      loader.load(
        url,
        (gltf) => {
          // 1) 移除旧模型并释放资源（避免越切越卡/显存泄漏）
          if (currentRoot) {
            scene.remove(currentRoot);
            disposeObject3D(currentRoot);
          }

          // 2) 添加新模型
          currentRoot = gltf.scene;
          scene.add(currentRoot);

          // 3) 应用模型初始变换（来自 MODELS 配置）
          applyModelTransform(currentRoot, transform);

          // 4) 自动取景，并把包围盒信息提供给其他模块
          const { box, center, maxDim } = fitCameraToObject({ camera, controls, object3d: currentRoot });
          const payload = { root: currentRoot, box, center, maxDim };
          if (onModelChanged) onModelChanged(payload);

          setStatus("");
          resolve(payload);
        },
        (evt) => {
          if (!evt.total) return;
          const pct = Math.round((evt.loaded / evt.total) * 100);
          setStatus(`加载中… ${pct}%`);
        },
        (err) => {
          console.error(err);
          setStatus("加载失败，打开控制台看错误");
          reject(err);
        }
      );
    });
  }

  /**
   * 获取当前 gltf.scene（用于调试/外部逻辑）。
   */
  function getCurrentRoot() {
    return currentRoot;
  }

  /**
   * 计算当前模型的包围盒信息（不改变相机）。
   * 主要用于调试/后续扩展。
   */
  function getCurrentBounds() {
    if (!currentRoot) return { box: null, center: null, maxDim: null };
    const box = new THREE.Box3().setFromObject(currentRoot);
    if (!Number.isFinite(box.min.x) || box.isEmpty()) return { box: null, center: null, maxDim: null };
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    return { box, center, maxDim };
  }

  return { loadModel, getCurrentRoot, getCurrentBounds };
}
