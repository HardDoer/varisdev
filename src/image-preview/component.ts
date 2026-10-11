import type {Theme} from '@earendil-works/pi-coding-agent';
import {
  getCapabilities,
  hyperlink,
  Image,
  truncateToWidth,
  type Component,
  type TuiMouseEvent,
} from '@earendil-works/pi-tui';
import {basename} from 'node:path';
import {pathToFileURL} from 'node:url';
import {processImage} from '../sharp.ts';
import {readPreviewImage} from './files.ts';
import {SIXEL_CELL, SixelFrame, type SixelOutput} from './sixel.ts';

export type PreviewRuntime = {
  output?: SixelOutput;
  sixel: boolean;
  active: boolean;
  invalidate: () => void;
};

function checkerboard(data: Uint8Array, width: number): void {
  for (let i = 0; i < data.length; i += 4) {
    const pixel = i / 4;
    const shade =
      (Math.floor((pixel % width) / 8) + Math.floor(pixel / width / 8)) % 2
        ? 175
        : 215;
    const alpha = data[i + 3] / 255;
    for (let channel = 0; channel < 3; channel++)
      data[i + channel] = Math.round(
        data[i + channel] * alpha + shade * (1 - alpha),
      );
    data[i + 3] = 255;
  }
}

export class ImagePreviewComponent implements Component {
  private key = '';
  private pending = '';
  private lines: string[] = [];
  private frame?: SixelFrame;
  private nativeImage?: Image;
  private error?: string;
  private disposed = false;
  private revision = 0;
  private loading?: AbortController;

  readonly path: string;
  private readonly theme: Theme;
  private readonly runtime: PreviewRuntime;
  private readonly maxRows: number;
  private readonly maxColumns: number;
  private readonly open?: () => void;

  constructor(
    path: string,
    theme: Theme,
    runtime: PreviewRuntime,
    maxRows = 18,
    maxColumns = 64,
    open?: () => void,
  ) {
    this.path = path;
    this.theme = theme;
    this.runtime = runtime;
    this.maxRows = maxRows;
    this.maxColumns = maxColumns;
    this.open = open;
  }

  invalidate(): void {}
  dispose(): void {
    this.disposed = true;
    this.revision++;
    this.loading?.abort();
  }

  handleMouse(event: TuiMouseEvent) {
    if (event.type === 'click' && event.button === 'left' && this.open) {
      this.open();
      return {handled: true};
    }
    return undefined;
  }

  render(width: number): string[] {
    const columns = Math.max(1, Math.min(width - 2, this.maxColumns));
    const protocol =
      getCapabilities().images ?? (this.runtime.sixel ? 'sixel' : 'blocks');
    const key = `${protocol}:${columns}`;
    if (this.key !== key && this.pending !== key && !this.disposed) {
      this.pending = key;
      const revision = ++this.revision;
      this.loading?.abort();
      this.loading = new AbortController();
      void this.load(protocol, columns, this.loading.signal)
        .then(result => {
          if (this.disposed || revision !== this.revision) return;
          this.frame = result.frame;
          this.nativeImage = result.image;
          this.lines = result.lines;
          this.error = undefined;
          this.key = key;
        })
        .catch(error => {
          if (this.disposed || revision !== this.revision) return;
          // eslint-disable-next-line no-control-regex -- Error text must not contain terminal controls.
          this.error = String(error).replace(/[\x00-\x1f]/g, ' ');
          this.key = key;
          this.frame = undefined;
          this.nativeImage = undefined;
          this.lines = [];
        })
        .finally(() => {
          if (this.disposed || revision !== this.revision) return;
          this.pending = '';
          this.loading = undefined;
          if (this.runtime.active) this.runtime.invalidate();
        });
    }
    const label = this.theme.fg('accent', basename(this.path));
    const title = getCapabilities().hyperlinks
      ? hyperlink(label, pathToFileURL(this.path).href)
      : label;
    const result = [
      truncateToWidth(
        `${title}${this.open ? this.theme.fg('muted', '  · click to enlarge · /images') : ''}`,
        width,
      ),
    ];
    if (this.key !== key)
      return [...result, this.theme.fg('muted', 'Loading image…')];
    if (this.error)
      return [
        ...result,
        truncateToWidth(this.theme.fg('error', this.error), width),
      ];
    if (this.frame && this.runtime.output)
      this.runtime.output.register(this.frame);
    return [...result, ...(this.nativeImage?.render(width) ?? this.lines)];
  }

  private async load(
    protocol: string,
    columns: number,
    signal: AbortSignal,
  ): Promise<{lines: string[]; frame?: SixelFrame; image?: Image}> {
    const input = await readPreviewImage(this.path);
    if (protocol === 'kitty' || protocol === 'iterm2') {
      const {data: png} = await processImage(
        {
          input,
          output: 'png',
          limitInputPixels: 40_000_000,
          resize: {width: 1200, height: 1200},
        },
        signal,
      );
      return {
        lines: [],
        image: new Image(
          png.toString('base64'),
          'image/png',
          {fallbackColor: text => this.theme.fg('muted', text)},
          {
            maxWidthCells: columns,
            maxHeightCells: this.maxRows,
            filename: this.path,
          },
        ),
      };
    }
    const cellWidth = protocol === 'sixel' ? SIXEL_CELL.width : 1;
    const cellHeight = protocol === 'sixel' ? SIXEL_CELL.height : 2;
    const {data, info} = await processImage(
      {
        input,
        output: 'raw',
        limitInputPixels: 40_000_000,
        resize: {
          width: columns * cellWidth,
          height: this.maxRows * cellHeight,
        },
      },
      signal,
    );
    const imageColumns = Math.ceil(info.width / cellWidth);
    const imageRows = Math.ceil(info.height / cellHeight);
    const width = imageColumns * cellWidth;
    const pixels = new Uint8Array(width * imageRows * cellHeight * 4);
    for (let row = 0; row < info.height; row++)
      pixels.set(
        data.subarray(row * info.width * 4, (row + 1) * info.width * 4),
        row * width * 4,
      );
    checkerboard(pixels, width);
    if (protocol === 'sixel') {
      const frame = new SixelFrame(pixels, imageColumns, imageRows);
      return {frame, lines: frame.lines().map(line => ` ${line}`)};
    }
    const lines = Array.from({length: imageRows}, (_, row) => {
      let line = ' ';
      for (let x = 0; x < width; x++) {
        const top = (row * 2 * width + x) * 4;
        const bottom = top + width * 4;
        line += `\x1b[38;2;${pixels[top]};${pixels[top + 1]};${pixels[top + 2]}m\x1b[48;2;${pixels[bottom]};${pixels[bottom + 1]};${pixels[bottom + 2]}m▀`;
      }
      return line + '\x1b[0m';
    });
    return {lines};
  }
}
