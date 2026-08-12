@echo off
chcp 936 >nul
setlocal

cd /d "%~dp0"

set "MAILER_DATA_DIR=%~dp0data"

if not exist "%MAILER_DATA_DIR%" mkdir "%MAILER_DATA_DIR%"

if not exist "%~dp0logs" mkdir "%~dp0logs"

set "ERRLOG=%~dp0logs\mailer-error.log"

if exist "%~dp0node14\node.exe" (set "NODE=%~dp0node14\node.exe") else (set "NODE=node")

echo [%DATE% %TIME%] 启动邮件后台... >> "%ERRLOG%"

start "MailService" "%NODE%" "%~dp0server.js"

rem 健康检查：循环最多等待 20 秒，每秒检查一次。
rem 老机器或首次启动时，Node 加载 Excel 配置与账号迁移可能较慢，
rem 固定等待时间容易误报；循环等待可显著降低误判。
rem 注意：中文版 Windows 的 netstat 状态列显示「侦听」而非 LISTENING，
rem 所以这里同时匹配英文 LISTENING 与中文 侦听。

set "MAX_WAIT=20"
set "WAITED=0"

:CHECK_LOOP
netstat -an | findstr ":3000" | findstr /i "LISTENING 侦听" >nul
if not errorlevel 1 goto PORT_READY
timeout /t 1 >nul
set /a WAITED+=1
if %WAITED% LSS %MAX_WAIT% goto CHECK_LOOP

rem 循环结束仍未检测到端口监听，记录报错并退出。

echo [%DATE% %TIME%] [DIAG] 服务未在 %MAX_WAIT% 秒内启动，端口 3000 无监听。 >> "%ERRLOG%"
echo [%DATE% %TIME%] [DIAG] 常见原因： >> "%ERRLOG%"
echo   一、Windows 7 缺少 node.exe 所需 API（如 GetHostNameW），请改用内置 Node 12 便携版。 >> "%ERRLOG%"
echo   二、端口 3000 被其它程序占用，可在 启动.bat 里改 PORT 后重跑。 >> "%ERRLOG%"
echo   三、配置文件 config\邮件配置.xlsx 损坏或缺失。 >> "%ERRLOG%"
echo [%DATE% %TIME%] [DIAG] 已自动打开报错日志 logs\mailer-error.log，请查看根因。 >> "%ERRLOG%"

start "" "%ERRLOG%"

echo.
echo ============================================================
echo   服务未能启动，已自动打开报错日志：
echo   %ERRLOG%
echo.
echo   常见原因：
echo   一、Windows 7 不支持当前 node.exe 版本（缺 GetHostNameW）
echo      解决：用内置 Node 12 便携版，或升级到 Windows 10。
echo   二、端口 3000 被占用（改用其它端口）。
echo   三、配置文件缺失/损坏。
echo ============================================================

pause

exit /b 1

:PORT_READY

rem 打开浏览器：优先 Chrome，其次 Edge，最后系统默认浏览器。
rem 用 where 命令在 PATH 中查找可执行文件，避免拼接 Program Files (x86)
rem 这类含括号的路径（含括号路径在 if exist 里会触发语法错误）。

set "BROWSER="

where chrome >nul 2>nul && set "BROWSER=chrome"
if not defined BROWSER (where msedge >nul 2>nul && set "BROWSER=msedge")

if defined BROWSER (
  start "" "%BROWSER%" "http://localhost:3000"
) else (
  start "" "http://localhost:3000"
)

pause

endlocal
