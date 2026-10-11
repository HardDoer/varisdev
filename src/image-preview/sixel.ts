/* eslint-disable no-control-regex -- Parse terminal control sequences. */
import {randomBytes} from 'node:crypto';
import {image2sixel} from 'sixel';
import {visibleWidth, type Terminal} from '@earendil-works/pi-tui';

const PREFIX = '\x1b_varisdev-image;';
const ST = '\x1b\\';
// Windows Terminal uses a virtual 10x20 pixel Sixel cell, independent of font size.
export const SIXEL_CELL = {width: 10, height: 20};

export class SixelFrame {
  readonly id = randomBytes(8).toString('hex');
  private readonly cache = new Map<string, string>();
  readonly pixels: Uint8Array;
  readonly columns: number;
  readonly rows: number;
  constructor(pixels: Uint8Array, columns: number, rows: number) {
    this.pixels = pixels;
    this.columns = columns;
    this.rows = rows;
  }

  lines(): string[] {
    return Array.from({length: this.rows}, (_, row) =>
      Array.from(
        {length: this.columns},
        (_, column) => `${PREFIX}${this.id};${row};${column}${ST} `,
      ).join(''),
    );
  }

  band(row: number, column: number, columns: number): string {
    const key = `${row}:${column}:${columns}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const width = columns * SIXEL_CELL.width;
    const height = SIXEL_CELL.height;
    const pixels = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
      const start =
        ((row * height + y) * this.columns + column) * SIXEL_CELL.width * 4;
      pixels.set(this.pixels.subarray(start, start + width * 4), y * width * 4);
    }
    const result = image2sixel(pixels, width, height, 256, 1);
    if (this.cache.size >= 128)
      this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, result);
    return result;
  }
}

type Placement = {
  x: number;
  y: number;
  frame: SixelFrame;
  row: number;
  column: number;
};

/**
 * Pi measures and clips ordinary cells containing zero-width APC markers.
 * At the terminal boundary we remove the markers, track their final screen
 * positions, then draw Sixel after Pi finishes clearing/scrolling the frame.
 * Raw Sixel never passes through Pi's text width or line clipping code.
 */
export class SixelOutput {
  private readonly frames = new Map<string, WeakRef<SixelFrame>>();
  private readonly original: Terminal['write'];
  private readonly writer: Terminal['write'];
  private pending = '';
  private placements: Placement[] = [];
  private x = 0;
  private y = 0;
  private saved = {x: 0, y: 0};
  private autoWrap = true;
  private knownPosition = false;
  private active = true;
  displayModeSet = true;

  private readonly terminal: Terminal;
  constructor(terminal: Terminal) {
    this.terminal = terminal;
    this.original = terminal.write;
    this.writer = data => {
      const result = this.transform(data);
      if (result) this.original.call(terminal, result);
    };
    terminal.write = this.writer;
  }

  register(frame: SixelFrame): void {
    this.frames.set(frame.id, new WeakRef(frame));
    if (this.frames.size > 128) {
      for (const [id, reference] of this.frames)
        if (!reference.deref()) this.frames.delete(id);
    }
  }

  dispose(): void {
    if (!this.active) return;
    this.active = false;
    if (this.terminal.write === this.writer)
      this.terminal.write = this.original;
    this.pending = '';
    this.placements = [];
    this.frames.clear();
  }

  private lineFeed(): void {
    if (this.y < this.terminal.rows - 1) this.y++;
    else {
      for (const placement of this.placements) placement.y--;
      this.placements = this.placements.filter(placement => placement.y >= 0);
    }
  }

  private text(text: string): void {
    for (const part of text.split(/([\r\n\b\t])/)) {
      if (part === '\r') this.x = 0;
      else if (part === '\n') this.lineFeed();
      else if (part === '\b') this.x = Math.max(0, this.x - 1);
      else if (part === '\t')
        this.x = Math.min(
          this.terminal.columns - 1,
          (Math.floor(this.x / 8) + 1) * 8,
        );
      else if (part) {
        let cells = visibleWidth(part);
        if (!this.autoWrap)
          this.x = Math.min(this.terminal.columns - 1, this.x + cells);
        else {
          while (cells > 0) {
            if (this.x >= this.terminal.columns) {
              this.x = 0;
              this.lineFeed();
            }
            const consumed = Math.min(cells, this.terminal.columns - this.x);
            this.x += consumed;
            cells -= consumed;
          }
        }
      }
    }
  }

  private csi(sequence: string): string {
    const final = sequence.at(-1);
    const params = sequence.slice(2, -1);
    const values = params.split(';').map(value => Number(value) || 1);
    const n = values[0];
    if (final === 'H' || final === 'f') {
      this.y = Math.min(this.terminal.rows - 1, n - 1);
      this.x = Math.min(this.terminal.columns - 1, (values[1] ?? 1) - 1);
      this.knownPosition = true;
    } else if (final === 'A') this.y = Math.max(0, this.y - n);
    else if (final === 'B')
      this.y = Math.min(this.terminal.rows - 1, this.y + n);
    else if (final === 'C')
      this.x = Math.min(this.terminal.columns - 1, this.x + n);
    else if (final === 'D') this.x = Math.max(0, this.x - n);
    else if (final === 'G') this.x = Math.min(this.terminal.columns - 1, n - 1);
    else if (final === 's' && !params) this.saved = {x: this.x, y: this.y};
    else if (final === 'u' && !params) ({x: this.x, y: this.y} = this.saved);
    else if (sequence === '\x1b[?7h') this.autoWrap = true;
    else if (sequence === '\x1b[?7l') this.autoWrap = false;
    else if (sequence === '\x1b[?2026h') this.placements = [];
    else if (sequence === '\x1b[?2026l') return this.flush() + sequence;
    return sequence;
  }

  private flush(): string {
    const placements = this.placements;
    this.placements = [];
    if (!this.knownPosition || !placements.length) return '';
    let output = '';
    for (let index = 0; index < placements.length; index++) {
      const first = placements[index];
      // A final Sixel band rounds up to six pixels. Leave the last screen row
      // for Pi's editor/footer so a band can never scroll the terminal itself.
      if (first.y < 0 || first.y >= this.terminal.rows - 1) continue;
      let columns = 1;
      while (index + 1 < placements.length) {
        const next = placements[index + 1];
        if (
          next.frame !== first.frame ||
          next.row !== first.row ||
          next.y !== first.y ||
          next.x !== first.x + columns ||
          next.column !== first.column + columns
        )
          break;
        index++;
        columns++;
      }
      output += `\x1b[${first.y + 1};${first.x + 1}H${first.frame.band(first.row, first.column, columns)}`;
    }
    return output
      ? `\x1b7\x1b[?80l${output}${this.displayModeSet ? '\x1b[?80h' : ''}\x1b8`
      : '';
  }

  private transform(data: string): string {
    data = this.pending + data;
    this.pending = '';
    let output = '';
    let position = 0;
    while (position < data.length) {
      if (data[position] !== '\x1b') {
        const end = data.indexOf('\x1b', position);
        const text = data.slice(position, end < 0 ? data.length : end);
        this.text(text);
        output += text;
        position += text.length;
        continue;
      }
      const rest = data.slice(position);
      if (rest.length < 2) break;
      if (rest[1] === '[') {
        const match = /^\x1b\[[0-?]*[ -/]*[@-~]/.exec(rest);
        if (!match) break;
        output += this.csi(match[0]);
        position += match[0].length;
      } else if (['_', ']', 'P'].includes(rest[1])) {
        const end = /\x07|\x1b\\/.exec(rest);
        if (!end) break;
        const length = end.index + end[0].length;
        const sequence = rest.slice(0, length);
        if (sequence.startsWith(PREFIX)) {
          if (rest.length === length) break; // next write may contain its cell
          const match =
            /^\x1b_varisdev-image;([a-f\d]+);(\d+);(\d+)\x1b\\$/.exec(sequence);
          const frame = match && this.frames.get(match[1])?.deref();
          if (
            match &&
            frame &&
            rest[length] === ' ' &&
            this.x < this.terminal.columns
          ) {
            const row = Number(match[2]);
            const column = Number(match[3]);
            if (row < frame.rows && column < frame.columns)
              this.placements.push({x: this.x, y: this.y, frame, row, column});
          }
        } else output += sequence;
        position += length;
      } else {
        if (rest[1] === '7') this.saved = {x: this.x, y: this.y};
        if (rest[1] === '8') ({x: this.x, y: this.y} = this.saved);
        output += rest.slice(0, 2);
        position += 2;
      }
    }
    this.pending = data.slice(position);
    return output;
  }
}
