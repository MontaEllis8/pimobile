# PiMobile — 私有 → 开源 单向同步脚本
# 用法：在 10-pi 目录下跑： powershell -ExecutionPolicy Bypass -File D:\worksave\11-opensource\02-pimobile\scripts\sync-to-opensource.ps1
# 或进入 11-opensource/02-pimobile 后： .\scripts\sync-to-opensource.ps1
#
# 策略：10-pi/02-pi-android 是唯一真源，11-opensource/02-pimobile 是脱敏镜像。
# 每次在私有仓完成 feature 后，跑此脚本增量同步 server+android+docs，自动脱敏后在开源仓 git status 供你 commit。

$ErrorActionPreference = "Stop"

$PrivateRoot = "D:\worksave\10-pi\02-pi-android"
$PublicRoot  = "D:\worksave\11-opensource\02-pimobile"

if (-not (Test-Path $PrivateRoot)) { Write-Error "Private root not found: $PrivateRoot"; exit 1 }
if (-not (Test-Path $PublicRoot))  { Write-Error "Public root not found: $PublicRoot"; exit 1 }

Write-Host "=== PiMobile sync: $PrivateRoot → $PublicRoot ===" -ForegroundColor Cyan

# 1. 同步 server（排除 node_modules/.git/tmp/.pi-local/dist）
Write-Host "`n[1/4] Sync server..." -ForegroundColor Yellow
robocopy "$PrivateRoot\server" "$PublicRoot\server" /E /XD node_modules .git tmp .pi-local dist /XF *.log .env download-test.txt /NFL /NDL /NJH /NJS | Out-Null
if ($LASTEXITCODE -ge 8) { Write-Error "robocopy server failed: $LASTEXITCODE"; exit 1 }

# 2. 同步 android（pi-mobile → android，重命名）
Write-Host "[2/4] Sync android..." -ForegroundColor Yellow
robocopy "$PrivateRoot\pi-mobile" "$PublicRoot\android" /E /XD .git build .gradle .kotlin .idea captures tmp node_modules .gradle-home /XF *.log local.properties debug.keystore /NFL /NDL /NJH /NJS | Out-Null
if ($LASTEXITCODE -ge 8) { Write-Error "robocopy android failed: $LASTEXITCODE"; exit 1 }
# 清理可能带入的 .gradle-home
Remove-Item -Recurse -Force "$PublicRoot\android\.gradle-home" -ErrorAction SilentlyContinue

# 3. 同步 docs（仅 ARCHITECTURE.md，内部大文档不推）
Write-Host "[3/4] Sync docs..." -ForegroundColor Yellow
Copy-Item "$PrivateRoot\doc\ARCHITECTURE.md" "$PublicRoot\docs\ARCHITECTURE.md" -Force

# 4. 同步 start-server.bat（脱敏：泛化 IP）
Write-Host "[4/4] Sync start-server.bat (desensitized)..." -ForegroundColor Yellow
@'
@echo off
title PiMobile Server
cd /d %~dp0server
echo ========================================================
echo   PiMobile Server (Port 8787)
echo   Emulator : 10.0.2.2:8787
echo   LAN      : YOUR_LAN_IP:8787  (check with ipconfig)
echo   Tailscale: YOUR_TAILSCALE_IP:8787  (if enabled)
echo ========================================================
echo.
echo Starting server... (first run: npm install)
if not exist node_modules (
  echo Installing dependencies...
  call npm install
)
call npm start
pause
'@ | Set-Content -Path "$PublicRoot\start-server.bat" -Encoding ASCII

# 5. 脱敏检查（不应出现真实内网 IP）
Write-Host "`n[check] Scanning for leaked private IPs/paths..." -ForegroundColor Yellow
$leaks = Select-String -Path "$PublicRoot\server\src\*.ts","$PublicRoot\android\app\src\main\java\com\pimobile\app\data\*.kt" -Pattern "192\.168\.1\.104|100\.107\.90\.69|D:\\worksave" -ErrorAction SilentlyContinue
# 允许 placeholder 192.168.1.x / 192.168.1.100 示例
$realLeaks = $leaks | Where-Object { $_.Line -notmatch "192\.168\.1\.x|192\.168\.1\.100.*8000|YOUR_" }
if ($realLeaks) {
  Write-Host "⚠️  Found potential leaks:" -ForegroundColor Red
  $realLeaks | ForEach-Object { Write-Host "  $($_.Path):$($_.LineNumber): $($_.Line.Trim())" -ForegroundColor Red }
  Write-Host "请手动检查后再 commit" -ForegroundColor Red
} else {
  Write-Host "✅ No private IP/path leaks in src/" -ForegroundColor Green
}

# 6. 清理内部脚本/docs（若被带入）
Remove-Item -Recurse -Force "$PublicRoot\android\scripts" -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force "$PublicRoot\android\docs" -ErrorAction SilentlyContinue

Write-Host "`n=== Sync done. Git status in public repo: ===" -ForegroundColor Cyan
Push-Location $PublicRoot
git status --short
Write-Host "`nNext:" -ForegroundColor Cyan
Write-Host "  cd $PublicRoot"
Write-Host "  git add -A && git commit -m 'sync: <what changed>' && git push"
Pop-Location
