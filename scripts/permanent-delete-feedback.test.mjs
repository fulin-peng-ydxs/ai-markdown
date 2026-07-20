import assert from "node:assert/strict";
import test from "node:test";

import { permanentDeleteErrorMessage } from "../src/features/workbench/permanentDeleteFeedback.ts";

function desktopError(code, contentSafe) {
  return {
    code,
    messageKey: `error.${code}`,
    pathHint: "note.md",
    contentSafe,
    retryable: true,
  };
}

test("prepare failure never claims that deletion may have started", () => {
  const message = permanentDeleteErrorMessage(
    desktopError("permission_denied", true),
    "prepare",
  );
  assert.match(message, /无法确认待删除项目/);
  assert.doesNotMatch(message, /已经删除|未能完整完成/);
});

test("expired confirmation says no deletion was executed", () => {
  const message = permanentDeleteErrorMessage(
    desktopError("permanent_delete_confirmation_not_found", true),
    "delete",
  );
  assert.match(message, /尚未执行永久删除/);
  assert.doesNotMatch(message, /部分内容/);
});

test("changed target keeps its dedicated safety explanation", () => {
  const message = permanentDeleteErrorMessage(
    desktopError("permanent_delete_target_changed", true),
    "delete",
  );
  assert.match(message, /确认期间发生了变化/);
  assert.match(message, /避免删除错误内容/);
});

test("only an unsafe delete failure warns about partial deletion", () => {
  const message = permanentDeleteErrorMessage(
    desktopError("permanent_delete_failed", false),
    "delete",
  );
  assert.match(message, /部分内容可能已经删除/);
  assert.match(message, /刷新文件树/);
});
