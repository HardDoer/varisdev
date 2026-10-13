import {readFile, writeFile} from 'node:fs/promises';
import sharp from 'sharp';

const assets = new URL('../assets/desktop/', import.meta.url);
const source = await readFile(new URL('robot-crow.svg', assets));
const png = size => sharp(source).resize(size, size).png().toBuffer();
await writeFile(new URL('robot-crow.png', assets), await png(1024));

// Windows chooses a native size for each taskbar and display scale.
const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const images = await Promise.all(sizes.map(png));
const header = Buffer.alloc(6 + sizes.length * 16);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
for (const [index, size] of sizes.entries()) {
  const entry = 6 + index * 16;
  header[entry] = header[entry + 1] = size === 256 ? 0 : size;
  header.writeUInt16LE(1, entry + 4);
  header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(images[index].length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += images[index].length;
}
await writeFile(
  new URL('robot-crow.ico', assets),
  Buffer.concat([header, ...images]),
);

const chunks = [];
for (const [type, size] of [
  ['icp4', 16],
  ['icp5', 32],
  ['icp6', 64],
  ['ic07', 128],
  ['ic08', 256],
  ['ic09', 512],
  ['ic10', 1024],
]) {
  const image = await png(size);
  const chunk = Buffer.alloc(8);
  chunk.write(type);
  chunk.writeUInt32BE(image.length + 8, 4);
  chunks.push(chunk, image);
}
const icns = Buffer.alloc(8);
icns.write('icns');
icns.writeUInt32BE(8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0), 4);
await writeFile(
  new URL('robot-crow.icns', assets),
  Buffer.concat([icns, ...chunks]),
);
