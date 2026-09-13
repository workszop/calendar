import { getStore } from "@netlify/blobs";
import { createBlobPollStore } from "./blob-store";
import type { PollStore } from "./poll-store";

// ─── Netlify Blobs poll store ───
// One place decides the store name, so the API and the scheduled cleanup always
// touch the same data. Preview and branch deploys get a deploy-specific store.

const STORE_NAME = "calendar-polls";

export function createNetlifyPollStore(): PollStore {
  const isPreview = process.env.CONTEXT === "deploy-preview" || process.env.CONTEXT === "branch-deploy";
  if (isPreview && !process.env.DEPLOY_ID) throw new Error("Preview deploy ID is missing");
  const name = isPreview ? `${STORE_NAME}-${process.env.DEPLOY_ID}` : STORE_NAME;
  return createBlobPollStore(getStore({ name, consistency: "strong" }));
}
