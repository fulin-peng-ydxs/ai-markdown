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
    default:
      return error.retryable
        ? "操作没有完成，现有文件和窗口保持不变。请重试。"
        : "操作没有完成，现有文件和窗口保持不变。";
  }
}
