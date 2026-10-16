@echo off
setlocal

"%SystemRoot%\System32\where.exe" node.exe >nul 2>&1
if errorlevel 1 (
    echo VarisDev requires Node.js 24+. >&2
    exit /b 1
)
node.exe -e "process.exit(Number.parseInt(process.versions.node,10)>=24?0:1)" >nul 2>&1
if errorlevel 1 (
    echo VarisDev requires Node.js 24+. >&2
    exit /b 1
)
call npm --version >nul 2>&1
if errorlevel 1 (
    echo VarisDev requires npm. >&2
    exit /b 1
)

node.exe --input-type=module -e "try { const url = process.env.VARISDEV_INSTALLER_URL || 'https://joonas.ninja/varisdev/install.mjs'; const response = await fetch(url, {signal: AbortSignal.timeout(30000)}); if (!response.ok) throw new Error('Installer download failed (' + response.status + ').'); const source = Buffer.from(await response.arrayBuffer()).toString('base64'); const installer = await import('data:text/javascript;base64,' + source); await installer.install(process.argv.slice(1)); } catch (error) { console.error('VarisDev: ' + error.message); process.exitCode = 1; }" -- %*
exit /b %errorlevel%
