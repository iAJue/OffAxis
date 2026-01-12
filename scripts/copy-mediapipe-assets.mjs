import { cp, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

const repoRoot = process.cwd()

const sourceDir = path.join(repoRoot, 'node_modules', '@mediapipe', 'tasks-vision')
const sourceWasmDir = path.join(sourceDir, 'wasm')

const targetDir = path.join(repoRoot, 'public', 'vendor', 'mediapipe')
const targetWasmDir = path.join(targetDir, 'wasm')
const targetModelsDir = path.join(targetDir, 'models')
const targetFaceModelPath = path.join(targetModelsDir, 'face_landmarker.task')

const defaultFaceModelUrl =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task'

async function exists(dir) {
  try {
    const s = await stat(dir)
    return s.isDirectory()
  } catch {
    return false
  }
}

async function fileExists(filePath) {
  try {
    const s = await stat(filePath)
    return s.isFile()
  } catch {
    return false
  }
}

function parseArgs(argv) {
  const args = new Set(argv.slice(2))
  return {
    downloadModel: args.has('--download-model'),
  }
}

async function downloadToFile(url, filePath) {
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`Download failed: ${res.status} ${res.statusText}`)
  }
  const buf = Buffer.from(await res.arrayBuffer())
  await writeFile(filePath, buf)
  return buf.length
}

async function main() {
  const { downloadModel } = parseArgs(process.argv)

  if (!(await exists(sourceDir))) {
    throw new Error('Missing dependency: node_modules/@mediapipe/tasks-vision. Run `npm install` first.')
  }

  await mkdir(targetDir, { recursive: true })
  await mkdir(targetModelsDir, { recursive: true })
  await rm(targetWasmDir, { recursive: true, force: true })
  await cp(sourceWasmDir, targetWasmDir, { recursive: true })

  console.log(`[mediapipe] Copied wasm -> ${path.relative(repoRoot, targetWasmDir)}`)

  if (downloadModel) {
    if (await fileExists(targetFaceModelPath)) {
      console.log(`[mediapipe] Model already exists -> ${path.relative(repoRoot, targetFaceModelPath)}`)
    } else {
      console.log('[mediapipe] Downloading face_landmarker.task ...')
      const bytes = await downloadToFile(defaultFaceModelUrl, targetFaceModelPath)
      console.log(
        `[mediapipe] Downloaded model (${Math.round(bytes / 1024)} KiB) -> ${path.relative(
          repoRoot,
          targetFaceModelPath,
        )}`,
      )
    }
  } else if (!(await fileExists(targetFaceModelPath))) {
    console.log(
      '[mediapipe] Model file is NOT bundled; put it at `public/vendor/mediapipe/models/face_landmarker.task`.',
    )
    console.log('[mediapipe] Or auto-download it with: `npm run setup:mediapipe -- --download-model`')
  }
}

await main()
