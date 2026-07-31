/*
 * KAT <-> Scratch editor bridge (runs INSIDE the self-hosted scratch-gui iframe, not in the Next app).
 *
 * This is the editor half of the contract in the KAT app's src/lib/scratch.ts; the message-type strings
 * here MUST stay identical to SCRATCH_MSG there. It lets the KAT page load a project into the editor and
 * ask it to save, and reports readiness / unsaved-changes / save results back up.
 *
 * The VM is put on window.__katVM by kat-vm-exposer.jsx (it lives in the Redux store, not a global).
 * The parent origin (the KAT app allowed to drive this editor) is read from the ?parent=<origin> query
 * param the KAT iframe sets. Messages from any other origin are ignored.
 */
(function () {
  "use strict";

  var SCRATCH_MSG = {
    READY: "kat:scratch:ready",
    DIRTY: "kat:scratch:dirty",
    SAVED: "kat:scratch:saved",
    SAVE_FAILED: "kat:scratch:save-failed",
    LOAD: "kat:scratch:load",
    SAVE: "kat:scratch:save",
  };

  // The KAT origin permitted to talk to this editor. No parent, or a wildcard, means "do nothing".
  var PARENT_ORIGIN = new URLSearchParams(window.location.search).get("parent");
  if (!PARENT_ORIGIN || PARENT_ORIGIN === "*") return;

  function getVM() {
    // Set by kat-vm-exposer.jsx once the GUI mounts. Null until then.
    return window.__katVM || null;
  }

  function post(message) {
    window.parent.postMessage(message, PARENT_ORIGIN);
  }

  // Load a project the KAT page points us at (a fetchable .sb3), or a blank project when projectUrl is null.
  async function load(projectUrl) {
    var vm = getVM();
    if (!vm) return;
    if (!projectUrl) return; // a blank editor is the GUI's default; nothing to load
    var res = await fetch(projectUrl);
    var buffer = await res.arrayBuffer();
    await vm.loadProject(buffer);
  }

  // Serialize the current project and PUT it to the presigned R2 url the KAT page gave us, then report the
  // stored key back. The bytes go straight to R2, they never round-trip through the parent window.
  async function save(uploadUrl, key) {
    var vm = getVM();
    if (!vm) {
      post({ type: SCRATCH_MSG.SAVE_FAILED, message: "Editor not ready." });
      return;
    }
    try {
      var blob = await vm.saveProjectSb3(); // scratch-vm: resolves to a .sb3 Blob
      var put = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": "application/x.scratch.sb3" },
        body: blob,
      });
      if (!put.ok) throw new Error("R2 responded " + put.status);
      post({ type: SCRATCH_MSG.SAVED, key: key });
    } catch (err) {
      post({ type: SCRATCH_MSG.SAVE_FAILED, message: String((err && err.message) || err) });
    }
  }

  window.addEventListener("message", function (event) {
    if (event.origin !== PARENT_ORIGIN) return; // only obey the KAT page that framed us
    var data = event.data;
    if (!data || typeof data !== "object") return;
    if (data.type === SCRATCH_MSG.LOAD) void load(data.projectUrl || null);
    else if (data.type === SCRATCH_MSG.SAVE) void save(data.uploadUrl, data.key);
  });

  // Announce readiness (and re-announce once the VM exists, in case this ran before the GUI mounted).
  function announceWhenReady() {
    if (getVM()) {
      post({ type: SCRATCH_MSG.READY });
      var vm = getVM();
      // Any project change marks the work dirty so the KAT page can enable Save / warn before leaving.
      if (vm.on) vm.on("PROJECT_CHANGED", function () { post({ type: SCRATCH_MSG.DIRTY }); });
      return;
    }
    setTimeout(announceWhenReady, 250);
  }
  announceWhenReady();
})();
