# MAUI Sailfish Tools

Deploy and debug .NET MAUI apps on a Sailfish OS phone from VS Code, the way the .NET MAUI extension does it for
Android and iOS. Everything runs inside the extension over SSH. You don't need `tools/sf-*.sh`, `expect` or
`ssh-copy-id` on the build machine.

## Requirements

- The C# extension (`ms-dotnettools.csharp`), which provides the `coreclr` debugger.
- The phone in Developer mode, with Settings > Developer tools > Remote connection on and a password set.
- A `net11.0-sailfish` project (`dotnet new maui-sailfish`, or see `docs/add-sailfish-to-existing-app.md`).
- For debugging, a linux-arm64 vsdbg in `~/.vsdbg-linux-arm64`. The extension offers to download it the first
  time.

## Device

The **MAUI Sailfish** icon in the activity bar opens the **Devices** view. It lists every known phone and the SSH
key in use:

- Devices are shared by all your workspaces. The *active* one is remembered per workspace, so two projects can
  target two phones.
- Each device expands to show:
  - its OS and architecture;
  - the login method (SSH key, or password only);
  - whether a password is stored and whether the host key is pinned;
  - whether vsdbg is on the phone, and the ptrace state.
- Click a device to make it active. The inline icon checks it again. The context menu holds Pair SSH Key, Set
  Password, Push Debugger, Stop App and Forget.
- The **SSH key** row shows the key file and its fingerprint. Copy Public Key puts the `authorized_keys` line on
  the clipboard.

The status bar item (`$(device-mobile) <phone>`) shows the active device and opens a quick picker. From there you
can:

- **Add Device…**: enter the address, the user (`defaultuser`) and the developer-mode password. The extension
  checks that the phone runs Sailfish OS and pairs an SSH key, so later sessions log in without a password.
  - It uses `~/.ssh/id_ed25519` if you have one. Otherwise it creates `~/.config/maui-sailfish/id_ed25519` and never
    overwrites an existing key.
  - The password goes to the system keychain (VS Code SecretStorage). Installs use it for `devel-su`. Without a
    password, installs go through PackageKit.
  - The phone's host key is pinned on the first connection, after you confirm its fingerprint. If the key
    changes later, the extension stops and asks before trusting the new one.
- **Check Connection**: shows the OS version, the login method (key or password), whether a password is stored,
  and the vsdbg and ptrace state.
- **Pair SSH Key**, **Set Developer-Mode Password…**, **Push Debugger to Device** and **Forget Device…**.

An existing `connect.info` from the shell tooling is offered for import on first start.

## F5 / Ctrl+F5

```jsonc
// .vscode/launch.json
{
  "name": "MAUI Sailfish: Debug on device",
  "type": "sailfish",
  "request": "launch"
  // "project": "${workspaceFolder}/MyApp.csproj",   default: the workspace's net11.0-sailfish project
  // "configuration": "Release",                      pins it; default: the status bar's Debug | Release switch
  // "justMyCode": true,                              default true for Debug, false for Release (optimized code)
  // "env": { "MY_FLAG": "1" }                        environment of the app on the phone
}
```

Without a launch.json, the Run and Debug list offers "MAUI Sailfish: <project>" for every net11.0-sailfish project.
The **Debug | Release** switch in the status bar, next to the device, picks the build, like Visual Studio's
configuration dropdown. Debug installs as `<package>-debug` next to the Release `<package>`. Release attaches
without Just My Code, because vsdbg counts its trimmed ReadyToRun code as not yours.

**F5** runs these steps:

1. `dotnet publish` builds the harbour RPM in a task, so build errors appear in Problems.
2. The extension stops the running app, uploads the RPM, checks its sha256 and installs it.
3. It copies vsdbg to `/tmp/vsdbg` if it is missing (a reboot clears it) and relaxes `ptrace_scope` if needed.
4. It starts the app with the .NET diagnostics port open.
5. It hands over to a `coreclr` attach. The debugger's DAP stream runs through `dist/pipe.js` over the same SSH
   key. The pipe drops the SHA384/SHA512 breakpoint checksums, which vsdbg rejects.

The app's stdout and stderr go to the Debug Console. Stopping the debugger stops the app.

**Ctrl+F5** does the same without the debugger. The app log still appears in the Debug Console, and the Stop
button stops the app.

## Development

```bash
npm install
npm run build        # dist/extension.js + dist/pipe.js
npm test             # unit tests (DAP filter, connect.info)
npm run package      # .vsix
```

In the repository, the launch configuration "Extension: MAUI Sailfish Tools (on SailfishKitchen)" opens a second
window with the extension loaded from source.

## Trademarks

"Sailfish" and "Jolla" are trademarks of Jollyboys Ltd. The Sailfish EULA forbids copying their name, trademark or
logo without prior written consent, so this extension uses its own icon, not the Sailfish OS logo. The name only
says which OS the tools are for. Ask Jolla (partners@jolla.com) before publishing to the Marketplace under a name
or icon closer to theirs.
