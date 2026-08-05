/*
 * KAT <-> Scratch editor bridge (runs INSIDE the self-hosted scratch-gui iframe, not in the Next app).
 *
 * This is the editor half of the contract in `src/lib/scratch.ts`; the message-type strings here MUST
 * stay identical to SCRATCH_MSG there. It lets the KAT page load a project into the editor and ask it to
 * save, and reports readiness / unsaved-changes / save results back up. It also exposes
 * `window.__katBridge.save() / .open()` so the editor's own File menu (menu-bar.jsx) drives save/open:
 * those REQUEST a presigned URL from the KAT page, which replies with SAVE / LOAD. And it exposes
 * `window.__katBridge.saveVideo(blob, durationMs)` so the stage recorder (kat-recorder.jsx) can upload a
 * .webm recording to R2 the same way (REQUEST_VIDEO_UPLOAD -> VIDEO_UPLOAD_URL -> PUT -> VIDEO_SAVED).
 *
 * WIRING: in scratch-gui the VM is NOT a global, it lives in the Redux store (`state.scratchGui.vm`).
 * Expose it with the tiny `KatVmExposer` connected component from the README, which sets `window.__katVM`,
 * and `getVM()` below returns that. Vanilla scratch-gui embeds without any patch (unlike TurboWarp).
 *
 * The parent origin (the KAT app allowed to drive this editor) is read from the `?parent=<origin>` query
 * param the KAT iframe sets. Messages from any other origin are ignored.
 */
(function () {
  "use strict";

  var SCRATCH_MSG = {
    READY: "kat:scratch:ready",
    DIRTY: "kat:scratch:dirty",
    SAVED: "kat:scratch:saved",
    SAVE_FAILED: "kat:scratch:save-failed",
    REQUEST_SAVE: "kat:scratch:request-save",
    REQUEST_LOAD: "kat:scratch:request-load",
    REQUEST_VIDEO_UPLOAD: "kat:scratch:request-video-upload",
    VIDEO_SAVED: "kat:scratch:video-saved",
    VIDEO_SAVE_FAILED: "kat:scratch:video-save-failed",
    LOAD: "kat:scratch:load",
    SAVE: "kat:scratch:save",
    VIDEO_UPLOAD_URL: "kat:scratch:video-upload-url",
    VIDEO_UPLOAD_DENIED: "kat:scratch:video-upload-denied",
  };

  // The KAT origin permitted to talk to this editor. No parent, or a wildcard, means "do nothing".
  var PARENT_ORIGIN = new URLSearchParams(window.location.search).get("parent");
  if (!PARENT_ORIGIN || PARENT_ORIGIN === "*") return;

  function getVM() {
    // COMPLETE THIS for your GUI build. Return the scratch-vm instance, or null if not ready yet.
    return window.__katVM || null;
  }

  function post(message) {
    window.parent.postMessage(message, PARENT_ORIGIN);
  }

  // A small transient toast INSIDE the editor, so File -> Save gives feedback even in full screen, where
  // the KAT page's own status line is covered by the editor.
  function toast(text, isError) {
    var el = document.createElement("div");
    el.textContent = text;
    el.style.cssText =
      "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483647;" +
      "padding:10px 16px;border-radius:10px;font:600 13px system-ui,sans-serif;color:#fff;" +
      "box-shadow:0 8px 24px rgba(0,0,0,.28);pointer-events:none;background:" +
      (isError ? "#b42318" : "#2f6f4e") + ";";
    document.body.appendChild(el);
    setTimeout(function () { el.remove(); }, isError ? 4500 : 1800);
  }

  // Load a project the KAT page points us at (a fetchable .sb3), or a blank project when projectUrl is null.
  async function load(projectUrl) {
    var vm = getVM();
    if (!vm) return;
    if (!projectUrl) return; // a blank editor is the GUI's default; nothing to load (stay silent)
    try {
      var res = await fetch(projectUrl);
      var buffer = await res.arrayBuffer();
      await vm.loadProject(buffer);
      toast("Opened your saved project");
    } catch (err) {
      toast("Could not open your saved project.", true);
    }
  }

  // Serialize the current project and PUT it to the presigned R2 url the KAT page gave us, then report the
  // stored key back. The bytes go straight to R2, they never round-trip through the parent window.
  async function save(uploadUrl, key) {
    var vm = getVM();
    if (!vm) {
      post({ type: SCRATCH_MSG.SAVE_FAILED, message: "Editor not ready." });
      toast("Editor not ready.", true);
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
      toast("Saved");
    } catch (err) {
      post({ type: SCRATCH_MSG.SAVE_FAILED, message: String((err && err.message) || err) });
      toast("Could not save. Try again.", true);
    }
  }

  // Exposed for the File menu (menu-bar.jsx calls window.__katBridge.save / .open). These ASK the KAT page
  // for a fresh presigned URL; the page replies with SAVE / LOAD, handled by the listener below. This is
  // what lets the pupil use the editor's own familiar File menu instead of a button on the KAT page.
  function requestSave() {
    toast("Saving…");
    post({ type: SCRATCH_MSG.REQUEST_SAVE });
  }
  function requestOpen() {
    if (window.confirm("Reload your saved project? Any unsaved changes will be lost.")) {
      post({ type: SCRATCH_MSG.REQUEST_LOAD });
    }
  }

  // Save a stage recording (a .webm Blob the kat-recorder produced) to the pupil's KAT account. Ask the
  // parent for a presigned upload URL (it enforces the size cap + rate limit), then PUT the bytes to R2 and
  // report the stored key. Only one save is in flight at a time (the recorder saves a single clip at once).
  var pendingVideo = null; // { blob, durationMs }
  function saveVideo(blob, durationMs) {
    if (!blob) return;
    if (pendingVideo) { toast("A recording is already saving…", true); return; }
    pendingVideo = { blob: blob, durationMs: typeof durationMs === "number" ? durationMs : null };
    toast("Saving your recording…");
    post({ type: SCRATCH_MSG.REQUEST_VIDEO_UPLOAD, sizeBytes: blob.size, durationMs: pendingVideo.durationMs });
  }
  // Tell the recorder (same window) how the save went, so its button can show Saved / retry. Decoupled
  // from the parent contract: it is a local event, the KAT page is notified separately via VIDEO_SAVED.
  function reportVideoResult(ok, message) {
    try {
      window.dispatchEvent(new CustomEvent("kat:video-save-result", { detail: { ok: ok, message: message || null } }));
    } catch (e) { /* CustomEvent unsupported: the toast is still shown */ }
  }
  async function putVideo(uploadUrl, key) {
    var job = pendingVideo;
    if (!job) return;
    try {
      var put = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": "video/webm" },
        body: job.blob,
      });
      if (!put.ok) throw new Error("R2 responded " + put.status);
      post({ type: SCRATCH_MSG.VIDEO_SAVED, key: key, sizeBytes: job.blob.size, durationMs: job.durationMs });
      toast("Recording saved to your account");
      reportVideoResult(true);
    } catch (err) {
      post({ type: SCRATCH_MSG.VIDEO_SAVE_FAILED, message: String((err && err.message) || err) });
      toast("Could not save the recording. Try again.", true);
      reportVideoResult(false, "Could not save the recording.");
    } finally {
      pendingVideo = null;
    }
  }

  window.__katBridge = { save: requestSave, open: requestOpen, saveVideo: saveVideo };

  window.addEventListener("message", function (event) {
    if (event.origin !== PARENT_ORIGIN) return; // only obey the KAT page that framed us
    var data = event.data;
    if (!data || typeof data !== "object") return;
    if (data.type === SCRATCH_MSG.LOAD) void load(data.projectUrl || null);
    else if (data.type === SCRATCH_MSG.SAVE) void save(data.uploadUrl, data.key);
    else if (data.type === SCRATCH_MSG.VIDEO_UPLOAD_URL) void putVideo(data.uploadUrl, data.key);
    else if (data.type === SCRATCH_MSG.VIDEO_UPLOAD_DENIED) {
      pendingVideo = null;
      toast((data.message || "Could not save the recording.") + "", true);
      reportVideoResult(false, data.message || null);
    }
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
