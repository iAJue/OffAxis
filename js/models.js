/**
 * 模型列表（UI 下拉菜单的数据源）。
 *
 * 注意：这里的 transform 是“加载后施加在 gltf.scene 上”的额外变换，用于快速调初始：
 * - position: [x,y,z]，单位与模型一致（通常米，但很多模型不严格）
 * - rotation: [rx,ry,rz]，弧度（常用：Math.PI/2）
 * - scale: 数字（等比）或 [sx,sy,sz]（非等比）
 *
 * 建议：尽量用 scale 把不同模型“看起来大小接近”，再用 position/rotation 微调姿态。
 */
export const MODELS = [
  {
    name: "model.glb",
    url: "./model.glb",
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 }
  },
  {
    name: "model2.glb",
    url: "./model2.glb",
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 }
  },
  {
    name: "model3.glb",
    url: "./model3.glb",
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 }
  }
];
