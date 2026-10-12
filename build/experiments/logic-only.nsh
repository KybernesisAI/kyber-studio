; TEMPORARY — KYB-627 isolation experiment. Delete with the workflow.
;
; LOGIC ONLY. The same runtime checks the real include performs on its skip
; path — RunningX64, the x64 redirection pair, four GetDLLVersion reads — with
; NO embedded payload and no File directive at all. Applied to main's tree.
;
; If this crashes under /S, the cause is the code running in .onInit (most
; likely the System plugin behind the redirection macros), not the payload.
!include "x64.nsh"
!include "LogicLib.nsh"

!macro LogicOnlyCheckDll name
  ClearErrors
  GetDLLVersion "$WINDIR\System32\${name}" $R0 $R1
  ${If} ${Errors}
    StrCpy $R4 "0"
  ${Else}
    IntOp $R2 $R0 / 0x00010000
    IntOp $R3 $R0 & 0x0000FFFF
    ${If} $R2 < 14
      StrCpy $R4 "0"
    ${EndIf}
  ${EndIf}
!macroend

!macro customInit
  ${If} ${RunningX64}
    Push $R0
    Push $R1
    Push $R2
    Push $R3
    Push $R4
    StrCpy $R4 "1"
    ${DisableX64FSRedirection}
    !insertmacro LogicOnlyCheckDll "VCRUNTIME140.dll"
    !insertmacro LogicOnlyCheckDll "VCRUNTIME140_1.dll"
    !insertmacro LogicOnlyCheckDll "MSVCP140.dll"
    !insertmacro LogicOnlyCheckDll "MSVCP140_1.dll"
    ${EnableX64FSRedirection}
    DetailPrint "logic-only verdict: $R4"
    Pop $R4
    Pop $R3
    Pop $R2
    Pop $R1
    Pop $R0
  ${EndIf}
!macroend
