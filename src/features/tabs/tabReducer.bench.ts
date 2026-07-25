import { bench } from "vitest";

import {
  createWorkspaceTabCollection,
  reduceWorkspaceTabs,
} from "./tabReducer";
import { acceptWorkspaceTabPath } from "./tabPath";

function openRequest(index: number) {
  const relativePath = `section-${index}/note-${index}.md`;
  return {
    tabId: `tab-${index}`,
    workspaceId: "workspace-performance",
    path: acceptWorkspaceTabPath({
      relativePath,
      identity: `native:${relativePath}`,
    }),
    lastActivatedAt: index,
  };
}

bench("open and index 100 lightweight workspace tabs", () => {
  let state = createWorkspaceTabCollection("workspace-performance");
  for (let index = 0; index < 100; index += 1) {
    state = reduceWorkspaceTabs(state, {
      type: "open",
      tab: openRequest(index),
    });
  }
  if (state.orderedTabIds.length !== 100) {
    throw new Error("performance probe produced an invalid collection");
  }
});

bench("switch among 100 lightweight workspace tabs", () => {
  let state = createWorkspaceTabCollection("workspace-performance");
  for (let index = 0; index < 100; index += 1) {
    state = reduceWorkspaceTabs(state, {
      type: "open",
      tab: openRequest(index),
    });
  }
  const originalTabs = state.tabsById;
  for (let index = 0; index < 100; index += 1) {
    state = reduceWorkspaceTabs(state, {
      type: "activate",
      tabId: `tab-${index}`,
      activatedAt: 1_000 + index,
    });
  }
  if (state.tabsById.size !== originalTabs.size) {
    throw new Error("tab switching rebuilt the collection incorrectly");
  }
});
