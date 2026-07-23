import type {
  DesktopError,
  DesktopErrorCode,
} from "./contracts";

export function normalizeDesktopError(
  reason: unknown,
  fallbackCode: DesktopErrorCode,
): DesktopError {
  if (
    typeof reason === "object" &&
    reason !== null &&
    "code" in reason &&
    "messageKey" in reason
  ) {
    return reason as DesktopError;
  }
  return {
    code: fallbackCode,
    messageKey: `error.desktop.${fallbackCode}`,
    pathHint: null,
    contentSafe: true,
    retryable: true,
  };
}

export function desktopErrorMessage(error: DesktopError): string {
  switch (error.code) {
    case "path_not_found":
    case "selection_not_found":
      return "原路径已经不存在或不可访问。可以重新选择目录，或安全移除这条记录。";
    case "permission_denied":
      return "Plainroot 当前没有读取该目录的权限。请重新授权后再试。";
    case "unsupported_markdown_file":
      return "只能打开扩展名为 .md 的 Markdown 文件。";
    case "selection_confirmation_required":
      return "需要先确认将被授权和扫描的目录范围。";
    case "window_not_found":
      return "目标窗口已关闭。重新打开不会修改任何 Markdown 文件。";
    case "window_create_failed":
      return "未能创建新窗口，原窗口和文件仍保持不变。";
    case "window_focus_failed":
      return "未能聚焦已有窗口。可以重试，或留在当前启动页。";
    case "window_title_failed":
      return "窗口标题未能同步，但当前文件内容和磁盘状态没有改变。";
    case "window_close_failed":
      return "未能关闭窗口，当前工作区会话仍然保留。";
    case "state_unavailable":
    case "state_read_failed":
    case "unsupported_state_version":
    case "invalid_state_data":
      return "无法读取本机的最近工作区和窗口会话。Markdown 文件没有受到影响。";
    case "state_write_failed":
      return "无法更新本机工作区记录。Markdown 文件没有受到影响，请重试。";
    case "dialog_unavailable":
      return "系统文件选择器当前不可用。请稍后重试。";
    case "scan_not_found":
    case "scan_unavailable":
      return "文件树读取已中断。磁盘内容没有改变，可以手动刷新后重试。";
    case "watch_not_found":
    case "watch_unavailable":
      return "文件变化监听已停止。当前文件树仍可查看，请手动刷新或重启监听。";
    case "unsupported_text_encoding":
      return "该文件不是受支持的 UTF-8 编码，Plainroot 没有修改它。";
    case "file_too_large":
      return "该文件超过当前读取上限，Plainroot 没有修改它。";
    case "conflict_confirmation_not_found":
      return "覆盖确认已经过期或被使用。请重新检查磁盘版本后再决定。";
    case "conflict_content_changed":
      return "确认后编辑内容又发生了变化。为避免覆盖错误内容，请重新确认。";
    case "save_copy_confirmation_not_found":
      return "另存目标授权已经过期或被使用。请重新选择目标。";
    case "save_copy_target_changed":
      return "另存目标在确认前发生了变化，Plainroot 没有覆盖它。请重新选择。";
    case "save_copy_format_required":
      return "当前文件的编码或换行格式不能直接保留，请明确选择 UTF-8 输出格式。";
    case "save_copy_overwrite_confirmation_required":
      return "目标文件已经存在，必须明确确认覆盖结果后才能继续。";
    case "save_copy_failed":
    case "editor_save_unavailable":
      return "保存副本没有完成，当前编辑内容和原磁盘文件仍保持不变。";
    case "invalid_entry_name":
      return "名称包含不支持的字符、路径分隔符或空白边界，请换一个名称。";
    case "reserved_entry_name":
      return "该名称在 Windows 或 macOS 上属于保留名称，请换一个名称。";
    case "target_already_exists":
      return "目标位置已经存在同名项目，磁盘和文件树均未改变。";
    case "cross_device_move":
      return "不能跨磁盘移动这个项目。请在同一工作区内选择目标文件夹。";
    case "invalid_move_target":
      return "不能把文件夹移动到自身、子目录或原位置。";
    case "mutation_unavailable":
      return "文件操作服务当前不可用，磁盘和文件树均未改变。";
    case "trash_unavailable":
      return "系统废纸篓或回收站当前不可用。Plainroot 尚未永久删除该项目。";
    case "reveal_unavailable":
      return "系统文件管理器未能定位这个项目。文件本身没有改变。";
    default:
      return error.retryable
        ? "操作没有完成，现有文件和窗口保持不变。请重试。"
        : "操作没有完成，现有文件和窗口保持不变。";
  }
}
