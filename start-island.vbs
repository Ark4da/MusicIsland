' Launches the island with no console flash at all (also suitable for shell:startup).
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
app = root & "\desktop-app"
exe = app & "\node_modules\electron\dist\electron.exe"
Set shell = CreateObject("WScript.Shell")
If fso.FileExists(exe) Then
  shell.Run """" & exe & """ """ & app & """", 1, False
Else
  ' First run: the .bat downloads the Electron binary and explains any missing step.
  shell.Run """" & root & "\start-island.bat""", 1, False
End If
