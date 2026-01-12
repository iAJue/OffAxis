import * as THREE from 'three'

/**
 * 生成一个简易「二次元房间」场景（纯程序几何，无需贴图资源）。
 *
 * 设计目标：
 * - 作为离轴透视 Demo 的背景，让画面不再是“空+网格”
 * - 风格偏“二次元”：干净的色块、柔和的灯光、少量线框描边
 * - 保持轻量：少量 Mesh，适合实时交互与头部追踪
 *
 * 坐标约定（与本项目一致）：
 * - y 轴向上
 * - z 轴向屏幕后方（屏幕平面在 z=0，模型在负 z）
 */

function createToonGradientMap() {
  // 用 1x4 的灰度梯度做 toon banding（MeshToonMaterial 的 gradientMap）
  // 这里用离散层级，让阴影更“动画感”。
  const data = new Uint8Array([
    16, 16, 16, 255,
    96, 96, 96, 255,
    170, 170, 170, 255,
    255, 255, 255, 255,
  ])
  const texture = new THREE.DataTexture(data, 4, 1, THREE.RGBAFormat)
  texture.needsUpdate = true
  texture.magFilter = THREE.NearestFilter
  texture.minFilter = THREE.NearestFilter
  texture.generateMipmaps = false
  return texture
}

function createBackgroundTexture({ width = 512, height = 512 } = {}) {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')

  const g = ctx.createLinearGradient(0, 0, 0, height)
  g.addColorStop(0, '#0b1020')
  g.addColorStop(0.55, '#0a1328')
  g.addColorStop(1, '#070b14')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, width, height)

  const glow = ctx.createRadialGradient(width * 0.75, height * 0.25, 0, width * 0.75, height * 0.25, height * 0.7)
  glow.addColorStop(0, 'rgba(138,180,255,0.18)')
  glow.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = glow
  ctx.fillRect(0, 0, width, height)

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 4
  return texture
}

function addOutline(mesh, {
  color = 0x0a1020,
  opacity = 0.35,
  thresholdAngle = 25,
} = {}) {
  // 用 EdgesGeometry 做简单描边。注意：对超大平面（地面/天花板）会很扎眼，所以建议只给家具/墙体用。
  const edges = new THREE.EdgesGeometry(mesh.geometry, thresholdAngle)
  const lines = new THREE.LineSegments(
    edges,
    new THREE.LineBasicMaterial({ color, transparent: true, opacity }),
  )
  lines.renderOrder = 1
  mesh.add(lines)
  return lines
}

function addToonHullOutline(mesh, { color = 0x0a1020, scale = 1.03, opacity = 0.85 } = {}) {
  const outline = new THREE.Mesh(
    mesh.geometry,
    new THREE.MeshBasicMaterial({ color, side: THREE.BackSide, transparent: opacity < 1, opacity }),
  )
  outline.scale.setScalar(scale)
  outline.renderOrder = -1
  mesh.add(outline)
  return outline
}

function createPosterTexture({ width = 256, height = 384 } = {}) {
  // 简单的海报贴图：条纹 + 小标题（纯 Canvas）
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')

  ctx.fillStyle = '#0f172a'
  ctx.fillRect(0, 0, width, height)

  // 渐变背景
  const g = ctx.createLinearGradient(0, 0, width, height)
  g.addColorStop(0, '#1b2a4a')
  g.addColorStop(1, '#3b82f6')
  ctx.fillStyle = g
  ctx.globalAlpha = 0.75
  ctx.fillRect(0, 0, width, height)
  ctx.globalAlpha = 1

  // 装饰条纹
  for (let i = 0; i < 9; i++) {
    ctx.fillStyle = i % 2 === 0 ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.12)'
    ctx.fillRect(0, Math.floor((height / 9) * i), width, Math.ceil(height / 18))
  }

  // 标题（尽量使用系统字体，不依赖外部资源）
  ctx.fillStyle = 'rgba(255,255,255,0.92)'
  ctx.font = 'bold 24px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto'
  ctx.fillText('阿珏酱', 18, 44)
  ctx.font = '14px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto'
  ctx.fillStyle = 'rgba(255,255,255,0.82)'
  ctx.fillText('ANIME ROOM', 18, 66)

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 4
  return texture
}

function createNeonSignTexture({ width = 512, height = 256, text = '阿珏酱' } = {}) {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')

  ctx.clearRect(0, 0, width, height)

  ctx.fillStyle = 'rgba(10,16,32,0.55)'
  ctx.strokeStyle = 'rgba(255,255,255,0.15)'
  ctx.lineWidth = 6
  ctx.beginPath()
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(10, 10, width - 20, height - 20, 24)
  } else {
    const x0 = 10
    const y0 = 10
    const w = width - 20
    const h = height - 20
    const r = 24
    ctx.moveTo(x0 + r, y0)
    ctx.arcTo(x0 + w, y0, x0 + w, y0 + h, r)
    ctx.arcTo(x0 + w, y0 + h, x0, y0 + h, r)
    ctx.arcTo(x0, y0 + h, x0, y0, r)
    ctx.arcTo(x0, y0, x0 + w, y0, r)
    ctx.closePath()
  }
  ctx.fill()
  ctx.stroke()

  const x = width / 2
  const y = height / 2 + 18
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = '900 92px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto'

  const glowColor = 'rgba(255, 105, 180, 0.92)'
  for (const blur of [40, 26, 18, 10]) {
    ctx.shadowBlur = blur
    ctx.shadowColor = glowColor
    ctx.fillStyle = 'rgba(255, 105, 180, 0.22)'
    ctx.fillText(text, x, y)
  }
  ctx.shadowBlur = 0
  ctx.fillStyle = 'rgba(255,255,255,0.92)'
  ctx.fillText(text, x, y)

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 4
  return texture
}

function createRugTexture({ width = 512, height = 512 } = {}) {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')

  ctx.fillStyle = '#111a2c'
  ctx.fillRect(0, 0, width, height)

  const cells = 10
  const cell = width / cells
  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < cells; x++) {
      const v = (x + y) % 2
      ctx.fillStyle = v ? 'rgba(138,180,255,0.10)' : 'rgba(255,105,180,0.07)'
      ctx.fillRect(x * cell, y * cell, cell, cell)
    }
  }

  ctx.strokeStyle = 'rgba(255,255,255,0.18)'
  ctx.lineWidth = 10
  ctx.strokeRect(12, 12, width - 24, height - 24)

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 4
  return texture
}

/**
 * 创建房间 Group。
 * @param {object} opts
 * @param {number} opts.baseZ 房间“前沿”大致对齐的 z（通常用模型所在 z）
 * @param {number} [opts.roomWidth=8]
 * @param {number} [opts.roomDepth=10]
 * @param {number} [opts.roomHeight=3]
 * @returns {{ group: THREE.Group, keyLight: THREE.DirectionalLight, windowLight: THREE.PointLight, backgroundTexture: THREE.Texture }}
 */
export function createAnimeRoom({
  baseZ,
  roomWidth = 8,
  roomDepth = 10,
  roomHeight = 3,
} = {}) {
  const group = new THREE.Group()
  group.name = 'AnimeRoom'

  const toonMap = createToonGradientMap()
  const backgroundTexture = createBackgroundTexture()

  // 色板（偏二次元的干净色块）
  const colors = {
    wall: 0x1b2336,
    wall2: 0x141b2a,
    floor: 0x0e1422,
    trim: 0x0a0f18,
    wood: 0x553a2a,
    cloth: 0xb91c1c,
    sheet: 0xf3f4f6,
    accent: 0x8ab4ff,
    neon: 0xff69b4,
  }

  // Toon 材质：用同一套 gradientMap 保持一致风格
  const wallMat = new THREE.MeshToonMaterial({ color: colors.wall, gradientMap: toonMap })
  const wallMat2 = new THREE.MeshToonMaterial({ color: colors.wall2, gradientMap: toonMap })
  const floorMat = new THREE.MeshToonMaterial({ color: colors.floor, gradientMap: toonMap })
  const trimMat = new THREE.MeshToonMaterial({ color: colors.trim, gradientMap: toonMap })
  const woodMat = new THREE.MeshToonMaterial({ color: colors.wood, gradientMap: toonMap })
  const clothMat = new THREE.MeshToonMaterial({ color: colors.cloth, gradientMap: toonMap })
  const sheetMat = new THREE.MeshToonMaterial({ color: colors.sheet, gradientMap: toonMap })

  // ===== 房间结构：地面/墙/天花板 =====
  // 地面：x-z 平面（y=0）
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(roomWidth, roomDepth), floorMat)
  floor.rotation.x = -Math.PI / 2
  floor.position.set(0, 0, baseZ - roomDepth / 2)
  floor.receiveShadow = true
  group.add(floor)

  // 地毯（让房间更“二次元”）
  const rugTex = createRugTexture()
  const rug = new THREE.Mesh(
    new THREE.PlaneGeometry(3.2, 2.4),
    new THREE.MeshStandardMaterial({ map: rugTex, roughness: 1, metalness: 0 }),
  )
  rug.rotation.x = -Math.PI / 2
  rug.position.set(0.2, 0.01, baseZ - roomDepth * 0.42)
  rug.receiveShadow = true
  group.add(rug)

  // 后墙：x-y 平面
  const backWall = new THREE.Mesh(new THREE.PlaneGeometry(roomWidth, roomHeight), wallMat)
  backWall.position.set(0, roomHeight / 2, baseZ - roomDepth)
  backWall.receiveShadow = true
  group.add(backWall)
  addOutline(backWall, { opacity: 0.22 })

  // 左右墙：y-z 平面（用 PlaneGeometry 旋转得到）
  const sideGeom = new THREE.PlaneGeometry(roomDepth, roomHeight)

  const leftWall = new THREE.Mesh(sideGeom, wallMat2)
  leftWall.rotation.y = Math.PI / 2
  leftWall.position.set(-roomWidth / 2, roomHeight / 2, baseZ - roomDepth / 2)
  leftWall.receiveShadow = true
  group.add(leftWall)
  addOutline(leftWall, { opacity: 0.18 })

  const rightWall = new THREE.Mesh(sideGeom, wallMat2)
  rightWall.rotation.y = -Math.PI / 2
  rightWall.position.set(roomWidth / 2, roomHeight / 2, baseZ - roomDepth / 2)
  rightWall.receiveShadow = true
  group.add(rightWall)
  addOutline(rightWall, { opacity: 0.18 })

  // 天花板：x-z 平面（y=roomHeight）
  const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(roomWidth, roomDepth), wallMat2)
  ceiling.rotation.x = Math.PI / 2
  ceiling.position.set(0, roomHeight, baseZ - roomDepth / 2)
  group.add(ceiling)

  // 踢脚线（简化）：用薄 Box 沿地面边缘走一圈
  const trimH = 0.12
  const trimT = 0.06
  const trim1 = new THREE.Mesh(new THREE.BoxGeometry(roomWidth, trimH, trimT), trimMat)
  trim1.position.set(0, trimH / 2, baseZ - trimT / 2)
  group.add(trim1)
  const trim2 = trim1.clone()
  trim2.position.set(0, trimH / 2, baseZ - roomDepth + trimT / 2)
  group.add(trim2)
  const trim3 = new THREE.Mesh(new THREE.BoxGeometry(trimT, trimH, roomDepth), trimMat)
  trim3.position.set(-roomWidth / 2 + trimT / 2, trimH / 2, baseZ - roomDepth / 2)
  group.add(trim3)
  const trim4 = trim3.clone()
  trim4.position.set(roomWidth / 2 - trimT / 2, trimH / 2, baseZ - roomDepth / 2)
  group.add(trim4)

  // ===== 简单家具：床 + 桌子 + 书架 =====
  // 床（偏左后方）
  const bedBase = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.32, 1.25), woodMat)
  bedBase.position.set(-roomWidth * 0.22, 0.16, baseZ - roomDepth * 0.68)
  bedBase.castShadow = true
  bedBase.receiveShadow = true
  group.add(bedBase)
  addToonHullOutline(bedBase, { opacity: 0.75, scale: 1.035 })

  const mattress = new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.18, 1.15), sheetMat)
  mattress.position.set(0, 0.25, 0)
  mattress.castShadow = true
  bedBase.add(mattress)
  addToonHullOutline(mattress, { opacity: 0.65, scale: 1.03 })

  const blanket = new THREE.Mesh(new THREE.BoxGeometry(2.25, 0.1, 0.7), clothMat)
  blanket.position.set(0.1, 0.3, 0.15)
  blanket.castShadow = true
  bedBase.add(blanket)
  addToonHullOutline(blanket, { opacity: 0.65, scale: 1.03 })

  // 抱枕/玩偶（增加二次元小物件）
  const plush = new THREE.Mesh(
    new THREE.SphereGeometry(0.16, 16, 12),
    new THREE.MeshToonMaterial({ color: colors.neon, gradientMap: toonMap }),
  )
  plush.position.set(-0.72, 0.42, -0.26)
  plush.castShadow = true
  bedBase.add(plush)
  addToonHullOutline(plush, { opacity: 0.6, scale: 1.06 })

  // 桌子（偏右前方）
  const deskTop = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.08, 0.8), woodMat)
  deskTop.position.set(roomWidth * 0.22, 0.72, baseZ - roomDepth * 0.28)
  deskTop.castShadow = true
  deskTop.receiveShadow = true
  group.add(deskTop)
  addToonHullOutline(deskTop, { opacity: 0.75, scale: 1.035 })

  const legGeom = new THREE.BoxGeometry(0.08, 0.72, 0.08)
  for (const sx of [-0.72, 0.72]) {
    for (const sz of [-0.32, 0.32]) {
      const leg = new THREE.Mesh(legGeom, woodMat)
      leg.position.set(sx, -0.36, sz)
      leg.castShadow = true
      deskTop.add(leg)
    }
  }

  // 简易显示器/台灯
  const monitor = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.38, 0.06), wallMat2)
  monitor.position.set(0.1, 0.28, -0.22)
  monitor.castShadow = true
  deskTop.add(monitor)
  addToonHullOutline(monitor, { opacity: 0.7, scale: 1.04 })

  const monitorGlow = new THREE.Mesh(
    new THREE.PlaneGeometry(0.56, 0.32),
    new THREE.MeshBasicMaterial({ color: colors.accent, transparent: true, opacity: 0.12 }),
  )
  monitorGlow.position.set(0.1, 0.28, -0.25)
  deskTop.add(monitorGlow)

  // 书架（靠右后墙）
  const shelf = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.6, 0.3), woodMat)
  shelf.position.set(roomWidth * 0.34, 0.8, baseZ - roomDepth * 0.78)
  shelf.castShadow = true
  shelf.receiveShadow = true
  group.add(shelf)
  addToonHullOutline(shelf, { opacity: 0.75, scale: 1.035 })

  // 书架书本（彩色块）
  const bookGeom = new THREE.BoxGeometry(0.08, 0.26, 0.18)
  const bookColors = [0x8ab4ff, 0xff69b4, 0x22c55e, 0xf59e0b, 0xa78bfa]
  for (let i = 0; i < 9; i++) {
    const mat = new THREE.MeshToonMaterial({ color: bookColors[i % bookColors.length], gradientMap: toonMap })
    const book = new THREE.Mesh(bookGeom, mat)
    book.position.set(-0.28 + i * 0.07, 0.38, 0.02)
    book.castShadow = true
    shelf.add(book)
  }

  // ===== 墙面元素：窗户发光 + 海报 =====
  // 窗户（后墙右侧）：用 emissive 的平面做“窗光”
  const windowMat = new THREE.MeshStandardMaterial({
    color: 0x101a2a,
    emissive: new THREE.Color(colors.accent),
    emissiveIntensity: 1.1,
    roughness: 0.4,
    metalness: 0.0,
  })
  const windowPlane = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 1.0), windowMat)
  windowPlane.position.set(roomWidth * 0.22, roomHeight * 0.62, baseZ - roomDepth + 0.01)
  group.add(windowPlane)
  addOutline(windowPlane, { opacity: 0.22 })

  // 窗帘（两片）
  const curtainMat = new THREE.MeshToonMaterial({ color: 0x0b2a4a, gradientMap: toonMap })
  const curtainGeom = new THREE.PlaneGeometry(0.8, 1.15)
  const curtainL = new THREE.Mesh(curtainGeom, curtainMat)
  curtainL.position.set(roomWidth * 0.22 - 0.55, roomHeight * 0.62, baseZ - roomDepth + 0.012)
  curtainL.rotation.y = 0.02
  group.add(curtainL)
  const curtainR = curtainL.clone()
  curtainR.position.x += 1.1
  curtainR.rotation.y = -0.02
  group.add(curtainR)

  // 海报（后墙左侧）
  const posterTex = createPosterTexture()
  const poster = new THREE.Mesh(
    new THREE.PlaneGeometry(0.9, 1.35),
    new THREE.MeshStandardMaterial({
      map: posterTex,
      roughness: 0.9,
      metalness: 0,
    }),
  )
  poster.position.set(-roomWidth * 0.26, roomHeight * 0.62, baseZ - roomDepth + 0.012)
  group.add(poster)
  addOutline(poster, { opacity: 0.22 })

  // 霓虹牌（更二次元的氛围点）
  const neonTex = createNeonSignTexture({ text: '阿珏酱' })
  const neon = new THREE.Mesh(
    new THREE.PlaneGeometry(1.5, 0.75),
    new THREE.MeshStandardMaterial({
      map: neonTex,
      transparent: true,
      roughness: 0.6,
      metalness: 0,
      emissive: new THREE.Color(colors.neon),
      emissiveIntensity: 0.9,
    }),
  )
  neon.position.set(0.15, roomHeight * 0.85, baseZ - roomDepth + 0.013)
  group.add(neon)

  // ===== 灯光建议（返回给调用方添加到 scene）=====
  // 主光：从右上打下来（类似动漫 key light）
  const keyLight = new THREE.DirectionalLight(0xfff1d6, 1.2)
  keyLight.position.set(2.8, 3.6, 1.8)
  keyLight.target.position.set(0, 0.9, baseZ - roomDepth * 0.55)
  keyLight.castShadow = true
  keyLight.shadow.mapSize.set(2048, 2048)
  keyLight.shadow.camera.near = 0.5
  keyLight.shadow.camera.far = 20
  keyLight.shadow.camera.left = -6
  keyLight.shadow.camera.right = 6
  keyLight.shadow.camera.top = 6
  keyLight.shadow.camera.bottom = -6

  // 窗户补光：蓝色点光，让房间更“二次元”
  const windowLight = new THREE.PointLight(0x8ab4ff, 3.0, 10, 2)
  windowLight.position.set(roomWidth * 0.22, roomHeight * 0.9, baseZ - roomDepth + 0.4)

  // 粉色氛围灯：来自霓虹牌区域
  const neonLight = new THREE.PointLight(0xff69b4, 1.6, 6, 2)
  neonLight.position.set(0.15, roomHeight * 0.95, baseZ - roomDepth + 0.65)
  group.add(neonLight)

  // 轻微雾化：增加层次（可选，调用方决定是否设置 scene.fog）
  group.userData.recommendedFog = {
    color: 0x0b0f16,
    density: 0.06,
  }

  return { group, keyLight, windowLight, backgroundTexture }
}
