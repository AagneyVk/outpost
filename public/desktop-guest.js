export const desktopScript=`#!/bin/sh
set -e
mkdir -p /tmp/outpost-runtime /home/outpost/profile /home/outpost/Downloads
chown -R outpost:outpost /tmp/outpost-runtime /home/outpost/profile /home/outpost/Downloads
chmod 700 /tmp/outpost-runtime
if [ -f /usr/share/dbus-1/system.conf ] && [ ! -S /run/dbus/system_bus_socket ]; then
 mkdir -p /run/dbus /var/lib/dbus
 rm -f /etc/machine-id /var/lib/dbus/machine-id
 dbus-uuidgen --ensure=/etc/machine-id
 ln -s /etc/machine-id /var/lib/dbus/machine-id
 dbus-daemon --system --fork --nopidfile
fi
export DISPLAY=:0 XAUTHORITY=/home/outpost/.Xauthority XDG_RUNTIME_DIR=/tmp/outpost-runtime
if ! pgrep -x Xorg >/dev/null; then
 touch "$XAUTHORITY"; chmod 600 "$XAUTHORITY"
 xauth -f "$XAUTHORITY" add :0 . "$(od -An -N16 -tx1 /dev/urandom | tr -d ' \\n')"
 chown outpost:outpost "$XAUTHORITY"
 Xorg :0 -auth "$XAUTHORITY" -nolisten tcp -noreset -s 0 -dpms >/var/log/outpost-xorg.log 2>&1 &
 i=0; until [ -S /tmp/.X11-unix/X0 ]; do sleep 1; i=$((i+1)); [ "$i" -lt 40 ] || exit 1; done
 su outpost -c 'DISPLAY=:0 XAUTHORITY=/home/outpost/.Xauthority openbox' >/var/log/outpost-wm.log 2>&1 &
fi
DISPLAY=:0 XAUTHORITY=/home/outpost/.Xauthority xset s off 2>/dev/null || true
DISPLAY=:0 XAUTHORITY=/home/outpost/.Xauthority xset -dpms 2>/dev/null || true
su outpost -c 'DISPLAY=:0 XAUTHORITY=/home/outpost/.Xauthority XDG_RUNTIME_DIR=/tmp/outpost-runtime dbus-run-session firefox-esr --no-remote --profile /home/outpost/profile file:///home/outpost/welcome.html' >/var/log/outpost-browser.log 2>&1 &
`;
export const preferences=`user_pref("browser.tabs.drawInTitlebar", true);
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("browser.startup.homepage", "file:///home/outpost/welcome.html");
user_pref("browser.startup.page", 3);
user_pref("browser.sessionstore.resume_from_crash", true);
user_pref("browser.aboutwelcome.enabled", false);
user_pref("browser.startup.homepage_override.mstone", "ignore");
user_pref("datareporting.policy.dataSubmissionEnabled", false);
user_pref("toolkit.telemetry.enabled", false);
user_pref("toolkit.legacyUserProfileCustomizations.stylesheets", true);
user_pref("browser.theme.content-theme", 1);
user_pref("browser.theme.toolbar-theme", 1);
user_pref("browser.uidensity", 0);
user_pref("font.name.sans-serif.x-western", "Liberation Sans");
user_pref("layers.acceleration.disabled", true);
user_pref("gfx.webrender.software", true);
user_pref("network.proxy.type", 0);
user_pref("network.trr.mode", 5);
user_pref("network.http.http3.enabled", false);
user_pref("browser.newtabpage.activity-stream.feeds.system.topsites", false);
user_pref("browser.newtabpage.activity-stream.feeds.telemetry", false);
user_pref("browser.newtabpage.activity-stream.telemetry", false);
user_pref("browser.discovery.enabled", false);
user_pref("browser.urlbar.quicksuggest.enabled", false);
user_pref("browser.search.suggest.enabled", false);
`;
export const chromeCSS=`:root{--toolbar-bgcolor:#f7f8fa!important;--toolbar-color:#202124!important;--lwt-accent-color:#dee1e6!important;--tab-border-radius:5px!important;font-family:"Liberation Sans",sans-serif!important}#navigator-toolbox{border-bottom:1px solid #dadce0!important}#TabsToolbar{background:#dee1e6!important}.tab-background[selected]{box-shadow:none!important;background:white!important}#nav-bar{box-shadow:none!important}#urlbar-background{border:1px solid #dadce0!important;box-shadow:none!important}#urlbar{font-size:13px!important}`;
export const openboxConfig=`<?xml version="1.0"?><openbox_config xmlns="http://openbox.org/3.4/rc"><theme><name>Clearlooks</name><titleLayout>NLIMC</titleLayout></theme><applications><application class="Firefox-esr"><decor>no</decor><maximized>yes</maximized></application><application class="firefox-esr"><decor>no</decor><maximized>yes</maximized></application></applications><keyboard><keybind key="A-F4"><action name="Close"/></keybind><keybind key="A-Tab"><action name="NextWindow"/></keybind></keyboard><mouse><context name="Client"><mousebind button="Left" action="Press"><action name="Focus"/><action name="Raise"/></mousebind></context></mouse></openbox_config>`;
