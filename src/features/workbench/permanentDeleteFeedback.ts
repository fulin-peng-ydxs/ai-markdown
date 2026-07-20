import type { DesktopError } from "../../services/desktop/contracts";

export type PermanentDeleteErrorPhase = "prepare" | "delete";

export function permanentDeleteErrorMessage(
  error: DesktopError,
  phase: PermanentDeleteErrorPhase,
): string {
  if (phase === "prepare") {
    return "无法确认待删除项目。项目可能已移动、删除或无法访问，请检查文件树后重试。";
  }
  if (error.code === "permanent_delete_target_changed") {
    return "项目在确认期间发生了变化。为避免删除错误内容，请关闭后重新操作。";
  }
  if (error.contentSafe) {
    return "尚未执行永久删除，原内容仍然安全。请关闭后检查文件树，再重新操作。";
  }
  return "永久删除未能完整完成，部分内容可能已经删除。请关闭对话框并刷新文件树后再处理。";
}
