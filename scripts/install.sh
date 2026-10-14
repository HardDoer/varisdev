#!/bin/sh
set -eu

if ! command -v node >/dev/null 2>&1; then
  echo 'VarisDev requires Node.js 24+.' >&2
  exit 1
fi
if ! node -e 'process.exit(Number.parseInt(process.versions.node,10)>=24?0:1)' 2>/dev/null; then
  echo 'VarisDev requires Node.js 24+.' >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo 'VarisDev requires npm.' >&2
  exit 1
fi

node --input-type=module -e '
  try {
    const url = process.env.VARISDEV_INSTALLER_URL || "https://joonas.ninja/varisdev/install.mjs";
    const response = await fetch(url, {signal: AbortSignal.timeout(30000)});
    if (!response.ok) throw new Error(`Installer download failed (${response.status}).`);
    const source = Buffer.from(await response.arrayBuffer()).toString("base64");
    const installer = await import(`data:text/javascript;base64,${source}`);
    await installer.install(process.argv.slice(1));
  } catch (error) {
    console.error(`VarisDev: ${error.message}`);
    process.exitCode = 1;
  }
' -- "$@"
