# Connect.AI Windows host

Connect.AI is for attended support on Windows 10/11 x64, with an optional
unattended mode for designated company PCs (see below). The installer runs
without administrator privileges and adds a Start menu shortcut and an
uninstall entry for the current user. It is unsigned; follow your organization's
software policy. There is no Windows service. Automatic startup is added only when unattended access is turned on.
If you installed the older Connect.AI preview, uninstall it separately from Windows Settings.

## Start a session

1. Open the Connect.AI viewer in a browser at https://msfwr.vercel.app (or your
   own relay's HTTPS origin).
2. On the Windows PC, download and run the installer, then open **Connect.AI**
   from Start. The relay box is prefilled with `https://msfwr.vercel.app`.
   To use another relay, paste the HTTPS address displayed on its viewer page.
   Select **Save & Close** to remember just the address on your Windows account.
   Reopen the app to reuse it, or select **Clear saved relay** to go back to
   the default.
   A saved address does not authorize access or replace one-time pairing.
3. Select **Start session** and give the one-time code to a trusted helper. The helper enters it in their
   browser and reads the six-digit verification number back to you. Enter that
   number in the Windows host and select **Approve**, or select **Decline**
   to end the request. In this attended mode there is no automatic approval.
4. The helper can enable remote input from the viewer. The Windows user can
   stop the session with **Ctrl+2**, **F12**, or **Stop sharing** on the
   always-on-top indicator. Connect.AI never shows a taskbar button: the setup
   window is a tool window (WS_EX_TOOLWINDOW), so it only minimizes to the
   desktop, not the taskbar. Restore it from Alt+Tab, Task View (Win+Tab), or
   by launching the app again. While sharing is live the window title changes
   to mark it, and the topmost indicator stays visible. Press Alt+Space on the
   window to open the system menu with **Stop sharing** and **Close**. Closing
   the app or the indicator ends the session. The helper can use **End
   session**. Locking Windows stops the host session.

## Unattended access (designated company PCs)

For PCs that IT supports without someone at the keyboard, the Windows user
can turn on a saved, pre-approved access code:

1. Open Connect.AI, paste the relay address, and select **Unattended…**.
   Confirm the prompt. This is the only prompt; there is none during a session.
2. Connect.AI saves a random key in `%LOCALAPPDATA%\Msfwr\unattended.json`
   (not roaming) and adds itself to sign-in startup for this Windows user
   (`HKCU\...\CurrentVersion\Run`), so the same code works after restarts.
   The 12-character access code is derived from that key and shown in the
   notification-area menu. Only this PC's key can register that code on the relay.
3. IT enters the access code in the viewer. The session goes live at once,
   with no verification number and no approval.

### Initiate from the PC

The PC can also ask IT to connect. In the viewer's **Unattended PCs** tab, IT
saves the PC's access code (it stays in that browser only); a PC is also saved
automatically the first time IT connects to it with its access code.
On the PC, click the Connect.AI icon and select **Initiate — ask IT to connect**
(select it again to resend). The relay shows the request, with the PC's name,
to any viewer that saved that code, for two minutes. IT gets an Accept banner,
a chime and, if allowed, a desktop alert; **Accept** starts the session at once.
Viewers that have not saved the code see nothing.

The **Unattended PCs** tab also shows each saved PC as online, in a session or
offline, lets IT label and connect to it directly, and keeps a history of new
and previous requests (waiting, accepted, missed, dismissed) in that browser.

### The Connect.AI window

Open **Connect.AI** from Start (or left-click the notification-area icon, or pick
**Open Connect.AI** in its menu) to see the Connect.AI window while unattended access is
on. It shows:

- **Status**: ready, request sent, connected, offline or locked, with the
  latest detail, this PC's name and the relay address.
- **Access code** with **Copy access code**.
- **Controls**: **Initiate**, **Stop current session** and
  **Create remote access URL…**, plus **Turn off unattended…** and **Exit**.
- **Connections**: whether IT is connected now and for how long, the number
  of sessions since Connect.AI started, a list of recent sessions (kept in memory
  only), and the active remote access URLs with **Copy URL** and **Revoke URL**.
- **Version**, for example `Connect.AI v0.3.2 · Windows x64`.

Closing the window (or **Hide**) only hides it; unattended access keeps
running from the icon. Like every Connect.AI window it has no taskbar button and
no minimize button; reopen it from the icon or from Start. When Connect.AI starts at sign-in it stays in the
notification area and does not open the window. The relay does not report
who the viewer is, so the window shows when a session started, not a name.

### No taskbar or notification-area presence

Connect.AI shows nothing while it is idle: no taskbar button and no
notification-area (tray) icon. Unattended access runs from a hidden window.
Open the **Connect.AI** window from its Start shortcut for the status, the access
code, the connection count, **Copy access code**, **Initiate**, **Stop current
session**, **Turn off unattended access…** (deletes the key and the startup
entry), and **Exit** (unattended access starts again at next sign-in).
Starting Connect.AI again while it runs brings its existing window to the front
instead of starting a second copy.

### RA ID

Type the company's RA ID (for example `RA-123456`, from the relay's `/admin`
console) in the **RA ID** box and select **Save**. The PC then shows up for
that company when it signs in to the relay, which can connect without the
access code, and **Initiate: ask IT to connect** goes to that company. The line
under the box says which company the RA ID belongs to, or that no company has
it. Clear the box and Save to remove it.

### Remote access URL

Under **Remote access URL**, choose how long it stays valid (1 hour to 5
days, 24 hours by default) and select **Create URL**. The window shows the
URL (`https://<relay>/r/<code>`) and its six-digit access code. **Copy URL +
code** copies both. Whoever opens the URL and enters the code connects
without a prompt, and without signing in, until the URL expires or you select
**Clear**. **Create new URL** replaces the current one. Eight wrong codes lock
the URL for 15 minutes. Creating and clearing run in the background, so the
window never stops responding.

While IT is connected, the always-on-top **Live sharing** indicator appears on
the screen, so a session is never silent on the PC. Ctrl+2 and F12 end a live
session, and locking Windows stops sharing.

Anyone with the access code can control the PC while it is signed in, so
treat the code like a password. To change it, turn unattended access off and
on again. Uninstalling removes the key and the startup entry.

Shares the primary display only. No file transfer, clipboard sync, audio,
administrator elevation, or Windows sign-in/UAC control.
Exam lockdown apps (Pearson VUE, Respondus LockDown Browser, and similar) run
on a protected desktop that Windows isolates from normal programs: they block
screen-capture APIs (captured windows render black) and move keyboard/mouse
input to their own desktop. The host keeps streaming for up to 30 seconds of
such a switch (brief prompts at exam start no longer drop the session), then
ends it with "Windows switched to a locked or protected desktop". This is a
Windows security boundary, not a bug — no remote-desktop tool can see or drive
that desktop, and attempting to bypass an exam lockdown violates its terms.
The relay terminates TLS and can read screen frames and control events. Use a
relay you and your helper trust. It holds only the latest full frame, and the
changed regions sent since it (at most 4 MB), in memory and
does not record sessions. Sessions are process-local and require a single
relay instance. Restarting that instance ends all sessions.

## Build and verify

At the repo root, with Go 1.26 and NSIS available, run:

```sh
bash windows-host/build.sh
(cd windows-host && go test ./...)
node --experimental-strip-types --test artifacts/api-server/tests/msfwr.test.mjs
pnpm --filter @workspace/api-server run build && node --test artifacts/api-server/tests/e2e.test.mjs
```

`integration_test.go` runs this client's relay calls against a live relay:
`MSFWR_TEST_RELAY=https://… MSFWR_TEST_RA=123456 go test -tags integration -run Integration .`

The build writes the installer to
`artifacts/msfwr/public/downloads/msfwr-Setup-x64.exe`.

## Publishing a release

The viewer's download button links to the installer on the latest GitHub
release:
`https://github.com/mailbhrp-1/Remote-Desktop-for-Windows/releases/latest/download/msfwr-Setup-x64.exe`.
Publishing is automatic: when a change under `windows-host/` is merged to
`main`, the **Release installer** workflow runs the Go tests, builds the
installer with the same `build.sh`, and attaches it to a new release, so the
site's Download button serves it straight away. The version comes from
`windows-host/VERSION`; once that version is released, later merges bump the
patch number (0.6.0, 0.6.1, ...). Change `VERSION` to start a new line such as
0.7.0. You can still run the workflow from the Actions tab with a tag, or push
a tag such as `v0.7.0`. Keep the asset name `msfwr-Setup-x64.exe` so the link stays valid. Keep the API and viewer on the same origin,
with `/api/msfwr/` routed to the API service behind HTTPS. On Windows,
verify install/uninstall, pairing on two devices, streaming, remote input,
display scaling, Ctrl+2, F12, and locking Windows before distributing this preview.

## Trusted publisher signing

Smart App Control checks publisher trust, not the installer filename. Leave
it enabled. A self-signed certificate or an open-source signing tool by itself
does not provide a publisher that Windows trusts.

- [SignPath Foundation](https://signpath.org/) offers free signing for approved
  open-source projects. It verifies the artifact against the public repository;
  use its required build and submission process if accepted. Keep private
  repositories private unless you have explicitly decided to publish them.
- [Microsoft Artifact Signing](https://azure.microsoft.com/en-us/pricing/details/artifact-signing/)
  offers a paid Basic plan. Use a public-trust signing profile and complete
  publisher identity validation before attempting to sign a release.

For a provider that accepts individual binaries, run the build in an approved
build environment with `bash windows-host/build.sh --sign-with /absolute/path/to/signer`.
The signed build requires an NSIS version that supports `!uninstfinalize`:
check with `makensis -CMDHELP '!uninstfinalize'`, or set `MAKENSIS` to the path
of a newer compiler. The older preview compiler can still build unsigned
installers but is deliberately refused for signing.
The executable signer must accept one local file path, sign and timestamp it
in place through the authorized provider, verify the result, and return
nonzero on failure. It is called for the host, embedded uninstaller, and
installer. This hook does not enroll a publisher or provide credentials.
Keep private keys and provider credentials outside the repository.

The release is staged under `windows-host/dist/release.*`, not served by the
preview. Before distribution, use Windows SDK SignTool (`signtool verify /pa /all /v`)
on the installer, the installed host, and the installed uninstaller, check that
the expected publisher appears, then test installation and launch with Smart
App Control enabled. A signature check is not a substitute for that runtime test.
