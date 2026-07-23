import type {
  AssetImageKind,
  AssetImportProposal,
  WorkspaceId,
  WorkspaceRelativePath,
} from "../../../services/desktop/contracts";
import type { EditorAssetGateway } from "../editorGateway";
import { workspaceAssetPathToMarkdown } from "./workspaceAssetPath";

export const MAX_ASSET_INPUT_BYTES = 20 * 1024 * 1024;

export interface PreparedAssetImport {
  proposal: AssetImportProposal;
  markdownSource: string;
}

export async function prepareFileAssetImport(
  gateway: EditorAssetGateway,
  workspaceId: WorkspaceId,
  documentPath: WorkspaceRelativePath,
  file: File,
): Promise<PreparedAssetImport> {
  if (file.size > MAX_ASSET_INPUT_BYTES) {
    throw new Error("图片超过 20 MiB，未写入工作区");
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const kind = detectAssetImageKind(bytes);
  const ticket = await gateway.beginUpload(
    workspaceId,
    mediaTypeForKind(kind),
    file.name || `image.${extensionForKind(kind)}`,
  );
  if (bytes.byteLength > ticket.maxBytes) {
    throw new Error("图片超过工作区资源上限，未写入工作区");
  }
  const proposal = await gateway.upload(ticket.uploadId, bytes);
  return {
    proposal,
    markdownSource: workspaceAssetPathToMarkdown(
      documentPath,
      proposal.assetPath,
    ),
  };
}

export async function prepareSelectedAssetImport(
  gateway: EditorAssetGateway,
  workspaceId: WorkspaceId,
  documentPath: WorkspaceRelativePath,
): Promise<PreparedAssetImport | null> {
  const selection = await gateway.select(workspaceId);
  return selection.status === "cancelled"
    ? null
    : {
        proposal: selection.proposal,
        markdownSource: workspaceAssetPathToMarkdown(
          documentPath,
          selection.proposal.assetPath,
        ),
      };
}

export function detectAssetImageKind(bytes: Uint8Array): AssetImageKind {
  if (
    bytes.length >= 8 &&
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every(
      (value, index) => bytes[index] === value,
    )
  ) {
    return "png";
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff &&
    bytes.at(-2) === 0xff &&
    bytes.at(-1) === 0xd9
  ) {
    return "jpeg";
  }
  const ascii = (start: number, end: number) =>
    String.fromCharCode(...bytes.slice(start, end));
  if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(ascii(0, 6))) {
    return "gif";
  }
  if (
    bytes.length >= 12 &&
    ascii(0, 4) === "RIFF" &&
    ascii(8, 12) === "WEBP"
  ) {
    return "webp";
  }
  throw new Error("仅支持 PNG、JPEG、GIF 或 WebP 图片");
}

export function mediaTypeForKind(kind: AssetImageKind): string {
  return kind === "jpeg" ? "image/jpeg" : `image/${kind}`;
}

function extensionForKind(kind: AssetImageKind): string {
  return kind === "jpeg" ? "jpg" : kind;
}
