; TEMPORARY — KYB-627 isolation experiment. Delete with the workflow.
;
; DATA ONLY. Embeds a payload the same size as the VC++ redistributable and
; never extracts it: the File directive sits in a branch that cannot be taken.
; Applied to main's tree, so the ONLY difference from a plain main installer is
; ~25 MB of incompressible data in the data block.
;
; If this crashes under /S, the cause is size or data layout and has nothing to
; do with the prerequisite logic.
!include "LogicLib.nsh"

!macro customInit
  ${If} $WINDIR == "a value $WINDIR can never hold"
    InitPluginsDir
    File /oname=$PLUGINSDIR\dummy.bin "${BUILD_RESOURCES_DIR}\vendor\dummy.bin"
  ${EndIf}
!macroend
