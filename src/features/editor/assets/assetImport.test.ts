import { describe, expect, it, vi } from "vitest";

import type { EditorAssetGateway } from "../editorGateway";
import {
  detectAssetImageKind,
  prepareFileAssetImport,
} from "./assetImport";

function gateway(): EditorAssetGateway {
  return {
    getPreference: vi.fn(),
    setDirectory: vi.fn(),
    resetDirectory: vi.fn(),
    beginUpload: vi.fn().mockResolvedValue({
      uploadId: "upload-1",
      maxBytes: 20 * 1024 * 1024,
      acceptedKind: "png",
    }),
    upload: vi.fn().mockResolvedValue({
      importId: "import-1",
      workspaceId: "workspace-1",
      assetPath: "assets/paste.png",
      fileName: "paste.png",
      imageKind: "png",
      mediaType: "image/png",
      byteLength: 8,
    }),
    select: vi.fn(),
    confirm: vi.fn(),
    cancel: vi.fn(),
    read: vi.fn(),
  };
}

describe("asset import preparation", () => {
  it("sniffs bytes and creates a nested document-relative link", async () => {
    const api = gateway();
    const file = new File(
      [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
      "paste.png",
      { type: "image/svg+xml" },
    );
    const prepared = await prepareFileAssetImport(
      api,
      "workspace-1",
      "notes/deep/topic.md",
      file,
    );
    expect(api.beginUpload).toHaveBeenCalledWith(
      "workspace-1",
      "image/png",
      "paste.png",
    );
    expect(prepared.markdownSource).toBe("../../assets/paste.png");
  });

  it("rejects active or unsupported content before upload", () => {
    expect(() =>
      detectAssetImageKind(new TextEncoder().encode("<svg></svg>")),
    ).toThrow("仅支持");
  });
});
