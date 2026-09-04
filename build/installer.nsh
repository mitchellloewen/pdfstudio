; Per-user application registration so PDF Studio shows up in Windows
; Settings > Default apps and in the "Open with" picker (Windows 10/11).
; electron-builder's fileAssociations writes the .pdf ProgID wiring, but not
; RegisteredApplications/Capabilities — without those the app is invisible in
; the default-apps UI.

!macro customInstall
  WriteRegStr HKCU "Software\Classes\PDFStudio.pdf" "" "PDF Document"
  WriteRegStr HKCU "Software\Classes\PDFStudio.pdf" "FriendlyTypeName" "PDF Document"
  WriteRegStr HKCU "Software\Classes\PDFStudio.pdf\DefaultIcon" "" "$INSTDIR\PDF Studio.exe,0"
  WriteRegStr HKCU "Software\Classes\PDFStudio.pdf\shell\open\command" "" '"$INSTDIR\PDF Studio.exe" "%1"'

  WriteRegStr HKCU "Software\Classes\Applications\PDF Studio.exe" "FriendlyAppName" "PDF Studio"
  WriteRegStr HKCU "Software\Classes\Applications\PDF Studio.exe\DefaultIcon" "" "$INSTDIR\PDF Studio.exe,0"
  WriteRegStr HKCU "Software\Classes\Applications\PDF Studio.exe\shell\open\command" "" '"$INSTDIR\PDF Studio.exe" "%1"'
  WriteRegStr HKCU "Software\Classes\Applications\PDF Studio.exe\SupportedTypes" ".pdf" ""

  WriteRegStr HKCU "Software\PDF Studio\Capabilities" "ApplicationName" "PDF Studio"
  WriteRegStr HKCU "Software\PDF Studio\Capabilities" "ApplicationDescription" "Local PDF reader, editor, form-filler, signer and takeoff tool."
  WriteRegStr HKCU "Software\PDF Studio\Capabilities\FileAssociations" ".pdf" "PDFStudio.pdf"
  WriteRegStr HKCU "Software\RegisteredApplications" "PDF Studio" "Software\PDF Studio\Capabilities"

  ; SHCNE_ASSOCCHANGED — refresh the shell's association cache
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\PDFStudio.pdf"
  DeleteRegKey HKCU "Software\Classes\Applications\PDF Studio.exe"
  DeleteRegKey HKCU "Software\PDF Studio"
  DeleteRegValue HKCU "Software\RegisteredApplications" "PDF Studio"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend
