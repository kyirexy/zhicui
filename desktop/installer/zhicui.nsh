; 知萃安装界面：沿用客户端的白底、蓝色强调与叶片图标。
; 首屏只保留产品、安装位置和一个安装动作；升级沿用原路径。
; 安装/提权/卸载/快捷方式仍由 electron-builder 的官方模板处理。
!include nsDialogs.nsh
!include LogicLib.nsh
!include FileFunc.nsh

; 路径选择合并到首屏，避免默认目录页再问一次。
!ifdef allowToChangeInstallationDirectory
  !undef allowToChangeInstallationDirectory
!endif

!define MUI_BGCOLOR FFFFFF
!define MUI_TEXTCOLOR 20232B
!define MUI_INSTFILESPAGE_PROGRESSBAR smooth
!define MUI_INSTFILESPAGE_COLORS "465FF0 F1F3F8"
!define MUI_ABORTWARNING
!define MUI_UNFINISHPAGE_NOAUTOCLOSE

!ifndef BUILD_UNINSTALLER
Var ZhicuiPage
Var ZhicuiPath
Var ZhicuiOpen
Var ZhicuiFontTitle
Var ZhicuiFontBody
Var ZhicuiFontBrand
Var ZhicuiExisting
!endif

!macro customHeader
  Caption "知萃安装"
  BrandingText " "
  SetFont "Microsoft YaHei UI" 10
!macroend

!macro customWelcomePage
  Page custom ZhicuiWelcomeShow ZhicuiWelcomeLeave

  Function ZhicuiWelcomeShow
    ${If} ${isUpdated}
    ${OrIf} ${UAC_IsInnerInstance}
      Abort
    ${EndIf}
    !insertmacro MUI_HEADER_TEXT "知萃" "视频里的知识，从这里用起来"
    nsDialogs::Create 1018
    Pop $ZhicuiPage
    ${If} $ZhicuiPage == error
      Abort
    ${EndIf}
    SetCtlColors $ZhicuiPage 20232B FFFFFF
    CreateFont $ZhicuiFontBrand "Microsoft YaHei UI" 20 700
    CreateFont $ZhicuiFontTitle "Microsoft YaHei UI" 15 700
    CreateFont $ZhicuiFontBody "Microsoft YaHei UI" 10 400

    InitPluginsDir
    File /oname=$PLUGINSDIR\zhicui.ico "${PROJECT_DIR}\..\frontend\public\icons\desktop-icon.ico"
    ${NSD_CreateIcon} 0 1u 32u 32u ""
    Pop $0
    ${NSD_SetIcon} $0 "$PLUGINSDIR\zhicui.ico" $1

    ${NSD_CreateLabel} 42u 0u 200u 25u "知萃"
    Pop $0
    SendMessage $0 ${WM_SETFONT} $ZhicuiFontBrand 1
    SetCtlColors $0 20232B FFFFFF
    ${NSD_CreateLabel} 43u 27u 230u 14u "桌面客户端  ${VERSION}"
    Pop $0
    SetCtlColors $0 687184 FFFFFF

    StrCpy $ZhicuiExisting 0
    ${If} $hasPerUserInstallation == "1"
    ${OrIf} $hasPerMachineInstallation == "1"
      StrCpy $ZhicuiExisting 1
    ${EndIf}
    ${If} $ZhicuiExisting == 1
      ${NSD_CreateLabel} 0u 54u 300u 24u "新的知萃，接着用。"
      Pop $0
      SendMessage $0 ${WM_SETFONT} $ZhicuiFontTitle 1
      SetCtlColors $0 20232B FFFFFF
      ${NSD_CreateLabel} 0u 80u 300u 24u "更新客户端，保留你的登录和本机资料。"
      Pop $0
    ${Else}
      ${NSD_CreateLabel} 0u 54u 300u 24u "让收藏，真正用起来。"
      Pop $0
      SendMessage $0 ${WM_SETFONT} $ZhicuiFontTitle 1
      SetCtlColors $0 20232B FFFFFF
      ${NSD_CreateLabel} 0u 80u 300u 24u "同步视频 · AI 问答 · 把方法变成行动计划"
      Pop $0
    ${EndIf}
    SetCtlColors $0 687184 FFFFFF

    ${NSD_CreateLabel} 0u 108u 300u 12u "安装位置"
    Pop $0
    SetCtlColors $0 687184 FFFFFF
    ${NSD_CreateText} 0u 122u 245u 20u "$INSTDIR"
    Pop $ZhicuiPath
    SendMessage $ZhicuiPath ${EM_SETREADONLY} 1 0
    SetCtlColors $ZhicuiPath 4B5466 F4F5F9
    ${NSD_CreateButton} 253u 122u 47u 20u "更改…"
    Pop $0
    ${NSD_OnClick} $0 ZhicuiBrowse
    ${If} $ZhicuiExisting == 1
      EnableWindow $0 0
    ${EndIf}
    GetDlgItem $0 $HWNDPARENT 1
    ${If} $ZhicuiExisting == 1
      SendMessage $0 ${WM_SETTEXT} 0 "STR:立即更新"
    ${Else}
      SendMessage $0 ${WM_SETTEXT} 0 "STR:立即安装"
    ${EndIf}
    GetDlgItem $0 $HWNDPARENT 2
    SendMessage $0 ${WM_SETTEXT} 0 "STR:取消"
    nsDialogs::Show
  FunctionEnd

  Function ZhicuiBrowse
    Pop $0
    nsDialogs::SelectFolderDialog "选择知萃的安装位置" "$INSTDIR"
    Pop $0
    ${If} $0 != error
    ${AndIf} $0 != ""
      ; 总是在专用应用目录安装，避免把文件直接散落在磁盘或用户目录。
      ${GetFileName} "$0" $1
      ${If} $1 == "${APP_FILENAME}"
        StrCpy $INSTDIR "$0"
      ${Else}
        StrCpy $INSTDIR "$0\${APP_FILENAME}"
      ${EndIf}
      ${NSD_SetText} $ZhicuiPath "$INSTDIR"
    ${EndIf}
  FunctionEnd

  Function ZhicuiWelcomeLeave
    ${If} $INSTDIR == ""
      MessageBox MB_OK|MB_ICONEXCLAMATION "请选择安装位置。"
      Abort
    ${EndIf}
    ; 首屏承担原目录页的可写性和空间检查。已有全机安装交由官方 UAC 流程处理。
    ${If} $installMode != "all"
    ${AndIfNot} ${isForAllUsers}
      ClearErrors
      CreateDirectory "$INSTDIR"
      GetTempFileName $0 "$INSTDIR"
      ${If} ${Errors}
        MessageBox MB_OK|MB_ICONEXCLAMATION "这个位置暂时无法写入，请点击“更改”选择其他文件夹。"
        Abort
      ${EndIf}
      Delete "$0"
      System::Call 'kernel32::GetDiskFreeSpaceExW(w "$INSTDIR", *l .r1, p 0, p 0) i.r0'
      ${If} $0 == 0
        MessageBox MB_OK|MB_ICONEXCLAMATION "暂时无法确认可用空间，请选择其他安装位置。"
        Abort
      ${EndIf}
      SectionGetSize 0 $2
      IntOp $2 $2 + 131072
      System::Int64Op $1 / 1024
      Pop $1
      System::Int64Op $1 < $2
      Pop $0
      ${If} $0 == 1
        MessageBox MB_OK|MB_ICONEXCLAMATION "这个磁盘的可用空间不足，请清理空间或选择其他安装位置。"
        Abort
      ${EndIf}
    ${EndIf}
    System::Call 'gdi32::DeleteObject(p $ZhicuiFontBrand)'
    System::Call 'gdi32::DeleteObject(p $ZhicuiFontTitle)'
    System::Call 'gdi32::DeleteObject(p $ZhicuiFontBody)'
  FunctionEnd
!macroend

; 默认当前用户安装。已有全机安装仍走官方提权路径；不改注册表归属。
!macro customInstallMode
  !ifndef BUILD_UNINSTALLER
    ${If} $installMode != "all"
    ${AndIfNot} ${isForAllUsers}
      Abort
    ${Else}
      StrCpy $isForceMachineInstall 1
    ${EndIf}
  !endif
!macroend

!macro customPageAfterChangeDir
  !define MUI_INSTFILESPAGE_HEADER_TEXT "正在安装知萃"
  !define MUI_INSTFILESPAGE_HEADER_SUBTEXT "请稍候，完成后即可继续使用。"
!macroend

!macro customFinishPage
  Page custom ZhicuiFinishShow ZhicuiFinishLeave

  Function ZhicuiFinishShow
    !insertmacro MUI_HEADER_TEXT "安装完成" "一切就绪"
    nsDialogs::Create 1018
    Pop $ZhicuiPage
    ${If} $ZhicuiPage == error
      Abort
    ${EndIf}
    SetCtlColors $ZhicuiPage 20232B FFFFFF
    CreateFont $ZhicuiFontTitle "Microsoft YaHei UI" 18 700
    ${NSD_CreateLabel} 0u 28u 300u 30u "知萃，准备好了。"
    Pop $0
    SendMessage $0 ${WM_SETFONT} $ZhicuiFontTitle 1
    SetCtlColors $0 20232B FFFFFF
    ${NSD_CreateLabel} 0u 65u 300u 26u "打开客户端，从同步你的第一组视频开始。"
    Pop $0
    SetCtlColors $0 687184 FFFFFF
    ${NSD_CreateCheckbox} 0u 108u 290u 20u "完成后打开知萃"
    Pop $ZhicuiOpen
    ${NSD_Check} $ZhicuiOpen
    SetCtlColors $ZhicuiOpen 20232B FFFFFF
    GetDlgItem $0 $HWNDPARENT 1
    SendMessage $0 ${WM_SETTEXT} 0 "STR:完成"
    GetDlgItem $0 $HWNDPARENT 3
    ShowWindow $0 ${SW_HIDE}
    GetDlgItem $0 $HWNDPARENT 2
    EnableWindow $0 0
    nsDialogs::Show
  FunctionEnd

  Function ZhicuiFinishLeave
    ${NSD_GetState} $ZhicuiOpen $0
    ${If} $0 == ${BST_CHECKED}
      ${If} ${isUpdated}
        StrCpy $1 "--updated"
      ${Else}
        StrCpy $1 ""
      ${EndIf}
      ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
    ${EndIf}
    System::Call 'gdi32::DeleteObject(p $ZhicuiFontTitle)'
  FunctionEnd
!macroend
