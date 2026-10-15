# Installation options

[Install commands](../README.md#install)

## Directory

Default: `~/.local/varisdev`. Set `VARISDEV_INSTALL_DIR` before installing to change it:

```powershell
$env:VARISDEV_INSTALL_DIR = 'D:\Apps\VarisDev'
```

```sh
export VARISDEV_INSTALL_DIR="$HOME/apps/varisdev"
```

To manage PATH yourself, pass `--no-path` to the shell script or `-NoPath` to the PowerShell script.
