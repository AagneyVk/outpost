import fs from 'node:fs';
import {gzipSync, gunzipSync} from 'node:zlib';

const [input, output] = process.argv.slice(2);
if (!input || !output) throw Error('Usage: node build-minimal-initrd.mjs <stock-initramfs.gz> <output.gz>');
const source = gunzipSync(fs.readFileSync(input));
const aligned = value => Math.ceil(value / 4) * 4;
const entries = new Map();
for (let offset = 0; offset + 110 <= source.length;) {
 if (source.toString('ascii', offset, offset + 6) !== '070701') throw Error('Unexpected CPIO record');
 const mode = parseInt(source.toString('ascii', offset + 14, offset + 22), 16);
 const size = parseInt(source.toString('ascii', offset + 54, offset + 62), 16);
 const nameSize = parseInt(source.toString('ascii', offset + 94, offset + 102), 16);
 const name = source.toString('utf8', offset + 110, offset + 109 + nameSize);
 if (name === 'TRAILER!!!') break;
 const start = aligned(offset + 110 + nameSize);
 entries.set(name, {mode, data: source.subarray(start, start + size)});
 offset = aligned(start + size);
}

const records = [];
const empty = Buffer.alloc(0);
function record(name, mode, data = empty, major = 0, minor = 0) {
 const filename = Buffer.from(name + '\0');
 const fields = [records.length + 1, mode, 0, 0, 1, 0, data.length, 0, 0, major, minor, filename.length, 0];
 const header = Buffer.from('070701' + fields.map(value => value.toString(16).padStart(8, '0')).join(''));
 records.push(header, filename, Buffer.alloc(aligned(header.length + filename.length) - header.length - filename.length));
 records.push(data, Buffer.alloc(aligned(data.length) - data.length));
}
for (const dir of ['bin', 'lib', 'dev', 'newroot']) record(dir, 0o40755);
record('dev/console', 0o20600, empty, 5, 1);
for (const [name, entry] of entries) {
 if (name === 'bin/busybox' || /^lib\/[^/]+$/.test(name) && name !== 'lib/modules') {
  record(name, entry.mode, entry.data);
 }
}
if (!entries.has('bin/busybox')) throw Error('BusyBox missing from stock initramfs');
const modules = ['netfs', '9pnet', '9pnet_virtio', '9p'];
for (const name of modules) {
 const matches = [...entries].filter(([filename]) => filename.endsWith('/' + name + '.ko.gz'));
 if (matches.length !== 1) throw Error('Expected one stock module for ' + name);
 record(name + '.ko', 0o100644, gunzipSync(matches[0][1].data));
}
const init = `#!/bin/busybox sh
set -e
echo '__OUTPOST_MINIMAL_INITRAMFS__'
${modules.map(name => '/bin/busybox insmod /' + name + '.ko').join('\n')}
/bin/busybox mount -t 9p -o trans=virtio,cache=loose host9p /newroot
exec /bin/busybox switch_root /newroot /sbin/outpost-init
`;
record('init', 0o100755, Buffer.from(init));
record('TRAILER!!!', 0);
const compressed = gzipSync(Buffer.concat(records));
fs.writeFileSync(output, compressed);
console.log(compressed.length + ' bytes');
