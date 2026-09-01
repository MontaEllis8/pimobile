# Pi Mobile

手机上的 Pi 终端遥控器。在手机上像用 Pi 终端一样跟 Pi 对话、查看执行结果、管理多个会话。

## 技术栈

- Kotlin + Jetpack Compose
- Material 3 设计系统
- OkHttp WebSocket 客户端
- Kotlin Coroutines + Flow
- ViewModel + StateFlow
- Compose Navigation

## 运行

**前置条件：** [Android Studio](https://developer.android.com/studio) Ladybug 2024.2+

1. 用 Android Studio 打开本目录
2. 等待 Gradle 同步完成
3. 选择模拟器或真机，点击 Run

## 连接 Pi 服务器

1. 启动 App，首次进入 Chat 页面顶部显示「未连接」横幅
2. 点击横幅或右上角齿轮进入 Settings
3. 输入 Pi 服务器地址（格式：`主机:端口`，如 `192.168.1.100:8000`）
4. 返回 Chat 页面，横幅消失即连接成功

## 项目结构

```
app/src/main/java/com/pimobile/app/
├── MainActivity.kt              # 入口 Activity
├── navigation/
│   └── AppNavigation.kt         # 底部导航（Chat / Sessions）
├── ui/
│   ├── chat/                    # Chat 页面（模型与思考抽屉、白名单斜杠补全）
│   │   ├── ChatScreen.kt
│   │   ├── ChatViewModel.kt
│   │   └── components/          # 消息气泡、工具卡片、文件卡片
│   ├── sessions/                # Sessions 页面（目录折叠、置顶、即时搜索、分支缩进）
│   │   ├── SessionsScreen.kt
│   │   └── SessionsViewModel.kt
│   ├── settings/                # Settings 页面（深浅模式、服务器地址、默认工作区）
│   │   └── SettingsScreen.kt
│   └── theme/                   # Material 3 主题系统
├── service/
│   └── PiConnectionService.kt   # 前台保活服务（Android 15 超时合规）
└── data/                        # 数据模型与仓库
    ├── Models.kt                # 消息模型与流式 Builder
    ├── PiProtocol.kt            # 协议数据类
    ├── PiMessageParser.kt       # JSON 解析
    ├── PiWebSocketClient.kt     # OkHttp WS 客户端
    ├── PiRepository.kt          # 单一 StateFlow 数据中心
    └── SettingsDataStore.kt     # Preferences DataStore 持久化
```
