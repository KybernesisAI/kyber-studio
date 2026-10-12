; KYB-627 — the Microsoft VC++ x64 runtime that dictation's native binding needs.
;
; The shipped onnxruntime.dll and onnxruntime_binding.node are linked with MSVC
; toolset 14.44 and load-time import VCRUNTIME140.dll, VCRUNTIME140_1.dll,
; MSVCP140.dll and MSVCP140_1.dll. The MSVC runtime is forward compatible but
; not backward, so a machine with an older runtime fails at INITIALISATION
; rather than at load — ERROR_DLL_INIT_FAILED (1114), which is what a Windows 11
; box carrying the 2019 16.4 runtime (14.24) produced. Installing the current
; redistributable fixed it. Both measured in KYB-627.
;
; The redistributable is fetched at build time from an immutable Microsoft URL
; and SHA-256 verified by scripts/prepare-windows-vc-redist.mjs, then embedded
; in this installer. End users never download anything.
;
; This runs in customInit, BEFORE electron-builder copies the app payload. That
; ordering is deliberate: a cancelled UAC prompt or a failed prerequisite must
; not be able to leave a seemingly-installed app whose dictation is guaranteed
; to fail at first use.

!include "x64.nsh"
!include "LogicLib.nsh"

; 14.44 is the toolset the shipped binaries are linked with, so it is the floor
; Microsoft's forward-compatibility rule actually requires. NOT 14.51 — that is
; merely the version that happened to be installed when the fix was confirmed,
; and demanding it would over-demand by seven minors.
!define KYBER_VC_MIN_MAJOR 14
!define KYBER_VC_MIN_MINOR 44

; Registers, not `Var`, and this is not a style preference. electron-builder
; runs makensis TWICE — once for the installer and once for the uninstaller,
; with BUILD_UNINSTALLER defined — and only the installer pass inserts
; customInit. A `Var` declared here would therefore be unused in the uninstaller
; pass, raising "warning 6001: Variable not referenced or never set", which
; electron-builder escalates to an error. Registers are not declared, so they
; cannot be unused.
;
;   $R4  the verdict: "1" when every DLL meets the floor
;   $R5  why it does not, for the operator-facing message
;   $R0 $R1 $R2 $R3  GetDLLVersion output and the major/minor it unpacks to
;   $0   the redistributable's exit code
;
; customInit pushes and pops all of them.

; Check one runtime DLL's own file version. Clears kyberVcOk if the file is
; missing or older than the floor above.
;
; TRAP 1 — do not read the registry instead. KYB-627 measured
; HKLM\SOFTWARE\WOW6432Node\Microsoft\VisualStudio\14.0\VC\Runtimes\x64
; reporting v14.23.27820.00 on a machine whose four DLLs were all 14.24.28127.4.
; It under-reports by a toolset minor, so a registry comparison would run the
; redistributable on machines that do not need it — or skip one that does.
;
; TRAP 2 — do not read $SYSDIR. This installer process is 32-bit, so file access
; through $SYSDIR is redirected to SysWOW64 and would measure the 32-bit
; runtime. The caller disables redirection around these reads; the path below is
; the real 64-bit System32 only while it is disabled.
!macro KyberCheckVcDll name
  ClearErrors
  GetDLLVersion "$WINDIR\System32\${name}" $R0 $R1
  ${If} ${Errors}
    StrCpy $R4 "0"
    StrCpy $R5 "${name} is not installed"
  ${Else}
    ; GetDLLVersion packs major<<16|minor into the high dword.
    IntOp $R2 $R0 / 0x00010000
    IntOp $R3 $R0 & 0x0000FFFF
    ${If} $R2 < ${KYBER_VC_MIN_MAJOR}
      StrCpy $R4 "0"
      StrCpy $R5 "${name} is $R2.$R3"
    ${ElseIf} $R2 == ${KYBER_VC_MIN_MAJOR}
      ${If} $R3 < ${KYBER_VC_MIN_MINOR}
        StrCpy $R4 "0"
        StrCpy $R5 "${name} is $R2.$R3"
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

; Sets $R4 to 1 when all four DLLs are present and >= the floor.
!macro KyberCheckVcRuntime
  StrCpy $R4 "1"
  StrCpy $R5 ""
  ${DisableX64FSRedirection}
  !insertmacro KyberCheckVcDll "VCRUNTIME140.dll"
  !insertmacro KyberCheckVcDll "VCRUNTIME140_1.dll"
  !insertmacro KyberCheckVcDll "MSVCP140.dll"
  !insertmacro KyberCheckVcDll "MSVCP140_1.dll"
  ${EnableX64FSRedirection}
!macroend

!macro customInit
  ; The app ships x64 only (build.win.target arch: x64), so on a 32-bit Windows
  ; there is nothing this prerequisite could usefully do. Skip rather than
  ; abort: whatever else is wrong, it is not this.
  ${If} ${RunningX64}

    Push $R0
    Push $R1
    Push $R2
    Push $R3
    Push $R4
    Push $R5
    Push $0

    !insertmacro KyberCheckVcRuntime

    ${If} $R4 == "1"
      ; The common case, and the reason for checking at all: this installer is
      ; per-user and raises no UAC prompt of its own. Running the
      ; redistributable unconditionally would add one on every machine to
      ; benefit the few that need it.
      DetailPrint "Microsoft VC++ x64 runtime >= ${KYBER_VC_MIN_MAJOR}.${KYBER_VC_MIN_MINOR} already present; skipping prerequisite"
    ${Else}
      DetailPrint "Installing the Microsoft VC++ x64 runtime ($R5)"

      ; Embedded at compile time whether or not it is executed, so the 25 MB is
      ; unconditional — it is the UAC prompt that is conditional, not the size.
      InitPluginsDir
      ; Fail at COMPILE time with something readable if the prerequisite was not
      ; fetched, rather than with NSIS's bare "file not found". package:win runs
      ; the fetch through its prepackage:win hook; a bare `electron-builder
      ; --win` does not.
      !if /FileExists "${BUILD_RESOURCES_DIR}\vendor\vc_redist.x64.exe"
        File /oname=$PLUGINSDIR\vc_redist.x64.exe "${BUILD_RESOURCES_DIR}\vendor\vc_redist.x64.exe"
      !else
        !error "build/vendor/vc_redist.x64.exe is missing. Run `node scripts/prepare-windows-vc-redist.mjs` (package:win does this for you), then package again. KYB-627."
      !endif
      ExecWait '"$PLUGINSDIR\vc_redist.x64.exe" /install /quiet /norestart /log "$TEMP\KYBER-Studio-vc-redist.log"' $0

      ${If} $0 == 0
        DetailPrint "Microsoft VC++ x64 runtime installed"
      ${ElseIf} $0 == 3010
        ; 3010 is ERROR_SUCCESS_REBOOT_REQUIRED. The files are in place and
        ; usable now; the reboot settles servicing state, so this is a success.
        DetailPrint "Microsoft VC++ x64 runtime installed (a reboot is pending)"
      ${Else}
        ; 1638 means a newer VC14 product is already registered. Rather than
        ; trust that claim — or the registry key that under-reports, see TRAP 1
        ; — re-read the DLLs and let the measurement decide.
        !insertmacro KyberCheckVcRuntime
        ${If} $R4 == "1"
          DetailPrint "Microsoft VC++ x64 runtime already satisfied (installer returned $0)"
        ${Else}
          ${IfNot} ${Silent}
            MessageBox MB_ICONSTOP|MB_OK "KYBER Studio needs the Microsoft Visual C++ 2015-2022 x64 Redistributable, version ${KYBER_VC_MIN_MAJOR}.${KYBER_VC_MIN_MINOR} or newer, and could not install it.$\n$\nDetected: $R5$\nInstaller exit code: $0$\nLog: $TEMP\KYBER-Studio-vc-redist.log$\n$\nInstall it from Microsoft's 'Latest supported Visual C++ Redistributable downloads' page, then run this installer again.$\n$\nNothing has been installed."
          ${EndIf}
          DetailPrint "Microsoft VC++ x64 runtime could not be installed (exit $0, $R5)"
          SetErrorLevel 1
          ; Nothing has been copied yet, so quitting here leaves the machine
          ; exactly as it was rather than half-installed.
          Abort
        ${EndIf}
      ${EndIf}
    ${EndIf}

    Pop $0
    Pop $R5
    Pop $R4
    Pop $R3
    Pop $R2
    Pop $R1
    Pop $R0

  ${EndIf}
!macroend
