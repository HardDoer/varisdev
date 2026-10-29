param(
    [string]$Prefix = $(if ($env:VARISDEV_INSTALL_DIR) { $env:VARISDEV_INSTALL_DIR } else { Join-Path $HOME '.local\varisdev' }),
    [string]$Feed = 'https://joonas.ninja/varisdev/latest.json',
    [switch]$NoPath
)

$ErrorActionPreference = 'Stop'
$Prefix = [IO.Path]::GetFullPath($Prefix)
$node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $node) {
    throw 'VarisDev requires Node.js 24+.'
}
& $node.Source -e "process.exit(Number.parseInt(process.versions.node,10)>=24?0:1)"
if ($LASTEXITCODE -ne 0) {
    throw 'VarisDev requires Node.js 24+.'
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    throw 'VarisDev requires npm.'
}

$loader = @'
try {
  const url = process.env.VARISDEV_INSTALLER_URL || 'https://joonas.ninja/varisdev/install.mjs';
  const response = await fetch(url, {signal: AbortSignal.timeout(30000)});
  if (!response.ok) throw new Error(`Installer download failed (${response.status}).`);
  const source = Buffer.from(await response.arrayBuffer()).toString('base64');
  const installer = await import(`data:text/javascript;base64,${source}`);
  await installer.install(process.argv.slice(1));
} catch (error) {
  console.error(`VarisDev: ${error.message}`);
  process.exitCode = 1;
}
'@
$arguments = @('--prefix', $Prefix, '--feed', $Feed)
if ($NoPath) { $arguments += '--no-path' }
& $node.Source --input-type=module -e $loader -- @arguments
if ($LASTEXITCODE -ne 0) { throw "VarisDev installation failed ($LASTEXITCODE)." }
if (-not $NoPath) {
    $env:PATH = $Prefix + [IO.Path]::PathSeparator + $env:PATH
}
