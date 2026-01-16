import * as THREE from "three";

/**
 * “二次元/卡通风格”控制器：
 * - MeshToonMaterial 分层光照（通过 gradientMap 控制分段）
 * - 简易描边（BackSide 放大一圈）
 * - 渐变天空（ShaderMaterial）
 * - 地面圆盘 + 纹理（CanvasTexture）
 * - 闪光粒子（Points + 自制星形贴图）
 *
 * 设计目标：不依赖后处理（postprocessing），尽量保持“最小可运行”。
 */
export function createAnimeController({ scene, dirLight }) {
  // Toon 分段纹理：越小分段越“硬”，更二次元；这里用 5 段
  const toonGradientMap = createToonGradientMap(5);
  // 天空/地面/粒子是“环境”，常驻场景
  const sky = createGradientSky();
  scene.add(sky);
  const ground = createGround(toonGradientMap);
  scene.add(ground);
  const sparkles = createSparkles();
  scene.add(sparkles);

  // enabled：是否开启二次元效果（材质/环境都会受影响）
  let enabled = true;
  // currentRoot：当前模型的根节点（gltf.scene）
  let currentRoot = null;

  /**
   * 开关二次元风格。
   * @param {boolean} nextEnabled
   */
  function setEnabled(nextEnabled) {
    enabled = Boolean(nextEnabled);
    updateEnvironmentStyle();
    if (currentRoot) applyAnimeStyle(currentRoot, enabled);
  }

  /**
   * 设置当前模型根节点（用于对模型 mesh 应用 toon/描边）。
   * @param {import('three').Object3D} root
   */
  function setCurrentRoot(root) {
    currentRoot = root;
    if (currentRoot) applyAnimeStyle(currentRoot, enabled);
  }

  /**
   * 每帧更新（只做轻量动画）：粒子漂浮 + 天空跟随相机。
   */
  function update(camera, timeSec) {
    updateSparkles(sparkles, timeSec);
    sky.position.copy(camera.position);
  }

  /**
   * 当模型切换或取景变化时，根据包围盒重置环境参数：
   * - 地面放到模型底部略下方
   * - 粒子围绕模型中心生成
   * - 方向光 target 指向模型中心，并按模型大小调整阴影相机范围
   */
  function updateForModel({ box, center, maxDim }) {
    if (!box || !center || !Number.isFinite(maxDim)) return;

    updateEnvironmentStyle();

    // 地面：贴近模型底部，避免漂浮；scale 让地面比模型大一些
    const groundY = box.min.y - maxDim * 0.02;
    ground.position.set(center.x, groundY, center.z);
    ground.scale.setScalar(Math.max(maxDim * 1.35, 1));

    // 粒子：围绕中心，半径随模型尺寸变化
    sparkles.userData.radius = maxDim;
    sparkles.position.copy(center);
    resetSparkles(sparkles);

    // 主光：对准模型中心，阴影范围随模型变大/变小
    dirLight.target.position.copy(center);
    dirLight.target.updateMatrixWorld();

    const shadowSpan = maxDim * 2.5;
    dirLight.shadow.camera.left = -shadowSpan;
    dirLight.shadow.camera.right = shadowSpan;
    dirLight.shadow.camera.top = shadowSpan;
    dirLight.shadow.camera.bottom = -shadowSpan;
    dirLight.shadow.camera.near = 0.1;
    dirLight.shadow.camera.far = Math.max(maxDim * 10, 50);
    dirLight.shadow.camera.updateProjectionMatrix();
  }

  function updateEnvironmentStyle() {
    // 天空渐变：二次元更亮更粉；关闭时变暗（与页面底色一致）
    sky.material.uniforms.topColor.value.set(enabled ? 0x60a5fa : 0x0b1220);
    sky.material.uniforms.bottomColor.value.set(enabled ? 0xfbcfe8 : 0x0b1220);
    // 地面：开启更亮更不透明，关闭更暗更透明
    ground.visible = true;
    ground.material.color.set(enabled ? 0xf8fafc : 0x111827);
    ground.material.opacity = enabled ? 0.96 : 0.45;
    ground.material.transparent = true;
    ground.material.needsUpdate = true;
    // 粒子只在二次元开启时显示
    sparkles.visible = enabled;
  }

  /**
   * 对模型 Mesh 应用 toon + 描边。
   * - 原始材质会缓存到 userData._origMaterial
   * - Toon 材质会缓存到 userData._toonMaterial（避免重复创建）
   */
  function applyAnimeStyle(root, styleEnabled) {
    root.traverse((obj) => {
      if (!obj.isMesh) return;
      // 描边 mesh 也是 Mesh，但它带了 _isOutline 标记，避免被再次套娃处理
      if (obj.userData?._isOutline) return;

      // 让模型参与阴影（主光 dirLight.castShadow 已开）
      obj.castShadow = true;
      obj.receiveShadow = true;

      if (!obj.userData._origMaterial) {
        obj.userData._origMaterial = obj.material;
      }

      if (styleEnabled) {
        if (!obj.userData._toonMaterial) {
          obj.userData._toonMaterial = toToonMaterial(obj.userData._origMaterial);
        }
        obj.material = obj.userData._toonMaterial;
        if (obj.material?.isMeshToonMaterial) {
          // SkinnedMesh/morph 需要显式打开开关，否则动画/表情会失效
          if (obj.isSkinnedMesh) obj.material.skinning = true;
          if (obj.morphTargetInfluences) {
            obj.material.morphTargets = true;
            obj.material.morphNormals = true;
          }
          obj.material.needsUpdate = true;
        }
        ensureOutline(obj, true);
      } else {
        obj.material = obj.userData._origMaterial;
        ensureOutline(obj, false);
      }
    });
  }

  function toToonMaterial(original) {
    // 多材质时这里只取第一个做“代表”，属于简化处理（最小示例）
    const pick = Array.isArray(original) ? original[0] : original;
    const toon = new THREE.MeshToonMaterial({
      color: pick?.color?.clone?.() ?? new THREE.Color(0xffffff),
      map: pick?.map ?? null,
      transparent: Boolean(pick?.transparent),
      opacity: pick?.opacity ?? 1,
      side: pick?.side ?? THREE.FrontSide,
      alphaTest: pick?.alphaTest ?? 0,
      gradientMap: toonGradientMap
    });
    if (pick?.emissive) toon.emissive.copy(pick.emissive);
    if (pick?.emissiveMap) toon.emissiveMap = pick.emissiveMap;
    return toon;
  }

  function ensureOutline(mesh, outlineEnabled) {
    // SkinnedMesh 做几何缩放描边会有穿帮/变形风险，最小示例先跳过
    if (mesh.isSkinnedMesh) return;
    if (outlineEnabled) {
      if (mesh.userData._outlineMesh) return;
      // 用 BackSide + 略放大实现描边（不需要后处理）
      const outlineMat = new THREE.MeshBasicMaterial({
        color: 0x111827,
        side: THREE.BackSide,
        transparent: true,
        opacity: 0.95,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1
      });
      const outline = new THREE.Mesh(mesh.geometry, outlineMat);
      outline.frustumCulled = false;
      outline.scale.setScalar(1.03);
      outline.userData._isOutline = true;
      mesh.add(outline);
      mesh.userData._outlineMesh = outline;
      return;
    }

    const outline = mesh.userData._outlineMesh;
    if (!outline) return;
    mesh.remove(outline);
    outline.material.dispose();
    mesh.userData._outlineMesh = null;
  }

  return {
    get enabled() {
      return enabled;
    },
    setEnabled,
    setCurrentRoot,
    updateForModel,
    update
  };
}

/**
 * 生成 toon 的分段纹理（gradientMap）。
 * steps 越小分层越明显；一般 3~6 段比较“动画片”。
 */
function createToonGradientMap(steps) {
  const data = new Uint8Array(steps * 4);
  for (let i = 0; i < steps; i++) {
    const v = Math.round((i / (steps - 1)) * 255);
    data[i * 4 + 0] = v;
    data[i * 4 + 1] = v;
    data[i * 4 + 2] = v;
    data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, steps, 1, THREE.RGBAFormat);
  tex.needsUpdate = true;
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  return tex;
}

/**
 * 渐变天空：用 shader 在球体内侧画上下渐变。
 * 注意：天空 mesh 会在 update() 里跟随相机位置移动，避免视差。
 */
function createGradientSky() {
  const geo = new THREE.SphereGeometry(1, 32, 16);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      topColor: { value: new THREE.Color(0x60a5fa) },
      bottomColor: { value: new THREE.Color(0xfbcfe8) }
    },
    vertexShader: `
      varying vec3 vWorldPosition;
      void main() {
        vWorldPosition = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 topColor;
      uniform vec3 bottomColor;
      varying vec3 vWorldPosition;
      void main() {
        float h = normalize(vWorldPosition).y;
        float t = smoothstep(-0.15, 0.9, h);
        vec3 col = mix(bottomColor, topColor, t);
        gl_FragColor = vec4(col, 1.0);
      }
    `
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.scale.setScalar(5000);
  mesh.frustumCulled = false;
  return mesh;
}

/**
 * 地面：一个圆盘（CircleGeometry）+ CanvasTexture 做简单花纹。
 */
function createGround(gradientMap) {
  const tex = createGroundTexture();
  const mat = new THREE.MeshToonMaterial({
    color: 0xf8fafc,
    map: tex,
    gradientMap,
    transparent: true,
    opacity: 0.96
  });
  const mesh = new THREE.Mesh(new THREE.CircleGeometry(1, 96), mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.receiveShadow = true;
  return mesh;
}

/**
 * 生成地面纹理（纯 Canvas 绘制，避免引入图片资源）。
 */
function createGroundTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext("2d");

  const grd = ctx.createRadialGradient(256, 256, 10, 256, 256, 256);
  grd.addColorStop(0, "rgba(255,255,255,0.95)");
  grd.addColorStop(1, "rgba(255,255,255,0.35)");
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, 512, 512);

  ctx.strokeStyle = "rgba(15, 23, 42, 0.08)";
  ctx.lineWidth = 2;
  for (let r = 40; r <= 240; r += 40) {
    ctx.beginPath();
    ctx.arc(256, 256, r, 0, Math.PI * 2);
    ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = 2;
  return tex;
}

/**
 * 闪光粒子：使用 PointsMaterial + 星形贴图，开启 AdditiveBlending 变“亮闪闪”。
 */
function createSparkles() {
  const count = 220;
  const positions = new Float32Array(count * 3);
  const basePositions = new Float32Array(count * 3);
  const meta = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    meta[i * 2 + 0] = Math.random() * Math.PI * 2;
    meta[i * 2 + 1] = 0.6 + Math.random() * 1.2;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));

  const mat = new THREE.PointsMaterial({
    size: 0.03,
    map: createSparkleTexture(),
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
    blending: THREE.AdditiveBlending
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.userData.radius = 1;
  points.userData.basePositions = basePositions;
  points.userData.meta = meta;
  points.visible = true;
  return points;
}

/**
 * 重新随机生成粒子位置：围绕 points.position（一般设置为模型中心）生成局部坐标。
 */
function resetSparkles(points) {
  const radius = Math.max(points.userData.radius, 1);
  const positions = points.geometry.attributes.position.array;
  const basePositions = points.userData.basePositions;
  const meta = points.userData.meta;
  const count = positions.length / 3;

  for (let i = 0; i < count; i++) {
    const r = radius * (0.15 + Math.random() * 0.95);
    const a = Math.random() * Math.PI * 2;
    const y = (Math.random() * 0.9 + 0.05) * radius * 0.55;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const yy = y;

    basePositions[i * 3 + 0] = x;
    basePositions[i * 3 + 1] = yy;
    basePositions[i * 3 + 2] = z;

    positions[i * 3 + 0] = x;
    positions[i * 3 + 1] = yy;
    positions[i * 3 + 2] = z;

    meta[i * 2 + 0] = Math.random() * Math.PI * 2;
    meta[i * 2 + 1] = 0.6 + Math.random() * 1.2;
  }
  points.geometry.attributes.position.needsUpdate = true;
}

/**
 * 粒子轻量动画：上下漂浮 + 绕 Y 轴慢慢旋转。
 */
function updateSparkles(points, timeSec) {
  if (!points.visible) return;
  const radius = Math.max(points.userData.radius, 1);
  const positions = points.geometry.attributes.position.array;
  const basePositions = points.userData.basePositions;
  const meta = points.userData.meta;
  const count = positions.length / 3;

  for (let i = 0; i < count; i++) {
    const phase = meta[i * 2 + 0];
    const speed = meta[i * 2 + 1];
    positions[i * 3 + 0] = basePositions[i * 3 + 0];
    positions[i * 3 + 1] = basePositions[i * 3 + 1] + Math.sin(timeSec * speed + phase) * radius * 0.02;
    positions[i * 3 + 2] = basePositions[i * 3 + 2];
  }
  points.rotation.y += 0.0012;
  points.geometry.attributes.position.needsUpdate = true;
}

/**
 * 生成星形粒子贴图（CanvasTexture）。
 */
function createSparkleTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, 128, 128);

  ctx.translate(64, 64);
  ctx.fillStyle = "rgba(255,255,255,1)";
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const ang = (i / 8) * Math.PI * 2;
    const r = i % 2 === 0 ? 46 : 14;
    const x = Math.cos(ang) * r;
    const y = Math.sin(ang) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  return tex;
}
