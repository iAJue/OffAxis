/**
 * 模型相关的小工具：
 * - applyModelTransform：把配置里的初始 position/rotation/scale 应用到 gltf.scene
 * - disposeObject3D：切换模型时释放 GPU 资源（geometry/material/texture）避免内存泄漏
 */
export function applyModelTransform(root, transform) {
  if (!root || !transform) return;
  const { position, rotation, scale } = transform;

  // 注意：rotation 是弧度，不是角度
  if (position && position.length === 3) root.position.set(position[0], position[1], position[2]);
  if (rotation && rotation.length === 3) root.rotation.set(rotation[0], rotation[1], rotation[2]);

  if (scale !== undefined && scale !== null) {
    // scale 支持等比（数字）或非等比（数组）
    if (Array.isArray(scale) && scale.length === 3) root.scale.set(scale[0], scale[1], scale[2]);
    else root.scale.setScalar(Number(scale));
  }

  // 立即刷新 worldMatrix，确保后续 setFromObject() 得到正确包围盒
  root.updateMatrixWorld(true);
}

/**
 * 释放 Object3D（及其子树）占用的 GPU 资源。
 *
 * three.js 不会在 remove() 后自动 dispose：
 * - geometry.dispose()
 * - material.dispose()
 * - texture.dispose()
 *
 * 这里额外处理了我们在二次元模式下缓存到 userData 的材质（_origMaterial/_toonMaterial）。
 */
export function disposeObject3D(root) {
  if (!root) return;
  // 同一个 geometry/material 可能被多个 Mesh 共享，用 Set 去重
  const disposedGeometries = new Set();
  const disposedMaterials = new Set();
  const disposedTextures = new Set();

  root.traverse((obj) => {
    // 二次元模式会把“原材质/卡通材质”缓存起来，切换模型时也需要一起释放
    if (obj.userData?._origMaterial) collectMaterial(obj.userData._origMaterial);
    if (obj.userData?._toonMaterial) collectMaterial(obj.userData._toonMaterial);

    if (obj.geometry && !disposedGeometries.has(obj.geometry)) {
      disposedGeometries.add(obj.geometry);
      obj.geometry.dispose();
    }
    collectMaterial(obj.material);
  });

  function collectMaterial(material) {
    if (!material) return;
    if (Array.isArray(material)) {
      for (const m of material) collectMaterial(m);
      return;
    }
    if (disposedMaterials.has(material)) return;
    disposedMaterials.add(material);

    // three 的材质上会挂各种贴图属性（map/normalMap/metalnessMap...），统一扫描并释放
    for (const key of Object.keys(material)) {
      const value = material[key];
      if (value && typeof value === "object" && value.isTexture && !disposedTextures.has(value)) {
        disposedTextures.add(value);
        value.dispose();
      }
    }
    material.dispose();
  }
}
