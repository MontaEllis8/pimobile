# Pi Mobile 图标方案库与切换指南

本目录归档了基于全球顶尖设计哲学构建的 3 套 Android 原生图标资产方案：

## 1. 方案归档一览

| 编号 | 方案代号 | 方案名称 | 设计流派 / 灵感源泉 | 目录位置 |
| :--- | :--- | :--- | :--- | :--- |
| **01** | singularity | **无限奇点 (The Luminous Singularity)** | Apple Design Award / Jony Ive 灵性流体 | icon-schemes/01-singularity/ |
| **02** | perture | **心智光圈 (Neural Aperture / Spark)** | Linear / Raycast / 赛博先锋意识星火 | icon-schemes/02-aperture/ |
| **03** | liquid-glass | **液态流动晶体 (Liquid Glass / Visionary)** | VisionOS 3D 水感折射与色散彩虹边 | icon-schemes/03-liquid-glass/ |

---

## 2. 方案资产结构

每个方案子目录下均包含完整的标准 Android 生产级资产：
- master_source.jpg：1024×1024 原始母版渲染图
- preview.png：512×512 高清圆角桌面效果预览图
- 
es/drawable/ic_launcher_background.xml：专为该主题调校的黑曜石深色背景渐变层
- 
es/drawable/ic_launcher_monochrome.xml：适配 Android 13+ Material You 动态取色矢量轮廓
- 
es/mipmap-anydpi-v26/：自适应图标图层链接描述
- 
es/mipmap-[m,h,xh,xxh,xxxh]dpi/：全套无损 WebP 切片
  - ic_launcher_foreground.webp (108dp 独立发光悬浮前景层，支持桌面 Parallax 视差)
  - ic_launcher.webp (48dp 经典圆角矩形切片)
  - ic_launcher_round.webp (48dp 经典圆形切片)

---

## 3. 一键切换方式

在 pi-mobile 目录下，直接运行切换脚本：

### 查看所有可用方案
`ash
./switch-icon.bat --list
# 或者
python switch-icon.py --list
`

### 切换指定方案
`ash
# 切换到心智光圈 (Aperture)
./switch-icon.bat aperture
# 或者输入数字编号
./switch-icon.bat 2

# 切换到液态流动晶体 (Liquid Glass)
./switch-icon.bat liquid-glass
# 或者
./switch-icon.bat 3

# 切回无限奇点 (Singularity)
./switch-icon.bat singularity
# 或者
./switch-icon.bat 1
`

### 交互式菜单
不带任何参数直接运行，将弹出交互选择菜单：
`ash
./switch-icon.bat
`
