# Installation options and releases

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

## Prepare release files

Run from the VarisDev checkout with dependencies installed:

```sh
npm run release:web -- ./build/varisdev
```

The output directory contains the `.tgz` package, `latest.json` with its checksum, and the installer scripts. The command accepts any output directory and retains older archives.

## Jenkins releases

The build job uses this repository's `Jenkinsfile`. The Dockerfile installs dependencies with Node.js 24, checks types, compiles the desktop sources, runs release tests, and packages the release. Jenkins pushes the resulting image as `jnokikana/joonas.ninja:varisdev-<BUILD_NUMBER>` using the frontend's existing registry credential.

The deploy job uses `Jenkinsfile-varisdev` in [joonas.ninja-deployment](https://bitbucket.org/JNokikana/joonas.ninja-deployment). Set its `RELEASE_TAG` parameter to the desired build, for example `varisdev-42`. It runs on the frontend's Docker host, pulls that image, and copies `/release/` into the existing data volume's `varisdev/` directory. It replaces files atomically, publishes `latest.json` last, then removes previous archives from the volume.

Keep the image tags in the registry: deploying an older tag restores that release directly from its image.

The frontend's `/varisdev/[file]` route reads from `data/varisdev/` at request time. Deploy that route once through the frontend's usual pipeline. Subsequent VarisDev releases are served immediately from the volume.
