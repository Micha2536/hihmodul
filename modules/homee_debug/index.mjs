/**
 * /modules/homee_debug/index.mjs
 *
 * Tool-only module: serves a local debug page and provides a button in the manager UI.
 * This module does not create nodes/attributes.
 */
export default function homeeDebugModule() {
  return {
    id: "homee_debug",
    label: "homee Debug",
    // manager UI detects webui via webui/settings.html existence
  };
}
