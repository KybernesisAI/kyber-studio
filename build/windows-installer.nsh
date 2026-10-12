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
; THESE TWO DEFINES ARE THE AUTHORITY. build/windows-vc-redist.json carries a
; minimumToolset field saying the same thing, but it is only ever interpolated
; into an error message — nothing enforces agreement between them. Bump both.
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

; Check one runtime DLL's own file version. Clears the verdict in $R4 if the
; file is missing or older than the floor above.
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
  ;
  ; UNMEASURED — ARM64 Windows. ${RunningX64} is IsWow64-based in the NSIS
  ; electron-builder pins (3.0.4.1), so an ARM64 machine takes the branch below,
  ; and with redirection disabled $WINDIR\System32 is the ARM64 system
  ; directory — the check would measure the ARM64 runtime while the x64 app
  ; running under emulation needs the x64 one. Nobody has tested this. It is
  ; recorded rather than assumed; the app is x64-only, so such a user is under
  ; emulation in any case.
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
      ; NSIS documents ExecWait's output variable as UNDEFINED when the process
      ; cannot be started: it "only sets the error flag if an error occurs; if
      ; an error occurs the contents of the user variable are undefined"
      ; (NSIS 4.9.1.5). Declining the elevation prompt is exactly that error —
      ; this installer is RequestExecutionLevel user and the redistributable
      ; requires administrator, so a refusal fails the LAUNCH rather than
      ; returning an exit code.
      ;
      ; So $0 is initialised and the error flag is tested. Without both,
      ; electron-builder's own .onInit can leave the literal string "0" in $0 —
      ; it does exactly that when an existing per-user install is being upgraded
      ; — which compares equal to success and would install the app with
      ; dictation still broken. That is the bug this file exists to fix, so
      ; reinstating it by trusting an undefined variable would be the worst
      ; possible failure here.
      ClearErrors
      StrCpy $0 ""
      ExecWait '"$PLUGINSDIR\vc_redist.x64.exe" /install /quiet /norestart /log "$TEMP\KYBER-Studio-vc-redist.log"' $0
      ${If} ${Errors}
        ; Fall into the branch below, which re-measures the DLLs and aborts if
        ; they still do not meet the floor. Nothing is assumed about why.
        StrCpy $0 "not started - the elevation prompt was declined, or the process could not be launched"
      ${EndIf}

      ; These are STRING comparisons — LogicLib's `==` is StrCmp — and that is
      ; load-bearing, not incidental. On the error path above $0 holds a
      ; sentence rather than a number. Changing either of these to `=`, which
      ; is IntCmp and looks more correct for an exit code, would coerce that
      ; sentence to 0, match the success branch, and silently reinstate the
      ; defect the ClearErrors guard above exists to prevent. Leave them `==`.
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
          DetailPrint "Microsoft VC++ x64 runtime already satisfied (prerequisite result: $0)"
        ${Else}
          ${IfNot} ${Silent}
            MessageBox MB_ICONSTOP|MB_OK "KYBER Studio needs the Microsoft Visual C++ 2015-2022 x64 Redistributable, version ${KYBER_VC_MIN_MAJOR}.${KYBER_VC_MIN_MINOR} or newer, and could not install it.$\n$\nDetected: $R5$\nPrerequisite result: $0$\nLog: $TEMP\KYBER-Studio-vc-redist.log$\n$\nInstall it from Microsoft's 'Latest supported Visual C++ Redistributable downloads' page, then run this installer again.$\n$\nKYBER Studio has not been installed."
          ${EndIf}
          DetailPrint "Microsoft VC++ x64 runtime could not be installed (result: $0, $R5)"
          ; 2, not 1: NSIS's convention is 1 = the user aborted, 2 = the
          ; script aborted the install. This is the latter, and a genuine
          ; user cancellation elsewhere already produces 1.
          SetErrorLevel 2
          ; No app payload has been copied, so there is no half-installed
          ; KYBER Studio. Note electron-builder's .onInit runs SetOutPath
          ; $INSTDIR before customInit and SetOutPath CREATES the directory, so
          ; an empty install directory is left behind either way — which is why
          ; the message above says the app was not installed rather than that
          ; nothing was.
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
