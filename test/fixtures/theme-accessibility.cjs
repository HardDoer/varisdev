/* global process, __dirname, Buffer */
const {mkdirSync, writeFileSync} = require('node:fs');
const {join} = require('node:path');
const {setTimeout: delay} = require('node:timers/promises');
const {app, BrowserWindow, nativeImage} = require('electron');

const [directory, reportPath, screenshotDirectory] = process.argv.slice(2);
const report = {
  themes: [],
  screenshots: [],
  previewErrors: [],
  rendererErrors: [],
};
const previewImages = [];
let browser;

app.setPath('userData', join(directory, 'profile'));
app.setPath('sessionData', join(directory, 'session'));
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

function evaluate(method, argument) {
  return browser.webContents.executeJavaScript(
    `window.themeFixture[${JSON.stringify(method)}](${
      argument === undefined ? '' : JSON.stringify(argument)
    })`,
  );
}

function auditFailures(audit) {
  const failures = [];
  for (const check of audit.checks) {
    if (check.ratio + 0.0001 < check.minimum)
      failures.push(
        `${check.name}: ${check.ratio.toFixed(2)}:1 (needs ${check.minimum}:1; ${check.foreground} on ${check.background})`,
      );
  }
  for (const check of audit.equality)
    if (!check.matches)
      failures.push(
        `${check.name}: rendered ${check.actual}, expected ${check.expected}`,
      );
  for (const check of audit.presence)
    if (!check.present) failures.push(`${check.name}: missing`);

  if (!audit.hovered) failures.push('hover probe did not match :hover');
  if (
    !audit.focusState.active ||
    !audit.focusState.visible ||
    audit.focusState.style === 'none' ||
    parseFloat(audit.focusState.width) < 2
  )
    failures.push(
      `input did not render :focus-visible (${JSON.stringify(audit.focusState)})`,
    );
  if (
    new Set(audit.statuses.map(status => status.key)).size !==
    audit.statuses.length
  )
    failures.push('semantic status colors are not all distinct');
  const masks = audit.statuses.map(status => status.mask);
  if (masks.some(mask => !mask || mask === 'none'))
    failures.push('one or more semantic statuses has no visible shape icon');
  if (new Set(masks).size !== masks.length)
    failures.push('semantic status icons are not all distinct');

  for (const [effect, colors] of Object.entries(audit.effectColors)) {
    const keys = Object.values(colors).map(value =>
      value.replace(/\s+/g, '').toLowerCase(),
    );
    if (new Set(keys).size !== keys.length)
      failures.push(
        `${effect} materials collapse to repeated colors: ${JSON.stringify(colors)}`,
      );
  }
  return failures;
}

function writeContactSheet(images, path) {
  const tileWidth = 480;
  const tileHeight = 300;
  const gap = 10;
  const columns = 4;
  const rows = Math.ceil(images.length / columns);
  const width = columns * tileWidth + (columns + 1) * gap;
  const height = rows * tileHeight + (rows + 1) * gap;
  const bitmap = Buffer.alloc(width * height * 4, 255);
  for (const [index, source] of images.entries()) {
    const image = source.resize({
      width: tileWidth,
      height: tileHeight,
      quality: 'good',
    });
    const pixels = image.toBitmap({scaleFactor: 1});
    const x = gap + (index % columns) * (tileWidth + gap);
    const y = gap + Math.floor(index / columns) * (tileHeight + gap);
    for (let row = 0; row < tileHeight; row++) {
      const sourceStart = row * tileWidth * 4;
      const destinationStart = ((y + row) * width + x) * 4;
      pixels.copy(
        bitmap,
        destinationStart,
        sourceStart,
        sourceStart + tileWidth * 4,
      );
    }
  }
  const sheet = nativeImage.createFromBitmap(bitmap, {
    width,
    height,
    scaleFactor: 1,
  });
  writeFileSync(path, sheet.toPNG());
  return {width, height};
}

async function main() {
  await app.whenReady();
  mkdirSync(screenshotDirectory, {recursive: true});
  browser = new BrowserWindow({
    show: false,
    width: 1600,
    height: 1000,
    useContentSize: true,
    backgroundColor: '#000000',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  browser.webContents.on('console-message', details => {
    if (details.level === 'error') report.rendererErrors.push(details.message);
  });
  await browser.loadFile(join(__dirname, 'theme-accessibility.html'));
  const ready = await browser.webContents.executeJavaScript(
    'Boolean(window.themeFixture?.ready)',
  );
  if (!ready) throw new Error('Theme accessibility fixture did not initialize');
  const catalog = await browser.webContents.executeJavaScript(
    'window.themeFixture.catalog',
  );

  for (const theme of catalog) {
    const result = {id: theme.id, name: theme.name};
    let image;
    try {
      await evaluate('applyTheme', theme.id);
      const target = await evaluate('hoverTarget');
      browser.webContents.sendInputEvent({
        type: 'mouseMove',
        x: Math.round(target.x),
        y: Math.round(target.y),
      });
      browser.webContents.focus();
      browser.webContents.sendInputEvent({type: 'keyDown', keyCode: 'Tab'});
      browser.webContents.sendInputEvent({type: 'keyUp', keyCode: 'Tab'});
      await delay(10);
      await evaluate('focusTarget');
      await delay(20);
      try {
        image = await browser.webContents.capturePage();
        const screenshotPath = join(screenshotDirectory, `${theme.id}.png`);
        writeFileSync(screenshotPath, image.toPNG());
        previewImages.push(image);
        report.screenshots.push({
          id: theme.id,
          path: screenshotPath,
          width: image.getSize().width,
          height: image.getSize().height,
        });
      } catch (error) {
        report.previewErrors.push(
          `${theme.name}: ${error.stack || String(error)}`,
        );
      }
      const audit = await evaluate('audit', theme.id);
      result.fingerprint = JSON.stringify(audit.rootTokens);
      const failures = auditFailures(audit);
      if (failures.length)
        throw new Error(`${theme.name}\n- ${failures.join('\n- ')}`);
    } catch (error) {
      result.error = error.stack || String(error);
    }
    report.themes.push(result);
  }

  if (previewImages.length === catalog.length) {
    const contactPath = join(screenshotDirectory, 'contact-sheet.png');
    try {
      report.contactSheet = {
        path: contactPath,
        ...writeContactSheet(previewImages, contactPath),
      };
    } catch (error) {
      report.previewErrors.push(
        `Contact sheet: ${error.stack || String(error)}`,
      );
    }
  }
}

main()
  .catch(error => {
    report.fatal = error.stack || String(error);
  })
  .finally(() => {
    writeFileSync(reportPath, JSON.stringify(report));
    browser?.destroy();
    app.exit(report.fatal ? 1 : 0);
  });
