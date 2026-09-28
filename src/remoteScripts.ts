// Device-side shell snippets. They run as `sh -s` with the script on stdin, so nothing but "sh -s" shows up in
// the phone's process list (and a process scan never matches its own script).

/** Single-quotes a value for /bin/sh. */
export function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The session's runtime dir, Wayland display and session bus, which an ssh login lacks. */
const SESSION_ENV = `export XDG_RUNTIME_DIR="/run/user/$(id -u)"
[ -n "\${WAYLAND_DISPLAY:-}" ] || export WAYLAND_DISPLAY=wayland-0
if [ -z "\${DBUS_SESSION_BUS_ADDRESS:-}" ]; then
  for c in "$XDG_RUNTIME_DIR/bus" "$XDG_RUNTIME_DIR/dbus/user_bus_socket" "$XDG_RUNTIME_DIR/dbus/user_bus"; do
    if [ -S "$c" ]; then export DBUS_SESSION_BUS_ADDRESS="unix:path=$c"; break; fi
  done
fi
`;

export const osRelease = 'cat /etc/os-release 2>/dev/null; echo "ARCH=$(uname -m)"';

/** Appends a public key to authorized_keys once, with the permissions sshd insists on. */
export function authorizeKey(publicKey: string): string {
  return `set -e
umask 077
mkdir -p "$HOME/.ssh"
touch "$HOME/.ssh/authorized_keys"
chmod 700 "$HOME/.ssh"; chmod 600 "$HOME/.ssh/authorized_keys"
KEY=${shq(publicKey.trim())}
grep -qxF "$KEY" "$HOME/.ssh/authorized_keys" || printf '%s\\n' "$KEY" >> "$HOME/.ssh/authorized_keys"
echo AUTHORIZED
`;
}

/**
 * Stops every instance of the package: its launcher (or <bin> in the old non-harbour layout) and the invoker or
 * sandbox wrapper of an app-grid launch. invoker keeps apps single-instance, so a survivor would swallow the next
 * launch. The /proc scan forks nothing per process (test -ef compares inodes), so it stays fast on the phone.
 */
export function stopApp(pkg: string, bin = ''): string {
  return `PKG=${shq(pkg)}
BIN=${shq(bin)}
PAT=/tmp/.maui-sailfish-stop.$$
# Patterns go through a file so grep's own command line never matches them.
printf '%s\\n' "--id=$PKG" "/usr/bin/$PKG" > "$PAT"
pids() {
  for d in /proc/[0-9]*; do
    p=\${d#/proc/}
    [ "$p" = "$$" ] && continue
    if [ "$d/exe" -ef "/usr/bin/$PKG" ] || { [ -n "$BIN" ] && [ "$d/exe" -ef "/usr/share/$PKG/$BIN" ]; }; then echo "$p"; fi
  done
  for f in $(grep -l -a -F -f "$PAT" /proc/[0-9]*/cmdline 2>/dev/null); do
    p=\${f#/proc/}; p=\${p%/cmdline}
    [ "$p" = "$$" ] && continue
    c=" $(tr '\\0' ' ' < "$f" 2>/dev/null)"
    case "$c" in *" --id=$PKG "*|*invoker*" /usr/bin/$PKG "*|*jail*" /usr/bin/$PKG "*) echo "$p" ;; esac
  done
}
P=$(pids | sort -u)
if [ -n "$P" ]; then
  kill $P 2>/dev/null
  i=0
  while [ $i -lt 30 ] && [ -n "$(pids)" ]; do sleep 0.1; i=$((i + 1)); done
  L=$(pids | sort -u); [ -n "$L" ] && kill -9 $L 2>/dev/null
  echo "STOPPED $(echo $P | wc -w)"
fi
rm -f "$PAT"
exit 0
`;
}

export function logPath(pkg: string): string {
  return `/tmp/${pkg}.log`;
}

/**
 * Starts the app through /usr/bin/<pkg> (what the app grid runs) but outside the sandbox, so vsdbg can ptrace
 * it. Prints PID=<pid>, or LAUNCH-FAILED with the log when it dies within the first second.
 */
export function launchApp(pkg: string, env: Record<string, string>, diagnostics: boolean): string {
  const exports = Object.entries(env)
    .filter(([name]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    .map(([name, value]) => `export ${name}=${shq(value)}`)
    .join('\n');
  const log = logPath(pkg);
  return `${SESSION_ENV}${exports}
export DOTNET_EnableDiagnostics=${diagnostics ? 1 : 0}
PKG=${shq(pkg)}
[ -x "/usr/bin/$PKG" ] || { echo "LAUNCH-FAILED /usr/bin/$PKG is not installed"; exit 3; }
cd "/usr/share/$PKG" || exit 3
"/usr/bin/$PKG" > ${shq(log)} 2>&1 < /dev/null &
PID=$!
sleep 1
if kill -0 $PID 2>/dev/null; then echo "PID=$PID"; exit 0; fi
echo "LAUNCH-FAILED the app exited at once:"; tail -n 40 ${shq(log)}
exit 4
`;
}

/** Streams the app's log until the process exits. */
export function followLog(pkg: string, pid: number): string {
  const log = logPath(pkg);
  return `tail -n +1 -f ${shq(log)} &
T=$!
while kill -0 ${pid} 2>/dev/null; do sleep 1; done
sleep 1
kill $T 2>/dev/null
echo "[app exited]"
`;
}

/** Root install (rpm replaces an identical build too); harbour packages are self-contained, hence --nodeps. */
export function installAsRoot(remoteRpm: string): string {
  return `rpm -Uvh --force --nodeps ${shq(remoteRpm)} && rm -f ${shq(remoteRpm)}`;
}

/** Root-free install: PackageKit's polkit policy allows install-local for the active session. */
export function installWithPackageKit(remoteRpm: string): string {
  return `pkcon install-local -y ${shq(remoteRpm)} 2>&1; RC=$?; rm -f ${shq(remoteRpm)}; exit $RC`;
}

export const VSDBG_DIR = '/tmp/vsdbg';

/** "HAVE" when vsdbg is on the phone (a reboot wipes /tmp), then the yama ptrace scope ("none" without yama). */
export const debuggerState = `[ -x ${VSDBG_DIR}/vsdbg ] && echo HAVE || echo MISSING
cat /proc/sys/kernel/yama/ptrace_scope 2>/dev/null || echo none`;

/** Lets vsdbg attach to a process it did not start. */
export const relaxPtrace = 'echo 0 > /proc/sys/kernel/yama/ptrace_scope';
