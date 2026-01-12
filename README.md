# OffAxis

一个小型「离轴透视投影 (Off-axis / Generalized Perspective)」Demo：

- 使用 `public/1.glb` 加载模型
- 鼠标/键盘移动“视点 eye”，实时更新非对称视锥（离轴投影）
- 可选开启摄像头头部追踪，用身体移动观察透视变化

## Recommended IDE Setup

[VS Code](https://code.visualstudio.com/) + [Vue (Official)](https://marketplace.visualstudio.com/items?itemName=Vue.volar) (and disable Vetur).

## Recommended Browser Setup

- Chromium-based browsers (Chrome, Edge, Brave, etc.):
  - [Vue.js devtools](https://chromewebstore.google.com/detail/vuejs-devtools/nhdogjmejiglipccpnnnanhbledajbpd)
  - [Turn on Custom Object Formatter in Chrome DevTools](http://bit.ly/object-formatters)
- Firefox:
  - [Vue.js devtools](https://addons.mozilla.org/en-US/firefox/addon/vue-js-devtools/)
  - [Turn on Custom Object Formatter in Firefox DevTools](https://fxdx.dev/firefox-devtools-custom-object-formatters/)

## Customize configuration

See [Vite Configuration Reference](https://vite.dev/config/).

## Project Setup

```sh
npm install
```

### Compile and Hot-Reload for Development

```sh
npm run dev
```

## Controls

- 拖拽：移动视点 `eye` 的 X/Y
- 滚轮 / `Q` / `E`：移动视点 `eye` 的 Z（靠近/远离屏幕平面）
- 方向键：微调 X/Y
- `R`：重置视点
- 右上角勾选“摄像头头部追踪”：用头部移动驱动 `eye`
- `Esc`：关闭摄像头模式

### Compile and Minify for Production

```sh
npm run build
```
