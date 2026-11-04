export function virtualDesktop({width,height}, {launchBrowser=true} = {}){
 if(!Number.isInteger(width)||!Number.isInteger(height)||width<320||height<240||width>2560||height>1600)throw Error('Invalid display size');
 return `#!/bin/sh
set -e
mkdir -p /tmp/outpost-runtime /home/outpost/profile /home/outpost/Downloads
chmod 700 /tmp/outpost-runtime
chown -R outpost:outpost /tmp/outpost-runtime /home/outpost/profile /home/outpost/Downloads
export DISPLAY=:0 XAUTHORITY=/home/outpost/.Xauthority XDG_RUNTIME_DIR=/tmp/outpost-runtime
if ! pgrep -x Xvfb >/dev/null; then
 mkdir -p /run/dbus /var/lib/dbus
 rm -f /etc/machine-id /var/lib/dbus/machine-id
 dbus-uuidgen --ensure=/etc/machine-id
 ln -s /etc/machine-id /var/lib/dbus/machine-id
 dbus-daemon --system --fork --nopidfile
 touch "$XAUTHORITY"; chmod 600 "$XAUTHORITY"
 xauth -f "$XAUTHORITY" add :0 . "$(cat /opt/outpost/xauth)"
 rm /opt/outpost/xauth
 chown outpost:outpost "$XAUTHORITY"
 Xvfb :0 -screen 0 ${width}x${height}x24 -auth "$XAUTHORITY" -nolisten tcp -noreset -extension GLX >/var/log/outpost-display.log 2>&1 &
 i=0; until [ -S /tmp/.X11-unix/X0 ]; do sleep 1; i=$((i+1)); [ "$i" -lt 40 ] || exit 1; done
 x11vnc -storepasswd "$(cat /opt/outpost/vnc-secret)" /opt/outpost/vnc.pass >/dev/null 2>&1
 chmod 600 /opt/outpost/vnc.pass; rm /opt/outpost/vnc-secret
 x11vnc -display :0 -auth "$XAUTHORITY" -rfbauth /opt/outpost/vnc.pass -rfbport 5900 -listen 192.168.86.100 -shared -forever -defer 40 -wait 80 -nap >/var/log/outpost-vnc.log 2>&1 &
 su outpost -c 'DISPLAY=:0 XAUTHORITY=/home/outpost/.Xauthority openbox' >/var/log/outpost-wm.log 2>&1 &
fi
DISPLAY=:0 XAUTHORITY=/home/outpost/.Xauthority xset s off 2>/dev/null || true
${launchBrowser ? "su outpost -c 'DISPLAY=:0 XAUTHORITY=/home/outpost/.Xauthority XDG_RUNTIME_DIR=/tmp/outpost-runtime dbus-run-session firefox-esr --no-remote --profile /home/outpost/profile file:///home/outpost/welcome.html' >/var/log/outpost-browser.log 2>&1 &" : ''}
`;
}
export function physicalDisplay(width,height,ratio){
 ratio=Math.max(0.75,Math.min(2.5,Number.isFinite(ratio)?ratio:1));let grid=1;
 for(let i=1;i<=20;i++)if(Math.abs(ratio*i-Math.round(ratio*i))<0.0001){grid=i;break;}
 const cssWidth=Math.max(320,Math.floor(Math.min(width,2560/ratio)/grid)*grid),cssHeight=Math.max(240,Math.floor(Math.min(height,1600/ratio)/grid)*grid);
 return{width:Math.round(cssWidth*ratio),height:Math.round(cssHeight*ratio),cssWidth,cssHeight,ratio,grid};
}
