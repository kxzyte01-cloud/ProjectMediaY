"use strict";

const $ = (id) => document.getElementById(id);

const video = $("sourceVideo");
const canvasElement = $("overlayCanvas");
const previewFrame = $("previewFrame");
const emptyState = $("emptyState");
const mediaInput = $("mediaInput");
const playhead = $("playhead");
const status = $("status");

const state = {
  media: [],
  selected: null,
  duration: 0,
  currentTime: 0,
  clips: [],
  overlays: [],
  tracks: 3,
  lastScrub: 0,
  scrubFrame: 0,
  db: null,
  history: [],
  historyIndex: -1,
  projectId: "default",
  exporting: false
};

let fabricCanvas = null;
let saveTimer = null;
let scrubbing = false;

function setStatus(message) {
  status.textContent = message;
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function createId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

// Local database: media blobs survive removal from the gallery.
if (window.Dexie) {
  state.db = new Dexie("ProjectMediaY");
  state.db.version(1).stores({
    projects: "id, updatedAt",
    media: "id, projectId, name"
  });

  state.db.open().then(() => {
    setStatus("Local project storage ready.");
  }).catch((error) => {
    console.error(error);
    setStatus("Local storage unavailable. Projects may not persist.");
  });
} else {
  setStatus("Database library unavailable. Check your connection.");
}

// Fabric manages the text and graphic overlay layer.
function initCanvas() {
  if (!window.fabric) {
    setStatus("Canvas library unavailable. Check your connection.");
    return;
  }

  fabricCanvas = new fabric.Canvas("overlayCanvas", {
    selection: true,
    preserveObjectStacking: true,
    stopContextMenu: true,
    fireRightClick: false
  });

  resizeCanvas();
}

function resizeCanvas() {
  if (!fabricCanvas) return;

  const rect = previewFrame.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));

  fabricCanvas.setDimensions({ width, height });
  fabricCanvas.calcOffset();
  fabricCanvas.requestRenderAll();
}

if ("ResizeObserver" in window) {
  new ResizeObserver(resizeCanvas).observe(previewFrame);
} else {
  window.addEventListener("resize", resizeCanvas);
}

function updateAspectRatio() {
  const value = $("aspectRatio").value;
  previewFrame.style.aspectRatio = value.replace(":", " / ");
  resizeCanvas();
}

$("aspectRatio").addEventListener("change", updateAspectRatio);

function setTimeDisplay() {
  $("timeDisplay").textContent =
    `${formatTime(video.currentTime)} / ${formatTime(video.duration)}`;

  if (!scrubbing && Number.isFinite(video.duration) && video.duration > 0) {
    playhead.value = String(Math.round(video.currentTime / video.duration * 1000));
  }
}

function updatePlayButton() {
  $("playBtn").textContent = video.paused ? "▶" : "Ⅱ";
  $("playBtn").setAttribute("aria-label", video.paused ? "Play" : "Pause");
}

$("playBtn").addEventListener("click", async () => {
  if (!video.src) {
    setStatus("Import a video first.");
    return;
  }

  try {
    if (video.paused) await video.play();
    else video.pause();
  } catch (error) {
    console.error(error);
    setStatus("Playback failed. Try importing the video again.");
  }
});

video.addEventListener("play", updatePlayButton);
video.addEventListener("pause", updatePlayButton);
video.addEventListener("timeupdate", () => {
  setTimeDisplay();
  renderTimedOverlays();
});
video.addEventListener("loadedmetadata", () => {
  state.duration = video.duration;
  setTimeDisplay();
  updatePlayButton();
  setStatus("Video loaded. Ready to edit.");
});
video.addEventListener("ended", updatePlayButton);
video.addEventListener("error", () => {
  setStatus("Unable to play this video format in your browser.");
});

function revokeMediaUrl(item) {
  if (item && item.url && item.url.startsWith("blob:")) {
    URL.revokeObjectURL(item.url);
  }
}

function createClip(item, lane) {
  const clip = document.createElement("button");
  clip.type = "button";
  clip.className = "clip " +
    (item.kind === "video" ? "video-clip" :
      item.kind === "audio" ? "audio-clip" : "");

  clip.textContent = item.name;
  clip.title = item.name;
  clip.dataset.mediaId = item.id;
  clip.addEventListener("click", () => selectMedia(item.id));

  lane.querySelector(".empty-track")?.remove();
  lane.appendChild(clip);
}

function selectMedia(id) {
  const item = state.media.find((media) => media.id === id);
  if (!item) return;

  state.selected = id;

  if (item.kind === "video") {
    video.src = item.url;
    video.style.display = "block";
    emptyState.hidden = true;
    video.load();
  } else if (item.kind === "image") {
    addImageOverlay(item.url, item.name);
  } else if (item.kind === "audio") {
    setStatus("Audio imported. Audio mixing is not implemented yet.");
  }
}

function importFiles(files) {
  const list = Array.from(files || []);
  if (!list.length) return;

  for (const file of list) {
    const type = file.type || "";
    let kind = "";

    if (type.startsWith("video/")) kind = "video";
    else if (type.startsWith("image/")) kind = "image";
    else if (type.startsWith("audio/")) kind = "audio";

    if (!kind) {
      setStatus(`Unsupported file: ${file.name}`);
      continue;
    }

    const item = {
      id: createId(),
      name: file.name,
      kind,
      type: file.type,
      size: file.size,
      url: URL.createObjectURL(file),
      file,
      start: 0,
      end: 0
    };

    state.media.push(item);

    if (kind === "video") createClip(item, $("videoLane"));
    else if (kind === "audio") createClip(item, $("audioLane"));
    else createClip(item, $("overlayLane"));

    if (state.db) {
      state.db.media.put({
        id: item.id,
        projectId: state.projectId,
        name: file.name,
        kind,
        type: file.type,
        blob: file
      }).catch((error) => {
        console.error(error);
        setStatus("Media imported, but local database saving failed.");
      });
    }
  }

  const firstPlayable = state.media.find((item) => item.kind === "video");
  if (firstPlayable && !video.src) selectMedia(firstPlayable.id);

  mediaInput.value = "";
  scheduleSave();
}

mediaInput.addEventListener("change", () => importFiles(mediaInput.files));

$("importBtn").addEventListener("click", () => mediaInput.click());
$("pipBtn").addEventListener("click", () => mediaInput.click());

function addImageOverlay(url, name) {
  if (!fabricCanvas) return;

  fabric.Image.fromURL(url, (image) => {
    if (!image) {
      setStatus("Could not load the image overlay.");
      return;
    }

    const maxWidth = fabricCanvas.getWidth() * 0.45;
    const maxHeight = fabricCanvas.getHeight() * 0.45;
    const scale = Math.min(
      maxWidth / image.width,
      maxHeight / image.height,
      1
    );

    image.set({
      left: 20,
      top: 20,
      scaleX: scale,
      scaleY: scale,
      selectable: true,
      objectCaching: false
    });

    image.mediaName = name;
    fabricCanvas.add(image);
    fabricCanvas.setActiveObject(image);
    fabricCanvas.requestRenderAll();
    recordHistory();
    setStatus("Image overlay added. Drag it to position.");
  }, { crossOrigin: "anonymous" });
}

$("textBtn").addEventListener("click", () => {
  if (!fabricCanvas) return;

  const input = $("textInput");
  input.hidden = false;
  input.value = "";
  input.placeholder = "Enter caption";
  input.focus();

  input.onkeydown = (event) => {
    if (event.key === "Enter") {
      const text = input.value.trim();
      if (!text) return;

      const caption = new fabric.Textbox(text, {
        left: 20,
        top: 30,
        width: Math.min(240, fabricCanvas.getWidth() - 30),
        fontFamily: "DM Sans",
        fontSize: 26,
        fontWeight: "bold",
        fill: "#ffffff",
        stroke: "#000000",
        strokeWidth: 0.6,
        shadow: "rgba(0,0,0,0.65) 1px 2px 4px",
        editable: true,
        objectCaching: false
      });

      caption.startTime = video.currentTime;
      caption.endTime = video.duration || Infinity;

      fabricCanvas.add(caption);
      fabricCanvas.setActiveObject(caption);
      fabricCanvas.requestRenderAll();

      state.overlays.push({
        id: createId(),
        text,
        start: caption.startTime,
        end: caption.endTime
      });

      input.hidden = true;
      recordHistory();
      scheduleSave();
      setStatus("Caption added. Drag it to position.");
    }

    if (event.key === "Escape") input.hidden = true;
  };
});

function renderTimedOverlays() {
  if (!fabricCanvas) return;

  const time = video.currentTime;
  fabricCanvas.getObjects().forEach((object) => {
    if (object.startTime === undefined) return;
    object.visible = time >= object.startTime && time <= object.endTime;
  });

  fabricCanvas.requestRenderAll();
}

function recordHistory() {
  if (!fabricCanvas) return;

  const snapshot = JSON.stringify(fabricCanvas.toJSON([
    "startTime", "endTime", "mediaName"
  ]));

  state.history = state.history.slice(0, state.historyIndex + 1);
  state.history.push(snapshot);

  if (state.history.length > 30) state.history.shift();
  state.historyIndex = state.history.length - 1;
}

function restoreHistory(index) {
  if (!fabricCanvas || index < 0 || index >= state.history.length) return;

  state.historyIndex = index;
  fabricCanvas.loadFromJSON(state.history[index], () => {
    resizeCanvas();
    fabricCanvas.requestRenderAll();
  });
}

$("undoBtn").addEventListener("click", () => {
  if (state.historyIndex > 0) restoreHistory(state.historyIndex - 1);
  else setStatus("Nothing to undo.");
});

$("redoBtn").addEventListener("click", () => {
  if (state.historyIndex < state.history.length - 1) {
    restoreHistory(state.historyIndex + 1);
  } else {
    setStatus("Nothing to redo.");
  }
});

$("deleteBtn").addEventListener("click", () => {
  if (!fabricCanvas) return;

  const active = fabricCanvas.getActiveObject();
  if (active) {
    fabricCanvas.remove(active);
    fabricCanvas.discardActiveObject();
    fabricCanvas.requestRenderAll();
    recordHistory();
    scheduleSave();
    setStatus("Selected overlay deleted.");
    return;
  }

  if (state.selected) {
    const item = state.media.find((media) => media.id === state.selected);
    if (item) {
      setStatus("Media removal is not implemented yet. Your saved media is safe.");
      return;
    }
  }

  setStatus("Select a text or image overlay first.");
});

$("splitBtn").addEventListener("click", () => {
  if (!video.src || !Number.isFinite(video.currentTime)) {
    setStatus("Import a video first.");
    return;
  }

  const item = state.media.find((media) => media.id === state.selected);
  if (!item || item.kind !== "video") {
    setStatus("Select a video clip before splitting.");
    return;
  }

  if (video.currentTime <= 0 || video.currentTime >= video.duration) {
    setStatus("Move the playhead inside the video to split it.");
    return;
  }

  state.clips.push({
    id: createId(),
    mediaId: item.id,
    start: 0,
    end: video.currentTime
  }, {
    id: createId(),
    mediaId: item.id,
    start: video.currentTime,
    end: video.duration
  });

  setStatus("Split point recorded. Separate clip playback and export are not implemented yet.");
  scheduleSave();
});

$("trimBtn").addEventListener("click", () => {
  setStatus("Trim UI is not implemented yet. Use split-point markers for now.");
});

function seekTo(value) {
  if (!Number.isFinite(video.duration) || video.duration <= 0) return;
  video.currentTime = Math.max(0, Math.min(1, value / 1000)) * video.duration;
  setTimeDisplay();
}

playhead.addEventListener("input", () => {
  scrubbing = true;
  const now = performance.now();

  if (now - state.lastScrub >= 40) {
    state.lastScrub = now;
    seekTo(Number(playhead.value));
  } else if (!state.scrubFrame) {
    state.scrubFrame = requestAnimationFrame(() => {
      state.scrubFrame = 0;
      state.lastScrub = performance.now();
      seekTo(Number(playhead.value));
    });
  }
});

playhead.addEventListener("change", () => {
  scrubbing = false;
  seekTo(Number(playhead.value));
});

function getProjectData() {
  return {
    id: state.projectId,
    updatedAt: Date.now(),
    media: state.media.map(({ id, name, kind, type, size }) => ({
      id, name, kind, type, size
    })),
    clips: state.clips,
    overlays: state.overlays,
    canvas: fabricCanvas ? fabricCanvas.toJSON([
      "startTime", "endTime", "mediaName"
    ]) : null,
    aspectRatio: $("aspectRatio").value
  };
}

async function saveProject() {
  if (!state.db) {
    setStatus("Local database unavailable. Project state not saved.");
    return;
  }

  try {
    await state.db.projects.put(getProjectData());
    setStatus("Project saved on this device.");
  } catch (error) {
    console.error(error);
    setStatus("Could not save the project. Check device storage.");
  }
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveProject, 500);
}

$("saveBtn").addEventListener("click", saveProject);

async function loadProject() {
  if (!state.db) return;

  try {
    await state.db.open();
    const project = await state.db.projects.get(state.projectId);
    if (!project) return;

    state.clips = project.clips || [];
    state.overlays = project.overlays || [];
    $("aspectRatio").value = project.aspectRatio || "9:16";
    updateAspectRatio();

    if (project.canvas && fabricCanvas) {
      fabricCanvas.loadFromJSON(project.canvas, () => {
        resizeCanvas();
        fabricCanvas.requestRenderAll();
      });
    }

    const savedMedia = await state.db.media
      .where("projectId").equals(state.projectId).toArray();

    for (const saved of savedMedia) {
      if (!saved.blob || state.media.some((item) => item.id === saved.id)) continue;

      const item = {
        id: saved.id,
        name: saved.name,
        kind: saved.kind,
        type: saved.type,
        size: saved.blob.size,
        file: saved.blob,
        url: URL.createObjectURL(saved.blob)
      };

      state.media.push(item);

      if (item.kind === "video") createClip(item, $("videoLane"));
      else if (item.kind === "audio") createClip(item, $("audioLane"));
      else createClip(item, $("overlayLane"));
    }

    setStatus("Saved project restored.");
  } catch (error) {
    console.error(error);
    setStatus("Could not restore the saved project.");
  }
}

$("exportBtn").addEventListener("click", () => {
  setStatus("Video export is not implemented yet. No export file has been created.");
});

initCanvas();
recordHistory();

if (state.db) {
  state.db.open().then(loadProject).catch((error) => {
    console.error(error);
  });
    }
    
