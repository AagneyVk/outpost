import {seal,unseal} from './portable.js';
import {LocalVault,claimLocalWorkspace} from './vault.js';
import {preferences,chromeCSS,openboxConfig} from './desktop-guest.js';
import RFB from './vendor/novnc/core/rfb.js';
import {GuestChannel} from './guest-channel.js';
import {virtualDesktop,physicalDisplay} from './vnc-guest.js';
const $=id=>document.getElementById(id),vault=new LocalVault();
let requestedTool=new URLSearchParams(location.search).get('tool');
const openToolOnLoad=requestedTool==='files'||requestedTool==='terminal';
const toolsOnly=requestedTool!=='desktop';
let vm,rfb,display,release,working=false,runtime,manifest,started=false,dirty=false;
let serialTerminal;
let bootTimer;
function startBootTimer(){
 const start=performance.now();
 const tick=()=>{
  const seconds=Math.floor((performance.now()-start)/1000);
  const remaining=12-seconds;
  $("boot-elapsed").textContent=remaining>0?remaining+"s":"Taking a little longer";
 };
 clearInterval(bootTimer);
 tick();
 bootTimer=setInterval(tick,250);
}
window.serialText='';
function status(text){$('status').textContent=text;$('progress').textContent=text;}
function message(text){$('message').textContent=text;}
function controls(enabled){for(const id of ['files','terminal','save','export','lock'])$(id).disabled=!enabled;if(rfb)rfb.viewOnly=!enabled||!!document.querySelector('dialog[open]');}
async function openSerialTerminal(){
 if(serialTerminal){serialTerminal.focus();return;}
 const css=document.createElement('link');css.rel='stylesheet';css.href='/vendor/xterm.css';document.head.append(css);
 await new Promise((resolve,reject)=>{
  const script=document.createElement('script');script.src='/vendor/xterm.js';script.onload=resolve;script.onerror=reject;document.head.append(script);
 });
 $('screen').style.cssText='';
 $('screen').classList.add('serial-screen');
 $('screen').setAttribute('aria-label','Linux terminal');
 await document.fonts.load('20px "OUTPOST Terminal"');
 const terminal=new Terminal({cols:80,rows:24,cursorBlink:true,fontFamily:'"OUTPOST Terminal", monospace',fontSize:20,theme:{background:'#111111',foreground:'#eeeeee',cursor:'#ffffff'}});
 terminal.open($('screen'));
 const encode=new TextEncoder(),decode=new TextDecoder();
 let output='';
 vm.add_listener('serial1-output-byte',byte=>{
  const text=decode.decode(Uint8Array.of(byte),{stream:true});
  output=(output+text).slice(-256);
  terminal.write(text);
 });
 terminal.onData(data=>{if(serialTerminal===terminal){dirty=true;vm.serial_send_bytes(1,encode.encode(data));}});
 await command("stty -F /dev/ttyS1 sane rows 24 cols 80 && { setsid -c su outpost -s /bin/sh -c 'cd /home/outpost; TERM=xterm PS1=\"outpost$ \" exec /bin/sh -i' </dev/ttyS1 >/dev/ttyS1 2>&1 & }");
 await wait(()=>output.includes('outpost$ '),90000);
 serialTerminal=terminal;
 terminal.focus();
}
async function fingerprint(){
 const response=await fetch('/build.json');if(!response.ok)throw Error('Runtime manifest missing. Run npm run prepare-runtime.');
 manifest=await response.json();return manifest.fingerprint;
}
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(test,timeout=120000){const end=Date.now()+timeout;while(Date.now()<end){if(await test())return;await pause(150);}throw Error('The local runtime timed out. Diagnostics are available below.');}
async function command(text,timeout=120000){
 const marker='__CMD_'+crypto.randomUUID().replaceAll('-','')+'__';
 vm.serial0_send(text+`\nprintf '\\n${marker}%s\\n' "$?"\n`);
 let match;await wait(()=>{match=window.serialText.match(new RegExp('(?:\\r|\\n)'+marker+'(\\d+)(?:\\r|\\n)'));return match;},timeout);
 if(match[1]!=='0')throw Error('Linux could not complete the operation. Existing encrypted saves are preserved.');
}
const quote=text=>"'"+text.replaceAll("'","'\\''")+"'";
async function file(name,text){
 // Publish through a guest rename. Replacing an inode directly from the host
 // leaves Linux's cached 9p dentries pointing at the previous file.
 const temporary='/opt/outpost/incoming-'+crypto.randomUUID();
 await vm.create_file(temporary,typeof text==='string'?new TextEncoder().encode(text):text);
 await command('mv -f -- '+quote(temporary)+' '+quote(name));
}
async function fetchText(url) {
 const response = await fetch(url);
 if (!response.ok) throw Error('Could not load ' + url);
 return response.text();
}
async function fetchStartupFiles(files) {
 const targets = {
  'compatibility.ini': 'compatibility.ini',
  'startupCache.4.little': 'startupCache/startupCache.4.little',
  'scriptCache.bin': 'startupCache/scriptCache.bin',
  'scriptCache-child.bin': 'startupCache/scriptCache-child.bin'
 };
 if (!files?.['compatibility.ini'] || !files['startupCache.4.little']) return [];
 try {
  const signal = AbortSignal.timeout(45000);
  return await Promise.all(Object.entries(targets).filter(([name]) => files[name]).map(async ([name, target]) => {
   const expected = files[name];
   const response = await fetch('/firefox-startup/' + name, {signal});
   if (!response.ok) throw Error('Missing Firefox cache ' + name);
   const bytes = new Uint8Array(await response.arrayBuffer());
   const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
   const hash = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
   if (bytes.length !== expected.bytes || hash !== expected.sha256) throw Error('Invalid Firefox cache ' + name);
   return [target, bytes];
  }));
 } catch (error) {
  console.warn('Firefox will build its startup cache locally.', error);
  return [];
 }
}
async function boot(raw){
 release=await claimLocalWorkspace();$('welcome').hidden=true;$('saved-versions').hidden=true;$('desktop').hidden=false;$('loading').hidden=false;startBootTimer();status('Preparing the Linux runtime…');
 performance.mark('outpost:boot');
 // Overlap public asset downloads with Linux initialization.
 const startupFiles = fetchStartupFiles(raw || toolsOnly ? null : manifest.startupFiles);
 const bootAssets = Promise.all([fetchText('/workspace-tool.py'), toolsOnly ? null : fetchText('/welcome.html')]);
 bootAssets.catch(() => {}); // Report failures when Linux is ready to consume the assets.
 display=physicalDisplay(innerWidth,innerHeight-48,devicePixelRatio);$('screen').replaceChildren();Object.assign($('screen').style,{width:display.cssWidth+'px',height:display.cssHeight+'px',margin:'0',position:'relative',left:(Math.floor(Math.max(0,innerWidth-display.cssWidth)/(2*display.grid))*display.grid)+'px'});
 // The lean initramfs contains modules for this exact guest kernel.
 const toolsKernel=manifest.toolsKernel??(manifest.fingerprint==='467f672439b94aec3db07e835737ad9cc29f2c76cc2353188cae1531c59401b7'?'2df278c698.bin':null);
 const lean=toolsOnly&&/^[a-f\d]+\.bin$/.test(toolsKernel??'')
  &&(await fetch('/vnc32/tools-initrd.gz',{method:'HEAD'})).ok;
 const bootImage=lean?{bzimage:{url:manifest.filesystem+'/rootfs/'+toolsKernel},initrd:{url:'/vnc32/tools-initrd.gz'}}:{bzimage_initrd_from_filesystem:true};
 const netDevice=manifest.offline?undefined:{relay_url:location.origin.replace(/^http/,'wisp')+'/network/',type:'virtio'};
 vm=new V86({wasm_path:'vendor/v86.wasm',memory_size:1024*1024*1024,vga_memory_size:16*1024*1024,uart1:toolsOnly,disable_keyboard:true,disable_mouse:true,net_device:netDevice,bios:{url:'vendor/seabios.bin'},vga_bios:{url:'vendor/vgabios.bin'},filesystem:{baseurl:manifest.filesystem+'/rootfs/',basefs:manifest.filesystem+'/fs.json'},...bootImage,cmdline:'init=/sbin/outpost-init rw root=host9p rootfstype=9p rootflags=trans=virtio,cache=loose modules=virtio_pci tsc=reliable console=ttyS0,115200',autostart:false});
 window.vm=vm;
 vm.add_listener('serial0-output-byte',b=>{window.serialText+=String.fromCharCode(b);if(serialText.length>250000)window.serialText=serialText.slice(-200000);});
 const log=setInterval(()=>{$('serial').value=serialText;},500);vm.add_listener('emulator-stopped',()=>clearInterval(log));
 vm.add_listener('emulator-ready',async()=>{try{const seed=crypto.getRandomValues(new Uint8Array(32));await vm.create_file('/etc/outpost.seed',seed);seed.fill(0);vm.run();}catch(e){message(e.message);}});
 status('Booting Linux on this device…'); await wait(()=>serialText.includes('__OUTPOST_READY__')); status('Preparing workspace tools…');
 await command('chmod 666 /dev/null /dev/zero /dev/full /dev/random /dev/urandom /dev/tty /dev/ptmx; mkdir -p /dev/shm; mount -t tmpfs -o mode=1777 tmpfs /dev/shm 2>/dev/null || true');
 await command('mkdir -p /opt/outpost');
 performance.measure('outpost:linux-ready', 'outpost:boot');
 const [workspaceTool, welcomePage] = await bootAssets;
 await file('/opt/outpost/workspace.py',workspaceTool);
 if(raw){status('Restoring your files and browser profile…');await file('/opt/outpost/import.tar',raw);raw.fill(0);await command('python3 /opt/outpost/workspace.py restore /opt/outpost/import.tar && rm /opt/outpost/import.tar',240000);}
 else await command('rm -f /home/outpost/proof.html');
 if(toolsOnly){
  await command('chown -R outpost:outpost /home/outpost');
  if(!manifest.offline)await command('ip link set eth0 up; ip addr replace 192.168.86.100/24 dev eth0; ip route replace default via 192.168.86.1; printf "nameserver 192.168.86.1\\n" >/etc/resolv.conf');
  status('Opening the terminal…');
  await openSerialTerminal();
  $('loading').hidden=true;clearInterval(bootTimer);started=true;dirty=true;controls(true);status('Linux tools running on this computer');
  serialTerminal.focus();
  return;
 }
 await command('mkdir -p /home/outpost/profile/chrome /home/outpost/profile/startupCache /home/outpost/.config/openbox');
 for (const [target, bytes] of await startupFiles) {
  await file('/home/outpost/profile/' + target, bytes);
 }
 if(!toolsOnly){
  await file('/home/outpost/profile/user.js',preferences+'\nuser_pref("layout.css.devPixelsPerPx", "'+display.ratio+'");');
  await file('/home/outpost/profile/chrome/userChrome.css',chromeCSS);
  await file('/home/outpost/welcome.html',welcomePage);
 }
 await file('/home/outpost/.config/openbox/rc.xml',openboxConfig);
 const password=btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(6)))).replaceAll('+','-').replaceAll('/','_');
 await file('/opt/outpost/vnc-secret',password);await file('/opt/outpost/xauth',Array.from(crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,'0')).join(''));
 await file('/opt/outpost/desktop',virtualDesktop(display,{launchBrowser:!toolsOnly}));
 await command('chown -R outpost:outpost /home/outpost; ip link set eth0 up; busybox udhcpc -i eth0 -n -q -t 3 -s /bin/true >/tmp/network.log 2>&1; ip addr replace 192.168.86.100/24 dev eth0; ip route replace default via 192.168.86.1; printf "nameserver 192.168.86.1\\n" >/etc/resolv.conf; sh /opt/outpost/desktop',180000);
 performance.mark('outpost:firefox-launch');
 status(toolsOnly?'Opening Linux tools…':'Opening Firefox locally—first launch can take several minutes…');
 await command("i=0; until ss -ltn | grep -q ':5900'; do sleep 1; i=$((i+1)); [ $i -lt 40 ] || exit 1; done",60000);
 if(!RFB.outpostLossless){const original=RFB.messages.clientEncodings;RFB.messages.clientEncodings=(socket,encodings)=>original.call(RFB.messages,socket,encodings.filter(v=>![7,21,0x48323634].includes(v)&&!(v>=-32&&v<=-23)));RFB.outpostLossless=true;}
 let connected=false,failure;rfb=new RFB($('screen'),new GuestChannel(vm.network_adapter.connect(5900)),{credentials:{password},shared:true});window.outpostDisplay=rfb;rfb.scaleViewport=true;rfb.resizeSession=false;rfb.viewOnly=true;rfb.addEventListener('connect',()=>connected=true);rfb.addEventListener('disconnect',()=>{failure='The local display disconnected. Your encrypted saves are preserved.';if(started)message(failure);});
 await wait(()=>{if(failure)throw Error(failure);return connected;},60000);
 // The known welcome-page background can only appear after the guest browser
 // has painted that document. Hidden startup windows do not satisfy this gate.
 if(!toolsOnly){
  await wait(()=>{const canvas=$('screen').querySelector('canvas');if(!canvas||canvas.width<320)return false;const pixel=canvas.getContext('2d').getImageData(Math.min(canvas.width-1,Math.round(20*display.ratio)),Math.min(canvas.height-1,Math.round(300*display.ratio)),1,1).data;return pixel[0]===247&&pixel[1]===249&&pixel[2]===252;},570000);
  performance.measure('outpost:firefox-first-paint', 'outpost:firefox-launch');
 }
 performance.measure('outpost:workspace-ready', 'outpost:boot');
 $('loading').hidden=true;clearInterval(bootTimer);started=true;dirty=true;controls(true);status('Workspace running on this computer');
}
async function run(task){if(working)return;working=true;message('');controls(false);try{await task();}catch(e){message(e.message);if(!started){clearInterval(bootTimer);try{rfb?.disconnect();rfb=null;window.outpostDisplay=null;await vm?.stop();await vm?.destroy();}catch{}vm=null;window.vm=null;await release?.();release=null;$('desktop').hidden=true;$('welcome').hidden=false;$('saved-versions').hidden=false;status('Workspace could not start');}}finally{working=false;if(started)controls(true);}}
async function start(blob){await run(async()=>{const pass=$('passphrase').value;$('passphrase').value='';if(blob&&pass.length<16)throw Error('Enter your export passphrase, with at least 16 characters.');runtime=await fingerprint();const raw=blob?await unseal(blob,pass,runtime):null;await boot(raw);});}
$('start').onclick=()=>start();$('resume').onclick=()=>run(async()=>{const id=$('version').value||await vault.latest();if(!id)throw Error('No saved workspace on this browser. Import your export instead.');const pass=$('passphrase').value;$('passphrase').value='';runtime=await fingerprint();await boot(await unseal(await vault.get(id),pass,runtime));});
$('import').onchange=()=>{const f=$('import').files[0];if(f)start(f);$('import').value='';};
async function askPass(){vm?.keyboard_set_status(false);vm?.mouse_set_status(false);const dialog=$('password-dialog');$('save-passphrase').value='';dialog.showModal();return new Promise(resolve=>dialog.addEventListener('close',()=>{const pass=dialog.returnValue==='save'?$('save-passphrase').value:null;$('save-passphrase').value='';resolve(pass);},{once:true}));}
async function save(download){const pass=await askPass();if(pass===null)return;await run(async()=>{
 status(toolsOnly?'Pausing Linux tools before saving…':'Closing Firefox safely before saving…');await command("pkill -TERM -u 1000 -x firefox-esr 2>/dev/null || true; i=0; while pgrep -u 1000 -x firefox-esr >/dev/null; do sleep 1; i=$((i+1)); [ $i -lt 60 ] || exit 1; done; pkill -STOP -u 1000 2>/dev/null || true",90000);
 try{status('Encrypting your workspace on this computer…');await command('python3 /opt/outpost/workspace.py export /opt/outpost/workspace.tar',240000);const raw=await vm.read_file('/opt/outpost/workspace.tar');let blob;try{blob=await seal(raw,pass,runtime);}finally{raw.fill(0);await command('rm -f /opt/outpost/workspace.tar');}await vault.save(blob);if(download){const a=document.createElement('a'),url=URL.createObjectURL(blob);a.href=url;a.download='OUTPOST-'+new Date().toISOString().slice(0,10)+'.outpost';a.click();setTimeout(()=>URL.revokeObjectURL(url),60000);}dirty=false;status(download?'Encrypted workspace saved and exported':'Encrypted workspace saved on this browser');}
 finally{await command(toolsOnly?'pkill -CONT -u 1000 2>/dev/null || true':'pkill -CONT -u 1000 2>/dev/null || true; sh /opt/outpost/desktop');}
 });}
$('save').onclick=()=>save(false);$('export').onclick=()=>save(true);
$('terminal').onclick=()=>run(async()=>{
 if(toolsOnly){await openSerialTerminal();return;}
 await command("su outpost -c 'cd /home/outpost; DISPLAY=:0 XAUTHORITY=/home/outpost/.Xauthority xterm -geometry 90x28+0+0 -fa \"Liberation Mono\" -fs "+(11*(display?.ratio||1))+"' >/tmp/terminal.log 2>&1 &");
 if(toolsOnly)await command("i=0; until DISPLAY=:0 XAUTHORITY=/home/outpost/.Xauthority xwininfo -root -tree | grep -qi xterm; do sleep 1; i=$((i+1)); if [ $i -ge 20 ]; then cat /tmp/terminal.log; exit 1; fi; done",45000);
});
$('lock').onclick=async()=>{if(working)return;let choice='discard';if(dirty){if(rfb)rfb.viewOnly=true;const dialog=$('lock-dialog');dialog.showModal();choice=await new Promise(resolve=>dialog.addEventListener('close',()=>resolve(dialog.returnValue),{once:true}));}if(choice==='cancel'){controls(started);return;}if(choice==='save'){await save(false);if(dirty||$('message').textContent)return;}await run(async()=>{started=false;rfb?.disconnect();rfb=null;window.outpostDisplay=null;await vm.stop();await vm.destroy();vm=null;window.vm=null;await release();release=null;if(toolsOnly){const url=new URL(location.href);url.searchParams.set("locked","1");location.replace(url);}else location.reload();});};
$('fullscreen').onclick=()=>document.fullscreenElement?document.exitFullscreen():document.documentElement.requestFullscreen();
let folder='';
async function fileAction(action,extra={}){await file('/opt/outpost/file-request.json',JSON.stringify({action,path:folder,...extra}));await command('python3 /opt/outpost/workspace.py files /opt/outpost/file-request.json');}
async function listFiles(){await fileAction('list');const entries=JSON.parse(new TextDecoder().decode(await vm.read_file('/opt/outpost/files.json')));$('files-path').textContent=folder||'Home';$('file-list').replaceChildren();for(const item of entries){const row=document.createElement('button');row.className='file-row';row.textContent=(item.directory?'▸ ':'')+item.name+(item.directory?'':' · '+Math.ceil(item.bytes/1024)+' KB');row.onclick=()=>run(async()=>{if(item.directory){folder=[folder,item.name].filter(Boolean).join('/');await listFiles();}else{await fileAction('download',{path:[folder,item.name].filter(Boolean).join('/')});const data=await vm.read_file('/opt/outpost/download.bin');const url=URL.createObjectURL(new Blob([data]));data.fill(0);const a=document.createElement('a');a.href=url;a.download=item.name;a.click();setTimeout(()=>URL.revokeObjectURL(url),60000);await command('rm -f /opt/outpost/download.bin');}});$('file-list').append(row);}}
$('files').onclick=()=>run(async()=>{vm.keyboard_set_status(false);vm.mouse_set_status(false);await listFiles();$('files-dialog').showModal();});
$('files-close').onclick=()=>{$('files-dialog').close();controls(started&&!working);};$('files-up').onclick=()=>run(async()=>{folder=folder.split('/').slice(0,-1).join('/');await listFiles();});
$('new-folder').onclick=()=>{const name=prompt('Folder name');if(name)run(async()=>{await fileAction('mkdir',{name});dirty=true;await listFiles();});};
$('file-upload').onchange=()=>run(async()=>{const upload=$('file-upload').files[0];$('file-upload').value='';if(!upload)return;if(upload.size>64*1024*1024)throw Error('Choose a file smaller than 64 MB.');const bytes=new Uint8Array(await upload.arrayBuffer());await file('/opt/outpost/upload.bin',bytes);bytes.fill(0);try{await fileAction('upload',{name:upload.name});dirty=true;await listFiles();}finally{await command('rm -f /opt/outpost/upload.bin');}});
window.addEventListener('beforeunload',e=>{if(started&&dirty){e.preventDefault();e.returnValue='';}});
$('screen').addEventListener('pointerdown',()=>{vm?.keyboard_set_status(true);vm?.mouse_set_status(true);dirty=true;});
document.querySelector('header').addEventListener('pointerdown',()=>{vm?.keyboard_set_status(false);vm?.mouse_set_status(false);});
// A live session can change after every save; retain the exit reminder.
setInterval(()=>{if(started)dirty=true;},30000);
async function versions(){for(const item of await vault.list()){const option=document.createElement('option');option.value=item.id;option.textContent=new Date(item.createdAt).toLocaleString()+' · '+Math.ceil(item.bytes/1048576)+' MB';$('version').append(option);}}
versions().catch(e=>message(e.message));
$('forget').onclick=()=>run(async()=>{if(started)throw Error('Lock the workspace first.');if(!confirm('Remove all encrypted saves from this browser? Keep an export if you want to use them again.'))return;await vault.clear();$('version').replaceChildren(new Option('Latest save',''));message('Saved workspace data removed from this browser.');});
for(const id of ['passphrase','start','resume','import'])$(id).disabled=false;
if(toolsOnly){
 window.addEventListener('message',event=>{
  const tool=event.data?.outpostTool;
  if(event.origin!==location.origin||event.source!==window.opener||!['terminal','files'].includes(tool))return;
  requestedTool=tool;
  if(!started)return;
  if(tool==='terminal'&&$('files-dialog').open)$('files-close').click();
  if(tool!=='files'||!$('files-dialog').open)$(tool).click();
 });
 if(openToolOnLoad&&!new URLSearchParams(location.search).has('locked')){
  await start();
  if(started)$(requestedTool).click();
 }
}
