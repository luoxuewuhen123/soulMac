; 安装时：写入数据路径配置文件
!macro customInstall
  ; 默认数据目录为 %APPDATA%\soul
  FileOpen $0 "$INSTDIR\data-path.ini" w
  FileWrite $0 "$APPDATA\soul"
  FileClose $0
!macroend

; 卸载时询问是否保留用户数据
!macro customUnInstall
  ; 读取数据路径配置
  !define /ifndef DATA_PATH_NOT_FOUND
  StrCpy $R0 "$APPDATA\soul"
  IfFileExists "$INSTDIR\data-path.ini" 0 +3
    FileOpen $R1 "$INSTDIR\data-path.ini" r
    FileRead $R1 $R0
    FileClose $R1
  
  MessageBox MB_YESNO "是否保留茵茵的数据文件？（聊天记录、AI 配置、技能设置等）$\n$\n选「是」= 保留数据，下次重装可直接恢复$\n选「否」= 删除所有数据" \
    /SD IDYES IDYES keepData
    SetShellVarContext current
    RMDir /r "$R0"
    keepData:
!macroend
