import { bench } from "vitest";

import {
  createWorkspaceTabCollection,
  reduceWorkspaceTabs,
} from "./tabReducer";
import { createWorkspaceTabDescriptor } from "./tabTypes";

bench("open and index 100 lightweight workspace tabs", () => {
  let state = createWorkspaceTabCollection("workspace-performance");
  for (let index = 0; index < 100; index += 1) {
    state = reduceWorkspaceTabs(state, {
      type: "open",
      tab: createWorkspaceTabDescriptor({
        tabId: `tab-${index}`,
        workspaceId: "workspace-performance",
        relativePath: `section-${index}/note-${index}.md`,
        lastActivatedAt: index,
      }),
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
      tab: createWorkspaceTabDescriptor({
        tabId: `tab-${index}`,
        workspaceId: "workspace-performance",
        relativePath: `section-${index}/note-${index}.md`,
        lastActivatedAt: index,
      }),
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
