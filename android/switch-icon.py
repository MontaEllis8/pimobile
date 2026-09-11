#!/usr/bin/env python3
"""
Pi Mobile 图标主题切换工具
一键在三大顶尖设计图标方案之间切换：
1. 无限奇点 (Singularity) - 旗舰莫比乌斯能量流体环
2. 心智光圈 (Aperture) - 赛博先锋意识星火光圈
3. 液态流动晶体 (Liquid Glass) - 极简高透水感 Pi 雕塑
"""

import os
import sys
import shutil
import subprocess
if sys.platform == 'win32':
    try:
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    except Exception:
        pass

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
SCHEMES_DIR = os.path.join(SCRIPT_DIR, 'icon-schemes')
APP_RES_DIR = os.path.join(SCRIPT_DIR, 'app', 'src', 'main', 'res')

SCHEMES = {
    '1': {
        'id': '01-singularity',
        'alias': ['singularity', 'infinite', '1', '奇点', '无限奇点'],
        'name': '无限奇点 (The Luminous Singularity)',
        'desc': '旗舰方案：融合 π 骨架与莫比乌斯流体环，蓝紫霓虹光晕，Apple Design Award 风格'
    },
    '2': {
        'id': '02-aperture',
        'alias': ['aperture', 'spark', '2', '光圈', '心智光圈'],
        'name': '心智光圈 (Neural Aperture / Spark)',
        'desc': '赛博先锋：意识之眼旋转引力光圈，中心璀璨星火，Linear / Raycast 风格'
    },
    '3': {
        'id': '03-liquid-glass',
        'alias': ['liquid', 'liquid-glass', 'glass', '3', '晶体', '液态流动晶体'],
        'name': '液态流动晶体 (Liquid Glass / Visionary)',
        'desc': '前沿质感：清透物理折射与色散彩虹边流体雕塑，VisionOS 纯净通透美学'
    }
}

def list_schemes():
    print("=" * 65)
    print(" Pi Mobile 图标方案列表")
    print("=" * 65)
    for key, info in SCHEMES.items():
        print(f" [{key}] {info['name']}")
        print(f"     简介: {info['desc']}")
        print(f"     目录: icon-schemes/{info['id']}/")
        print()

def apply_scheme(scheme_key, auto_build=False, auto_install=False):
    target = None
    key_lower = scheme_key.lower().strip()
    for k, info in SCHEMES.items():
        if key_lower in [a.lower() for a in info['alias']]:
            target = info
            break

    if not target:
        print(f"❌ 错误: 未知方案 '{scheme_key}'")
        list_schemes()
        sys.exit(1)

    src_res = os.path.join(SCHEMES_DIR, target['id'], 'res')
    if not os.path.isdir(src_res):
        print(f"❌ 错误: 方案资源目录不存在: {src_res}")
        sys.exit(1)

    print(f"\n🔄 正在应用图标方案: {target['name']} ...")

    # 1. 复制所有资源
    count = 0
    for root, dirs, files in os.walk(src_res):
        rel_path = os.path.relpath(root, src_res)
        dest_dir = os.path.join(APP_RES_DIR, rel_path)
        os.makedirs(dest_dir, exist_ok=True)
        for f in files:
            src_file = os.path.join(root, f)
            dest_file = os.path.join(dest_dir, f)
            shutil.copy2(src_file, dest_file)
            count += 1

    # 2. 清理可能残留的历史冲突文件
    old_fg = os.path.join(APP_RES_DIR, 'drawable', 'ic_launcher_foreground.xml')
    if os.path.isfile(old_fg):
        os.remove(old_fg)

    print(f"✅ 图标资源替换完成！共同步 {count} 个文件到 app/src/main/res/")
    print(f"   当前生效: {target['name']}")

    # 3. 自动编译
    if auto_build:
        print("\n🔨 正在重新编译 Debug APK ...")
        gradlew = os.path.join(SCRIPT_DIR, 'gradlew.bat' if os.name == 'nt' else 'gradlew')
        res = subprocess.run([gradlew, 'assembleDebug'], cwd=SCRIPT_DIR)
        if res.returncode == 0:
            print("\n🎉 APK 编译成功！")
            apk_path = os.path.join(SCRIPT_DIR, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk')
            print(f"   路径: {apk_path}")
            
            # 4. 自动安装
            if auto_install:
                adb = os.path.expandvars(r'%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe')
                if os.path.isfile(adb):
                    print("\n📲 正在通过 ADB 推送到已连接设备...")
                    subprocess.run([adb, 'install', '-r', apk_path])
        else:
            print("\n❌ 编译失败，请检查报错日志。")

def main():
    args = sys.argv[1:]
    if '--list' in args or '-l' in args:
        list_schemes()
        return

    auto_build = '--build' in args or '-b' in args
    auto_install = '--install' in args or '-i' in args
    pos_args = [a for a in args if not a.startswith('-')]

    if pos_args:
        apply_scheme(pos_args[0], auto_build=auto_build, auto_install=auto_install)
    else:
        list_schemes()
        print("请输入想要应用的方案编号 [1/2/3] (直接回车退出): ", end='', flush=True)
        choice = input().strip()
        if choice:
            apply_scheme(choice)

if __name__ == '__main__':
    main()
