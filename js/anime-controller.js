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
  // 房间：墙/地/顶（前方留空，方便看模型）
  const room = createRoom(toonGradientMap);
  scene.add(room.group);

  // enabled：是否开启二次元效果（材质/环境都会受影响）
  let enabled = true;
  // roomEnabled：是否显示房间环境（显示时会隐藏天空/地面圆盘）
  let roomEnabled = false;
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
   * 开关房间环境。
   * @param {boolean} nextEnabled
   */
  function setRoomEnabled(nextEnabled) {
    roomEnabled = Boolean(nextEnabled);
    updateEnvironmentStyle();
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
    if (sky.visible) sky.position.copy(camera.position);
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

    // 房间：跟随模型中心与底部，尺寸按模型大小自适应
    room.updateForModel({ center, maxDim, floorY: groundY });

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
    ground.visible = !roomEnabled;
    ground.material.color.set(enabled ? 0xf8fafc : 0x111827);
    ground.material.opacity = enabled ? 0.96 : 0.45;
    ground.material.transparent = true;
    ground.material.needsUpdate = true;
    // 粒子只在二次元开启时显示
    sparkles.visible = enabled;

    // 房间环境：显示时隐藏天空（避免“穿帮”），并按 enabled 调整配色/窗光
    room.group.visible = roomEnabled;
    sky.visible = !roomEnabled;
    room.setStyleEnabled(enabled);
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
    get roomEnabled() {
      return roomEnabled;
    },
    setEnabled,
    setRoomEnabled,
    setCurrentRoot,
    updateForModel,
    update
  };
}

/**
 * 房间实现：用 PlaneGeometry 拼一个三面墙 + 地板 + 天花板的盒子。
 * - 前方（+Z）留空，方便相机看进去
 * - 尺寸会在 updateForModel() 里按模型大小调整
 */
function createRoom(gradientMap) {
  const group = new THREE.Group();
  group.name = "room";

  // 房间补光：避免 Toon 在阴影里“发黑一片”
  // 注：这是环境光，不投射阴影；房间开关会控制 group.visible，所以不用额外开关
  const fillLight = new THREE.AmbientLight(0xffffff, 0.35);
  group.add(fillLight);

  const floorMat = new THREE.MeshToonMaterial({
    color: 0xf8fafc,
    gradientMap,
    transparent: true,
    opacity: 0.98
  });
  const wallMat = new THREE.MeshToonMaterial({
    // 墙面默认用更亮的暖色，避免“看起来全黑”
    color: 0xfff1f2,
    gradientMap,
    transparent: true,
    opacity: 0.92
  });
  const ceilingMat = new THREE.MeshToonMaterial({
    color: 0xf0f9ff,
    gradientMap,
    transparent: true,
    opacity: 0.92
  });

  // 让墙/顶在弱光环境也不至于全黑：加一点 emissive（自发光）
  wallMat.emissive = new THREE.Color(0x111827);
  wallMat.emissiveIntensity = 0.12;
  ceilingMat.emissive = new THREE.Color(0x0b1220);
  ceilingMat.emissiveIntensity = 0.08;

  // 单位平面（宽=1, 高=1），后续用 scale 调整到真实尺寸
  const plane = new THREE.PlaneGeometry(1, 1, 1, 1);
  const unitBox = new THREE.BoxGeometry(1, 1, 1);

  const floor = new THREE.Mesh(plane, floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  group.add(floor);

  const ceiling = new THREE.Mesh(plane, ceilingMat);
  ceiling.rotation.x = Math.PI / 2;
  group.add(ceiling);

  const backWall = new THREE.Mesh(plane, wallMat);
  backWall.rotation.y = Math.PI; // 朝向房间内部
  backWall.receiveShadow = true;
  group.add(backWall);

  const leftWall = new THREE.Mesh(plane, wallMat);
  leftWall.rotation.y = -Math.PI / 2;
  leftWall.receiveShadow = true;
  group.add(leftWall);

  const rightWall = new THREE.Mesh(plane, wallMat);
  rightWall.rotation.y = Math.PI / 2;
  rightWall.receiveShadow = true;
  group.add(rightWall);

  // “窗光”：一块自发光平面，贴在后墙上（略微前移避免 z-fighting）
  const windowMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.9
  });
  const windowPane = new THREE.Mesh(plane, windowMat);
  windowPane.name = "roomWindow";
  group.add(windowPane);

  // 家具：尽量靠墙摆放，避免遮挡模型（模型一般在房间中央）
  const furniture = new THREE.Group();
  furniture.name = "roomFurniture";
  group.add(furniture);

  const woodMat = new THREE.MeshToonMaterial({ color: 0xd6a77a, gradientMap });
  woodMat.emissive = new THREE.Color(0x111827);
  woodMat.emissiveIntensity = 0.03;
  const fabricMat = new THREE.MeshToonMaterial({ color: 0xbfdbfe, gradientMap });
  fabricMat.emissive = new THREE.Color(0x0b1220);
  fabricMat.emissiveIntensity = 0.03;
  const darkMat = new THREE.MeshToonMaterial({ color: 0x334155, gradientMap });
  darkMat.emissive = new THREE.Color(0x0b1220);
  darkMat.emissiveIntensity = 0.04;

  // 地毯（纯色+轻微自发光，弱光也能看见）
  const rugMat = new THREE.MeshToonMaterial({
    color: 0xfbcfe8,
    gradientMap,
    transparent: true,
    opacity: 0.9
  });
  rugMat.emissive = new THREE.Color(0x111827);
  rugMat.emissiveIntensity = 0.02;
  const rug = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), rugMat);
  rug.rotation.x = -Math.PI / 2;
  rug.position.y = 0.01;
  rug.receiveShadow = true;
  furniture.add(rug);

  // 桌子（桌面 + 桌腿）
  const desk = new THREE.Group();
  desk.name = "desk";
  furniture.add(desk);
  const deskTop = new THREE.Mesh(unitBox, woodMat);
  deskTop.castShadow = true;
  deskTop.receiveShadow = true;
  desk.add(deskTop);
  const deskLegs = [];
  for (let i = 0; i < 4; i++) {
    const leg = new THREE.Mesh(unitBox, darkMat);
    leg.castShadow = true;
    leg.receiveShadow = true;
    deskLegs.push(leg);
    desk.add(leg);
  }

  // 椅子（座 + 靠背 + 四腿）
  const chair = new THREE.Group();
  chair.name = "chair";
  furniture.add(chair);
  const chairSeat = new THREE.Mesh(unitBox, fabricMat);
  chairSeat.castShadow = true;
  chairSeat.receiveShadow = true;
  chair.add(chairSeat);
  const chairBack = new THREE.Mesh(unitBox, fabricMat);
  chairBack.castShadow = true;
  chairBack.receiveShadow = true;
  chair.add(chairBack);
  const chairLegs = [];
  for (let i = 0; i < 4; i++) {
    const leg = new THREE.Mesh(unitBox, darkMat);
    leg.castShadow = true;
    leg.receiveShadow = true;
    chairLegs.push(leg);
    chair.add(leg);
  }

  // 床（床架 + 床垫 + 枕头 + 床头板）
  const bed = new THREE.Group();
  bed.name = "bed";
  furniture.add(bed);
  const bedBase = new THREE.Mesh(unitBox, woodMat);
  bedBase.castShadow = true;
  bedBase.receiveShadow = true;
  bed.add(bedBase);
  const mattress = new THREE.Mesh(unitBox, fabricMat);
  mattress.castShadow = true;
  mattress.receiveShadow = true;
  bed.add(mattress);
  const pillow = new THREE.Mesh(unitBox, new THREE.MeshToonMaterial({ color: 0xffffff, gradientMap }));
  pillow.castShadow = true;
  pillow.receiveShadow = true;
  bed.add(pillow);
  const headboard = new THREE.Mesh(unitBox, woodMat);
  headboard.castShadow = true;
  headboard.receiveShadow = true;
  bed.add(headboard);

  // 书架（框 + 三层隔板）
  const shelf = new THREE.Group();
  shelf.name = "shelf";
  furniture.add(shelf);
  const shelfFrame = new THREE.Mesh(unitBox, woodMat);
  shelfFrame.castShadow = true;
  shelfFrame.receiveShadow = true;
  shelf.add(shelfFrame);
  const shelfBoards = [];
  for (let i = 0; i < 3; i++) {
    const board = new THREE.Mesh(unitBox, darkMat);
    board.castShadow = true;
    board.receiveShadow = true;
    shelfBoards.push(board);
    shelf.add(board);
  }

  // 台灯（一个小点光，配合弱自发光让房间更“有生活”）
  const lamp = new THREE.Group();
  lamp.name = "lamp";
  furniture.add(lamp);
  const lampBase = new THREE.Mesh(unitBox, darkMat);
  lampBase.castShadow = true;
  lampBase.receiveShadow = true;
  lamp.add(lampBase);
  const lampShadeMat = new THREE.MeshToonMaterial({ color: 0xfffbeb, gradientMap });
  lampShadeMat.emissive = new THREE.Color(0xfff7ed);
  lampShadeMat.emissiveIntensity = 0.55;
  const lampShade = new THREE.Mesh(unitBox, lampShadeMat);
  lampShade.castShadow = false;
  lampShade.receiveShadow = false;
  lamp.add(lampShade);
  const lampLight = new THREE.PointLight(0xfff1c7, 0.65, 0, 2);
  lampLight.castShadow = false;
  lamp.add(lampLight);

  function setStyleEnabled(styleEnabled) {
    // 开启二次元时：房间更明亮；关闭时：房间变暗
    floorMat.color.set(styleEnabled ? 0xf8fafc : 0x111827);
    floorMat.opacity = styleEnabled ? 0.98 : 0.55;
    // 关闭时也保持“有墙面细节”，不要全黑
    wallMat.color.set(styleEnabled ? 0xfff1f2 : 0x334155);
    wallMat.opacity = styleEnabled ? 0.92 : 0.65;
    ceilingMat.color.set(styleEnabled ? 0xf0f9ff : 0x1f2937);
    ceilingMat.opacity = styleEnabled ? 0.92 : 0.55;
    windowPane.visible = styleEnabled;
    windowMat.opacity = styleEnabled ? 0.9 : 0.0;
    fillLight.intensity = styleEnabled ? 0.35 : 0.22;
    lampLight.intensity = styleEnabled ? 0.65 : 0.25;
  }

  function updateForModel({ center, maxDim, floorY }) {
    // room 放在模型中心下方（地板贴近 floorY）
    group.position.set(center.x, floorY, center.z);

    // 经验系数：让模型在房间里有足够留白
    const width = Math.max(maxDim * 2.6, 2.5);
    const depth = Math.max(maxDim * 3.2, 3.0);
    const height = Math.max(maxDim * 1.8, 2.2);

    // 地板/天花板：PlaneGeometry 的 (width,height) 映射到 (x,z)
    floor.scale.set(width, depth, 1);
    floor.position.set(0, 0, 0);

    ceiling.scale.set(width, depth, 1);
    ceiling.position.set(0, height, 0);

    // 后墙：PlaneGeometry 的 (width,height) 映射到 (x,y)
    backWall.scale.set(width, height, 1);
    backWall.position.set(0, height / 2, -depth / 2);

    // 左右墙：PlaneGeometry 的 (width,height) 映射到 (z,y)
    leftWall.scale.set(depth, height, 1);
    leftWall.position.set(-width / 2, height / 2, 0);

    rightWall.scale.set(depth, height, 1);
    rightWall.position.set(width / 2, height / 2, 0);

    // 窗光：贴在后墙上方
    windowPane.scale.set(width * 0.42, height * 0.26, 1);
    windowPane.rotation.y = Math.PI; // 与后墙同向
    windowPane.position.set(0, height * 0.68, -depth / 2 + 0.001);

    // 家具布局：靠后墙/两侧墙，留出房间中央给模型
    rug.scale.set(width * 0.55, depth * 0.42, 1);
    rug.position.set(0, 0.01, depth * 0.05);

    // 桌子：靠后墙偏左
    const deskW = width * 0.32;
    const deskD = depth * 0.16;
    const deskH = height * 0.26;
    desk.position.set(-width * 0.22, 0, -depth / 2 + deskD / 2 + 0.12);
    deskTop.scale.set(deskW, deskH * 0.12, deskD);
    deskTop.position.set(0, deskH * 0.92, 0);
    const legW = deskW * 0.06;
    const legH = deskH * 0.9;
    const legD = deskD * 0.06;
    const lx = deskW * 0.45;
    const lz = deskD * 0.45;
    const legPositions = [
      [-lx, legH * 0.45, -lz],
      [lx, legH * 0.45, -lz],
      [-lx, legH * 0.45, lz],
      [lx, legH * 0.45, lz]
    ];
    for (let i = 0; i < 4; i++) {
      const leg = deskLegs[i];
      leg.scale.set(legW, legH, legD);
      leg.position.set(legPositions[i][0], legPositions[i][1], legPositions[i][2]);
    }

    // 椅子：放在桌子前面一点（朝向桌子）
    const chairW = deskW * 0.32;
    const chairD = deskD * 0.62;
    const chairH = deskH * 0.78;
    chair.position.set(desk.position.x, 0, desk.position.z + deskD * 0.75);
    chair.rotation.y = Math.PI; // 面向后墙（即面向桌子）
    chairSeat.scale.set(chairW, chairH * 0.12, chairD);
    chairSeat.position.set(0, chairH * 0.42, 0);
    chairBack.scale.set(chairW, chairH * 0.45, chairD * 0.12);
    chairBack.position.set(0, chairH * 0.74, -chairD * 0.44);
    const cLegW = chairW * 0.08;
    const cLegH = chairH * 0.4;
    const cLegD = chairD * 0.08;
    const clx = chairW * 0.42;
    const clz = chairD * 0.42;
    const cLegPositions = [
      [-clx, cLegH * 0.5, -clz],
      [clx, cLegH * 0.5, -clz],
      [-clx, cLegH * 0.5, clz],
      [clx, cLegH * 0.5, clz]
    ];
    for (let i = 0; i < 4; i++) {
      const leg = chairLegs[i];
      leg.scale.set(cLegW, cLegH, cLegD);
      leg.position.set(cLegPositions[i][0], cLegPositions[i][1], cLegPositions[i][2]);
    }

    // 床：靠后墙偏右（头朝后墙）
    const bedW = width * 0.34;
    const bedD = depth * 0.28;
    const bedH = height * 0.18;
    bed.position.set(width * 0.22, 0, -depth / 2 + bedD / 2 + 0.12);
    bed.rotation.y = Math.PI; // 头朝后墙
    bedBase.scale.set(bedW, bedH * 0.5, bedD);
    bedBase.position.set(0, bedH * 0.25, 0);
    mattress.scale.set(bedW * 0.98, bedH * 0.55, bedD * 0.98);
    mattress.position.set(0, bedH * 0.78, 0);
    pillow.scale.set(bedW * 0.32, bedH * 0.22, bedD * 0.22);
    pillow.position.set(0, bedH * 1.05, -bedD * 0.34);
    headboard.scale.set(bedW, bedH * 0.9, bedD * 0.08);
    headboard.position.set(0, bedH * 0.9, -bedD * 0.5 + 0.02);

    // 书架：靠右墙中段
    const shelfW = depth * 0.18;
    const shelfD = width * 0.06;
    const shelfH = height * 0.62;
    shelf.position.set(width / 2 - shelfD / 2 - 0.08, 0, -depth * 0.05);
    shelf.rotation.y = Math.PI / 2; // 朝向房间内侧
    shelfFrame.scale.set(shelfD, shelfH, shelfW);
    shelfFrame.position.set(0, shelfH / 2, 0);
    for (let i = 0; i < 3; i++) {
      const board = shelfBoards[i];
      board.scale.set(shelfD * 0.9, shelfH * 0.04, shelfW * 0.9);
      board.position.set(0, shelfH * (0.22 + i * 0.25), 0);
    }

    // 台灯：放桌面上，稍微靠近房间中央
    const lampS = deskW * 0.12;
    lamp.position.set(desk.position.x + deskW * 0.18, 0, desk.position.z + deskD * 0.08);
    lampBase.scale.set(lampS * 0.6, deskH * 0.06, lampS * 0.6);
    lampBase.position.set(0, deskH * 0.98, 0);
    lampShade.scale.set(lampS, deskH * 0.16, lampS);
    lampShade.position.set(0, deskH * 1.1, 0);
    lampLight.position.set(0, deskH * 1.12, 0);
  }

  // 默认隐藏，由 UI 控制
  group.visible = false;
  setStyleEnabled(true);

  return { group, updateForModel, setStyleEnabled };
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
