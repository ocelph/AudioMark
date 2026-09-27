import { useState, useEffect, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { auth, db } from "../services/firebase";
import { doc, getDoc, collection, addDoc, updateDoc, deleteDoc, serverTimestamp, onSnapshot, query, orderBy } from "firebase/firestore";
import WaveSurfer from "wavesurfer.js";
import RegionsPlugin from "wavesurfer.js/dist/plugins/regions.js";
import Spectrogram from "wavesurfer.js/dist/plugins/spectrogram.js";
import { Download, History, Share2, Maximize2, Search, Plus, X, Pencil, Trash2, ZoomIn, ZoomOut } from "lucide-react";

// Built-in annotation class choices.
// Project-level custom labels are created and selected through the Custom Label modal.
const DEFAULT_CLASSES = [
  { name: "Default Label", color: "#22c55e" },
  { name: "Custom Label", color: "#3b82f6" },
  { name: "Miscellaneous", color: "#f97316" },
];
const PALETTE = ["#a855f7", "#ec4899", "#14b8a6", "#eab308", "#ef4444", "#06b6d4"];

// Fixed zoom steps make Zoom In / Zoom Out deterministic.
// 1 = Fit the entire recording to the available width.
const ZOOM_LEVELS = [1, 1.5, 2, 3, 4, 6, 8];

const formatTimestamp = (seconds) => {
  const safeSeconds = Number.isFinite(Number(seconds)) ? Math.max(0, Number(seconds)) : 0;
  const totalMilliseconds = Math.round(safeSeconds * 1000);
  const hours = Math.floor(totalMilliseconds / 3600000);
  const minutes = Math.floor((totalMilliseconds % 3600000) / 60000);
  const secs = Math.floor((totalMilliseconds % 60000) / 1000);
  const milliseconds = totalMilliseconds % 1000;

  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(milliseconds).padStart(3, "0")}`;
};

const splitTimestamp = (seconds) => {
  const safeSeconds = Number.isFinite(Number(seconds)) ? Math.max(0, Number(seconds)) : 0;
  const totalMilliseconds = Math.round(safeSeconds * 1000);

  return {
    hours: Math.floor(totalMilliseconds / 3600000),
    minutes: Math.floor((totalMilliseconds % 3600000) / 60000),
    seconds: Math.floor((totalMilliseconds % 60000) / 1000),
    milliseconds: totalMilliseconds % 1000,
  };
};

function TimestampInput({ label, value, onChange, hasError = false }) {
  const parts = splitTimestamp(value);

  const updatePart = (part, rawValue) => {
    let nextValue = Number.parseInt(rawValue, 10);
    if (!Number.isFinite(nextValue)) nextValue = 0;

    if (part === "hours") nextValue = Math.max(0, nextValue);
    if (part === "minutes" || part === "seconds") nextValue = Math.min(59, Math.max(0, nextValue));
    if (part === "milliseconds") nextValue = Math.min(999, Math.max(0, nextValue));

    const next = { ...parts, [part]: nextValue };
    const totalSeconds =
      next.hours * 3600 +
      next.minutes * 60 +
      next.seconds +
      next.milliseconds / 1000;

    onChange(Number(totalSeconds.toFixed(3)));
  };

  const inputClass = `min-w-0 rounded-md border bg-white px-1 py-1.5 text-center text-sm tabular-nums outline-none focus:ring-2 focus:ring-indigo-300 ${hasError ? "border-red-400" : "border-slate-200"
    }`;

  return (
    <div>
      <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-400">{label}</label>
      <div className="grid grid-cols-[1fr_auto_1fr_auto_1fr_auto_1.25fr] items-center gap-1">
        <input
          aria-label={`${label} hours`}
          title="Hours"
          type="number"
          min="0"
          value={parts.hours}
          onChange={(e) => updatePart("hours", e.target.value)}
          className={inputClass}
        />
        <span className="text-slate-400">:</span>
        <input
          aria-label={`${label} minutes`}
          title="Minutes"
          type="number"
          min="0"
          max="59"
          value={parts.minutes}
          onChange={(e) => updatePart("minutes", e.target.value)}
          className={inputClass}
        />
        <span className="text-slate-400">:</span>
        <input
          aria-label={`${label} seconds`}
          title="Seconds"
          type="number"
          min="0"
          max="59"
          value={parts.seconds}
          onChange={(e) => updatePart("seconds", e.target.value)}
          className={inputClass}
        />
        <span className="text-slate-400">.</span>
        <input
          aria-label={`${label} milliseconds`}
          title="Milliseconds"
          type="number"
          min="0"
          max="999"
          value={parts.milliseconds}
          onChange={(e) => updatePart("milliseconds", e.target.value)}
          className={inputClass}
        />
      </div>
      <div className="mt-1 grid grid-cols-4 gap-2 text-center text-[10px] uppercase tracking-wide text-slate-400">
        <span>HH</span><span>MM</span><span>SS</span><span>MS</span>
      </div>
    </div>
  );
}

const getInitials = (nameOrEmail) => {
  if (!nameOrEmail) return "U";
  const base = nameOrEmail.includes("@") ? nameOrEmail.split("@")[0] : nameOrEmail;
  return base.slice(0, 2).toUpperCase();
};

// Shared validation for both the manual "create" form and the "edit" form.
// Checks required fields, a valid time range, length limits, and one hard
// edge case (exact duplicate time range — blocked).
const validateAnnotationFields = ({ label, start, end, comment }, { annotations, excludeId }) => {
  const errors = {};
  const trimmedLabel = (label || "").trim();

  if (!trimmedLabel) errors.label = "Label is required";
  else if (trimmedLabel.length > 100) errors.label = "Label must be under 100 characters";

  if (!Number.isFinite(start) || start < 0) errors.start = "Start time must be 0 or greater";
  if (!Number.isFinite(end) || end <= start) errors.end = "End time must be greater than start time";

  if (comment && comment.trim().length > 500) errors.comment = "Comment must be under 500 characters";

  if (!errors.start && !errors.end) {
    const duplicate = annotations.some(
      (a) => a.id !== excludeId && a.startTime === start && a.endTime === end
    );
    if (duplicate) errors.end = "An annotation with this exact time range already exists";
  }

  return errors;
};

// Soft edge case — overlapping ranges are allowed, but we warn about them.
const findOverlap = (annotations, start, end, excludeId) =>
  annotations.find((a) => a.id !== excludeId && start < a.endTime && end > a.startTime);

export default function AnnotationPage() {
  const { projectId } = useParams();
  const navigate = useNavigate();

  const [uid, setUid] = useState(null);
  const [userInitials, setUserInitials] = useState("U");
  const [audioUrl, setAudioUrl] = useState(null);
  const [fileName, setFileName] = useState("");
  const [annotations, setAnnotations] = useState([]);
  const [selectedAnnotation, setSelectedAnnotation] = useState(null);
  const [isEditing, setIsEditing] = useState(false);
  const [editLabel, setEditLabel] = useState("");
  const [editAnnotationClass, setEditAnnotationClass] = useState(null);
  const [editStart, setEditStart] = useState(0);
  const [editEnd, setEditEnd] = useState(0);
  const [editComment, setEditComment] = useState("");
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [annotationToDelete, setAnnotationToDelete] = useState(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [audioReady, setAudioReady] = useState(false);
  const [waveformError, setWaveformError] = useState("");

  // Shared waveform/spectrogram synchronisation state.
  const [activeSelection, setActiveSelection] = useState(null);

  // Professional zoom model:
  // 1x = fit the entire audio into the current waveform width.
  // Higher values zoom relative to that fitted width, regardless of audio length or screen size.
  const [zoomLevel, setZoomLevel] = useState(1);
  const [appliedPxPerSec, setAppliedPxPerSec] = useState(0);
  const [visibleRange, setVisibleRange] = useState({ start: 0, end: 0 });

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const waveformRef = useRef(null);
  const spectrogramRef = useRef(null);
  const spectrogramViewportRef = useRef(null);
  const wavesurferRef = useRef(null);
  const regionsRef = useRef(null);
  const activeRegionRef = useRef(null);
  const syncingRegionRef = useRef(false);
  const editingRegionRef = useRef(false);

  // Annotation class selection.
  // Default and Miscellaneous are built-in classes.
  // Custom labels are stored per project in Firestore and selected through a modal.
  const [selectedClassType, setSelectedClassType] = useState("Default Label");
  const [classSearch, setClassSearch] = useState("");
  const [customLabels, setCustomLabels] = useState([]);
  const [selectedCustomLabelId, setSelectedCustomLabelId] = useState("");
  const [showCustomLabelModal, setShowCustomLabelModal] = useState(false);
  const [customLabelModalMode, setCustomLabelModalMode] = useState("create");
  const [customLabelSearch, setCustomLabelSearch] = useState("");
  const [newLabelName, setNewLabelName] = useState("");
  const [customLabelError, setCustomLabelError] = useState("");
  const [isCreatingLabel, setIsCreatingLabel] = useState(false);
  const [createStart, setCreateStart] = useState(0);
  const [createEnd, setCreateEnd] = useState(0);
  const [createComment, setCreateComment] = useState("");
  const [createErrors, setCreateErrors] = useState({});
  const [createWarning, setCreateWarning] = useState("");
  const [editErrors, setEditErrors] = useState({});
  const [editWarning, setEditWarning] = useState("");
  const [leftWidth, setLeftWidth] = useState(280);
  const [rightWidth, setRightWidth] = useState(320);
  const resizingRef = useRef(null); // "left" | "right" | null

  // Load project (the project doc doubles as the "file" — one project = one recording)
  useEffect(() => {
    const loadProject = async () => {
      try {
        const user = auth.currentUser;
        if (!user) {
          navigate("/login");
          return;
        }
        const projectSnap = await getDoc(doc(db, "users", user.uid, "projects", projectId));
        if (projectSnap.exists()) {
          const data = projectSnap.data();
          setFileName(data.project_title);
          setAudioUrl(data.download_url);
          setUid(user.uid);
          setUserInitials(getInitials(user.displayName || user.email));
        } else {
          setError("Project not found.");
        }
      } catch (err) {
        console.error("Error loading project:", err);
        setError("Failed to load project.");
      } finally {
        setLoading(false);
      }
    };
    loadProject();
  }, [projectId, navigate]);

  // Load annotations in real time (only once we know the uid)
  useEffect(() => {
    if (!uid) return;
    const q = query(
      collection(db, "users", uid, "projects", projectId, "annotations"),
      orderBy("createdAt", "asc")
    );
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const data = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
      setAnnotations(data);
    });
    return () => unsubscribe();
  }, [uid, projectId]);

  // Load project-level custom labels in real time.
  useEffect(() => {
    if (!uid) return;

    const labelsRef = collection(db, "users", uid, "projects", projectId, "labels");
    const unsubscribe = onSnapshot(
      labelsRef,
      (snapshot) => {
        const labels = snapshot.docs
          .map((d) => ({ id: d.id, ...d.data() }))
          .sort((a, b) => (a.name || "").localeCompare(b.name || ""));

        setCustomLabels(labels);

      },
      (err) => {
        console.error("Failed to load custom labels:", err);
      }
    );

    return () => unsubscribe();
  }, [uid, projectId]);

  // Initialise one shared WaveSurfer instance for both visualisations.
  // The spectrogram uses the same audio/timeline. 
  // Region overlays, zoom and scrolling are also mirrored so the two panes behave as one linked view.
  useEffect(() => {
    if (!audioUrl || !waveformRef.current || !spectrogramRef.current || !uid) return;

    setAudioReady(false);
    setWaveformError("");
    setCurrentTime(0);
    setDuration(0);
    setZoomLevel(1);
    setAppliedPxPerSec(0);

    const regions = RegionsPlugin.create();
    const spectrogram = Spectrogram.create({
      container: spectrogramRef.current,
      labels: true,
      height: 180,
    });

    const ws = WaveSurfer.create({
      container: waveformRef.current,
      waveColor: "rgba(99, 102, 241, 0.4)",
      progressColor: "#6366f1",
      cursorColor: "#1e1b4b",
      cursorWidth: 2,
      height: 130,
      barWidth: 2,
      barGap: 1,
      barRadius: 3,
      normalize: true,
      interact: true,
      minPxPerSec: 0,
      url: audioUrl, // Valid Firebase Storage audio URL
      // url: "/sample.wav", // Test with local sample audio
      // url: "/this-file-does-not-exist.wav", // Test with an invalid audio URL
      plugins: [regions, spectrogram],
    });

    wavesurferRef.current = ws;

    regionsRef.current = regions;

    const unsubReady = ws.on("ready", (loadedDuration) => {
      setDuration(loadedDuration);
      setCurrentTime(0);
      setAudioReady(true);
      setVisibleRange({ start: 0, end: loadedDuration });

      // Calculate the fitted scale dynamically. This makes "1x" mean
      // "show the entire recording", even for very short files or very wide screens.
      // Use the stable outer viewport width. Do not use WaveSurfer's internal
      // wrapper width as the zoom baseline because that width changes with zoom.
      const viewportWidth =
        waveformRef.current?.getBoundingClientRect().width ||
        waveformRef.current?.clientWidth ||
        1;
      const fitPxPerSec = loadedDuration > 0 ? viewportWidth / loadedDuration : 0;

      setZoomLevel(1);
      setAppliedPxPerSec(fitPxPerSec);

      if (fitPxPerSec > 0) {
        ws.zoom(fitPxPerSec);
      }

      // Same WaveSurfer v7 pattern used in the standalone prototype:
      // Drag across the waveform to create an annotation region.
      regions.enableDragSelection({
        color: "rgba(99, 102, 241, 0.25)",
      });
    });

    const unsubTime = ws.on("timeupdate", (time) => {
      setCurrentTime(time);
    });

    // Keep track of the visible time window while zooming/scrolling.
    const unsubScroll = ws.on("scroll", (visibleStartTime, visibleEndTime) => {
      setVisibleRange({
        start: Number.isFinite(visibleStartTime) ? visibleStartTime : 0,
        end: Number.isFinite(visibleEndTime) ? visibleEndTime : ws.getDuration(),
      });

      // Mirror WaveSurfer's horizontal scroll position into the spectrogram
      // viewport. The spectrogram content uses the same pixel-per-second width,
      // so both views remain horizontally aligned while zoomed.
      const waveWrapper = ws.getWrapper?.();
      if (waveWrapper && spectrogramViewportRef.current) {
        spectrogramViewportRef.current.scrollLeft = waveWrapper.scrollLeft;
      }
    });

    const syncFormFromRegion = (region) => {
      if (!region || syncingRegionRef.current) return;

      activeRegionRef.current = region;

      const start = Number(region.start.toFixed(3));
      const end = Number(region.end.toFixed(3));

      setActiveSelection({ start, end });

      if (editingRegionRef.current) {
        setEditStart(start);
        setEditEnd(end);
        setEditErrors((prev) => ({ ...prev, start: undefined, end: undefined }));
      } else {
        setCreateStart(start);
        setCreateEnd(end);
        setCreateErrors((prev) => ({ ...prev, start: undefined, end: undefined }));
      }
    };

    const unsubRegionCreated = regions.on("region-created", (region) => {
      // New-annotation mode keeps one active selection. 
      // If the user drags a second region, discard the previous temporary selection.
      const previous = activeRegionRef.current;
      if (previous && previous !== region) {
        previous.remove();
      }

      syncFormFromRegion(region);
    });

    const unsubRegionClicked = regions.on("region-clicked", (region, event) => {
      event?.stopPropagation?.();
      syncFormFromRegion(region);
    });

    const unsubRegionUpdated = regions.on("region-updated", (region) => {
      syncFormFromRegion(region);
    });

    const unsubPlay = ws.on("play", () => setIsPlaying(true));
    const unsubPause = ws.on("pause", () => setIsPlaying(false));
    const unsubFinish = ws.on("finish", () => {
      setIsPlaying(false);
      setCurrentTime(ws.getDuration());
    });

    const unsubError = ws.on("error", (err) => {
      console.error("WaveSurfer failed to load audio:", err);
      setAudioReady(false);
      setWaveformError("Unable to load this audio file. The file may be corrupted or use an unsupported audio format or codec.");
    });

    return () => {
      unsubReady?.();
      unsubTime?.();
      unsubScroll?.();
      unsubRegionCreated?.();
      unsubRegionClicked?.();
      unsubRegionUpdated?.();
      unsubPlay?.();
      unsubPause?.();
      unsubFinish?.();
      unsubError?.();
      activeRegionRef.current = null;
      setActiveSelection(null);
      regionsRef.current = null;
      wavesurferRef.current = null;
      ws.destroy();
    };
  }, [audioUrl, uid]);

  const handleStopPlayback = () => {
    const ws = wavesurferRef.current;
    if (!ws) return;

    ws.pause();
    ws.setTime(0);
    setCurrentTime(0);
    setIsPlaying(false);
  };

  const applyZoomLevel = (level) => {
    const ws = wavesurferRef.current;
    if (!ws || !audioReady || duration <= 0) return;

    const wrapper = ws.getWrapper?.();
    if (!wrapper) return;

    // Calculate Fit from the OUTER React container, not WaveSurfer's internal wrapper.
    // The internal wrapper/canvas changes width after zooming, which caused:
    // Fit -> 1.5x -> Zoom Out to remain visually zoomed in.

    // waveformRef.current is the stable viewport width available on the page.
    const viewportWidth =
      waveformRef.current?.getBoundingClientRect().width ||
      waveformRef.current?.clientWidth ||
      1;

    const fitPxPerSec = viewportWidth / duration;
    const nextPxPerSec = fitPxPerSec * level;

    setAppliedPxPerSec(nextPxPerSec);
    ws.zoom(nextPxPerSec);

    // WaveSurfer redraws asynchronously.
    // Correct the scroll position only after the new zoom width has been applied.
    requestAnimationFrame(() => {
      const updatedWrapper = ws.getWrapper?.();
      if (!updatedWrapper) return;

      if (level === 1) {
        // Fit = whole recording, starting at time zero.
        updatedWrapper.scrollLeft = 0;

        if (spectrogramViewportRef.current) {
          spectrogramViewportRef.current.scrollLeft = 0;
        }

        setVisibleRange({ start: 0, end: duration });
        return;
      }

      // When zooming OUT from a larger view, the old scrollLeft may be outside the new smaller scrollable range.
      // Clamp it so the viewport remains valid.
      const maxScrollLeft = Math.max(
        0,
        updatedWrapper.scrollWidth - updatedWrapper.clientWidth
      );

      const nextScrollLeft = Math.min(
        updatedWrapper.scrollLeft,
        maxScrollLeft
      );

      updatedWrapper.scrollLeft = nextScrollLeft;

      if (spectrogramViewportRef.current) {
        spectrogramViewportRef.current.scrollLeft = nextScrollLeft;
      }
    });
  };

  const handleZoomIn = () => {
    const currentIndex = ZOOM_LEVELS.indexOf(zoomLevel);
    const nextIndex =
      currentIndex === -1
        ? 1
        : Math.min(currentIndex + 1, ZOOM_LEVELS.length - 1);

    const nextLevel = ZOOM_LEVELS[nextIndex];
    setZoomLevel(nextLevel);
    applyZoomLevel(nextLevel);
  };

  const handleZoomOut = () => {
    const currentIndex = ZOOM_LEVELS.indexOf(zoomLevel);
    const nextIndex =
      currentIndex <= 0
        ? 0
        : currentIndex - 1;

    const nextLevel = ZOOM_LEVELS[nextIndex];
    setZoomLevel(nextLevel);
    applyZoomLevel(nextLevel);
  };

  const clampToDuration = (time) => {
    const numeric = Number(time);
    if (!Number.isFinite(numeric)) return 0;
    if (duration > 0) return Math.min(Math.max(0, numeric), duration);
    return Math.max(0, numeric);
  };

  const updateActiveRegionFromTimestamps = (nextStart, nextEnd) => {
    const region = activeRegionRef.current;
    if (!region || !audioReady) return;

    const start = clampToDuration(nextStart);
    const end = clampToDuration(nextEnd);

    // Do not ask WaveSurfer to render an invalid/zero-length selection.
    if (end <= start) return;

    syncingRegionRef.current = true;
    region.setOptions({ start, end });
    syncingRegionRef.current = false;

    setActiveSelection({
      start: Number(start.toFixed(3)),
      end: Number(end.toFixed(3)),
    });
  };

  const handleCreateStartChange = (nextStart) => {
    const start = clampToDuration(nextStart);
    setCreateStart(start);
    setCreateErrors((prev) => ({ ...prev, start: undefined }));
    updateActiveRegionFromTimestamps(start, createEnd);
  };

  const handleCreateEndChange = (nextEnd) => {
    const end = clampToDuration(nextEnd);
    setCreateEnd(end);
    setCreateErrors((prev) => ({ ...prev, end: undefined }));
    updateActiveRegionFromTimestamps(createStart, end);
  };

  const handlePlaySelection = () => {
    const region = activeRegionRef.current;
    const ws = wavesurferRef.current;

    if (!region || !ws) {
      setCreateWarning("Drag across the waveform to select a region first.");
      return;
    }

    setCreateWarning("");

    ws.play(region.start, region.end);
  };

  useEffect(() => {
    const handleMouseMove = (e) => {
      if (resizingRef.current === "left") {
        setLeftWidth(Math.min(480, Math.max(220, e.clientX)));
      } else if (resizingRef.current === "right") {
        setRightWidth(Math.min(480, Math.max(260, window.innerWidth - e.clientX)));
      }
    };
    const handleMouseUp = () => {
      resizingRef.current = null;
    };
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, []);

  const selectedCustomLabel = customLabels.find(
    (label) => label.id === selectedCustomLabelId
  );

  const selectedAnnotationClass =
    selectedClassType === "Custom Label"
      ? selectedCustomLabel
        ? {
          id: selectedCustomLabel.id,
          name: selectedCustomLabel.name,
          color: selectedCustomLabel.color || "#3b82f6",
          type: "custom",
        }
        : null
      : {
        ...DEFAULT_CLASSES.find((item) => item.name === selectedClassType),
        type: "default",
      };

  const normalizedClassSearch = classSearch.trim().toLowerCase();
  const filteredDefaultClasses = DEFAULT_CLASSES.filter((annotationClass) =>
    annotationClass.name.toLowerCase().includes(normalizedClassSearch)
  );
  const filteredCustomLabels = normalizedClassSearch
    ? customLabels.filter((label) =>
      (label.name || "").toLowerCase().includes(normalizedClassSearch)
    )
    : [];

  const openCustomLabelModal = (mode = "create") => {
    setCustomLabelModalMode(mode);
    setCustomLabelSearch("");
    setNewLabelName("");
    setCustomLabelError("");
    setShowCustomLabelModal(true);
  };

  const closeCustomLabelModal = () => {
    if (isCreatingLabel) return;
    setShowCustomLabelModal(false);
    setCustomLabelSearch("");
    setNewLabelName("");
    setCustomLabelError("");
  };

  const handleSelectClassType = (className) => {
    setCreateErrors((prev) => ({ ...prev, label: undefined }));

    if (className === "Custom Label") {
      setSelectedClassType("Custom Label");
      openCustomLabelModal("create");
      return;
    }

    setSelectedClassType(className);
  };

  const handleSelectCustomLabel = (label) => {
    const annotationClass = {
      id: label.id,
      name: label.name,
      color: label.color || "#3b82f6",
      type: "custom",
    };

    if (customLabelModalMode === "edit") {
      setEditLabel(label.name);
      setEditAnnotationClass(annotationClass);
      setEditErrors((prev) => ({ ...prev, label: undefined }));
    } else {
      setSelectedClassType("Custom Label");
      setSelectedCustomLabelId(label.id);
      setCreateErrors((prev) => ({ ...prev, label: undefined }));
    }

    setShowCustomLabelModal(false);
    setCustomLabelSearch("");
    setNewLabelName("");
    setCustomLabelError("");
  };

  const handleCreateCustomLabel = async () => {
    if (!uid) return;

    const trimmed = newLabelName.trim();

    if (!trimmed) {
      setCustomLabelError("Enter a label name.");
      return;
    }

    if (trimmed.length > 100) {
      setCustomLabelError("Label must be under 100 characters.");
      return;
    }

    const duplicate = customLabels.some(
      (label) => (label.name || "").trim().toLowerCase() === trimmed.toLowerCase()
    );

    if (duplicate) {
      setCustomLabelError("A custom label with this name already exists.");
      return;
    }

    setIsCreatingLabel(true);
    setCustomLabelError("");

    try {
      const color = PALETTE[customLabels.length % PALETTE.length];
      const labelsRef = collection(db, "users", uid, "projects", projectId, "labels");

      const docRef = await addDoc(labelsRef, {
        name: trimmed,
        color,
        createdAt: serverTimestamp(),
      });

      // Select immediately; the real-time listener will populate the full list.
      const createdLabel = { id: docRef.id, name: trimmed, color };

      setCustomLabels((prev) =>
        [
          ...prev.filter((label) => label.id !== docRef.id),
          createdLabel,
        ].sort((a, b) => a.name.localeCompare(b.name))
      );

      if (customLabelModalMode === "edit") {
        setEditLabel(trimmed);
        setEditAnnotationClass({
          ...createdLabel,
          type: "custom",
        });
        setEditErrors((prev) => ({ ...prev, label: undefined }));
      } else {
        setSelectedClassType("Custom Label");
        setSelectedCustomLabelId(docRef.id);
        setCreateErrors((prev) => ({ ...prev, label: undefined }));
      }

      setShowCustomLabelModal(false);
      setCustomLabelSearch("");
      setNewLabelName("");
    } catch (err) {
      console.error("Failed to create custom label:", err);
      setCustomLabelError("Failed to create the label. Please try again.");
    } finally {
      setIsCreatingLabel(false);
    }
  };

  const handleCreateAnnotation = async () => {
    if (!uid) return;

    const start = parseFloat(createStart);
    const end = parseFloat(createEnd);
    const annotationClass = selectedAnnotationClass;
    const label = annotationClass?.name || "";

    const errors = validateAnnotationFields(
      { label, start, end, comment: createComment },
      { annotations, excludeId: null }
    );

    if (selectedClassType === "Custom Label" && !selectedCustomLabel) {
      errors.label = "Select or create a custom label.";
    }

    if (duration > 0) {
      if (start > duration) errors.start = "Start time cannot exceed the audio duration";
      if (end > duration) errors.end = "End time cannot exceed the audio duration";
    }

    setCreateErrors(errors);
    if (Object.keys(errors).length > 0) return;

    const overlap = findOverlap(annotations, start, end, null);
    setCreateWarning(overlap ? `Heads up — this overlaps with "${overlap.label}".` : "");

    try {
      await addDoc(collection(db, "users", uid, "projects", projectId, "annotations"), {
        startTime: start,
        endTime: end,
        label,
        annotationClass,
        comment: createComment.trim(),
        createdAt: serverTimestamp(),
      });

      setCreateStart(0);
      setCreateEnd(0);
      setCreateComment("");
      setCreateErrors({});
      setCreateWarning("");

      // The selected waveform region represented the annotation being created.
      // Clear it after the annotation has been saved successfully.
      activeRegionRef.current?.remove();
      activeRegionRef.current = null;
      setActiveSelection(null);
    } catch (err) {
      console.error("Failed to create annotation:", err);
    }
  };

  const handleEditStartChange = (nextStart) => {
    const start = clampToDuration(nextStart);
    setEditStart(start);
    setEditErrors((prev) => ({ ...prev, start: undefined }));
    updateActiveRegionFromTimestamps(start, editEnd);
  };

  const handleEditEndChange = (nextEnd) => {
    const end = clampToDuration(nextEnd);
    setEditEnd(end);
    setEditErrors((prev) => ({ ...prev, end: undefined }));
    updateActiveRegionFromTimestamps(editStart, end);
  };

  const showEditAnnotationRegion = (annotation) => {
    const regions = regionsRef.current;
    const ws = wavesurferRef.current;
    if (!regions || !ws || !audioReady || !annotation) return;

    const start = clampToDuration(annotation.startTime);
    const end = clampToDuration(annotation.endTime);
    if (end <= start) return;

    activeRegionRef.current?.remove();
    syncingRegionRef.current = true;
    editingRegionRef.current = true;

    const region = regions.addRegion({
      start,
      end,
      color: "rgba(99, 102, 241, 0.25)",
      drag: true,
      resize: true,
    });

    activeRegionRef.current = region;
    setActiveSelection({
      start: Number(start.toFixed(3)),
      end: Number(end.toFixed(3)),
    });

    syncingRegionRef.current = false;
    ws.setTime(start);
  };

  const handleEditOpen = (annotation) => {
    setSelectedAnnotation(annotation);
    setEditLabel(annotation.label);
    setEditAnnotationClass(
      annotation.annotationClass || {
        name: annotation.label,
        color: "#94a3b8",
        type: "default",
      }
    );
    setEditStart(annotation.startTime);
    setEditEnd(annotation.endTime);
    setEditComment(annotation.comment || "");
    setEditErrors({});
    setEditWarning("");
    editingRegionRef.current = true;
    setIsEditing(true);
    showEditAnnotationRegion(annotation);
  };

  const handleEditLabelChange = (value) => {
    if (value === "__custom__") {
      openCustomLabelModal("edit");
      return;
    }

    const builtInClass = DEFAULT_CLASSES.find(
      (annotationClass) => annotationClass.name === value
    );

    if (builtInClass && builtInClass.name !== "Custom Label") {
      setEditLabel(builtInClass.name);
      setEditAnnotationClass({
        ...builtInClass,
        type: "default",
      });
      setEditErrors((prev) => ({ ...prev, label: undefined }));
      return;
    }

    const customLabel = customLabels.find((label) => label.id === value);
    if (customLabel) {
      setEditLabel(customLabel.name);
      setEditAnnotationClass({
        id: customLabel.id,
        name: customLabel.name,
        color: customLabel.color || "#3b82f6",
        type: "custom",
      });
      setEditErrors((prev) => ({ ...prev, label: undefined }));
    }
  };

  // Now persists to Firestore, then updates what's shown in the panel.
  const handleSaveEdit = async () => {
    const start = parseFloat(editStart);
    const end = parseFloat(editEnd);

    const errors = validateAnnotationFields(
      { label: editLabel, start, end, comment: editComment },
      { annotations, excludeId: selectedAnnotation.id }
    );
    setEditErrors(errors);
    if (Object.keys(errors).length > 0) return;

    const overlap = findOverlap(annotations, start, end, selectedAnnotation.id);
    setEditWarning(overlap ? `Heads up — this overlaps with "${overlap.label}".` : "");

    try {
      await updateDoc(doc(db, "users", uid, "projects", projectId, "annotations", selectedAnnotation.id), {
        label: editLabel.trim(),
        annotationClass:
          editAnnotationClass || {
            name: editLabel.trim(),
            color: "#94a3b8",
            type: "default",
          },
        startTime: start,
        endTime: end,
        comment: editComment.trim(),
      });
      activeRegionRef.current?.remove();
      activeRegionRef.current = null;
      editingRegionRef.current = false;
      setActiveSelection(null);

      setSelectedAnnotation(null);
      setIsEditing(false);
      setEditErrors({});
      setEditWarning("");
    } catch (err) {
      console.error("Failed to update annotation:", err);
    }
  };

  const clearEditRegion = () => {
    activeRegionRef.current?.remove();
    activeRegionRef.current = null;
    editingRegionRef.current = false;
    setActiveSelection(null);
  };

  const handleCancelEdit = () => {
    clearEditRegion();
    setSelectedAnnotation(null);
    setIsEditing(false);
    setEditErrors({});
    setEditWarning("");
  };

  const handleClosePanel = () => {
    clearEditRegion();
    setSelectedAnnotation(null);
    setIsEditing(false);
    setEditErrors({});
    setEditWarning("");
  };

  const handleDeleteClick = (annotation) => {
    setAnnotationToDelete(annotation);
    setShowDeleteConfirm(true);
  };

  const handleConfirmDelete = async () => {
    try {
      await deleteDoc(doc(db, "users", uid, "projects", projectId, "annotations", annotationToDelete.id));
      if (selectedAnnotation?.id === annotationToDelete.id) {
        setSelectedAnnotation(null);
        setIsEditing(false);
      }
      setShowDeleteConfirm(false);
      setAnnotationToDelete(null);
    } catch (err) {
      console.error("Failed to delete annotation:", err);
    }
  };

  const handleCancelDelete = () => {
    setShowDeleteConfirm(false);
    setAnnotationToDelete(null);
  };

  if (loading) return (
    <div className="flex h-screen items-center justify-center bg-slate-50">
      <p className="text-slate-500">Loading audio file...</p>
    </div>
  );

  if (error) return (
    <div className="flex h-screen items-center justify-center bg-slate-50">
      <p className="text-red-500">{error}</p>
    </div>
  );

  return (
    <div className="flex h-screen flex-col bg-slate-50">
      {/* Top bar */}
      <div className="flex items-center justify-between border-b border-slate-200 bg-white px-6 py-3">
        <div className="flex items-center gap-4">
          <button
            onClick={() => navigate("/dashboard")}
            className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50 transition"
          >
            ← Dashboard
          </button>
          <h1 className="text-lg font-semibold text-slate-800">{fileName}</h1>
        </div>

        <div className="flex items-center gap-2 text-sm text-slate-500">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-indigo-100 text-xs font-semibold text-indigo-700">
            {userInitials}
          </div>
          <span>1 collaborator</span>
        </div>

        {/* Non-functional placeholders — separate tickets */}
        <div className="flex items-center gap-2">
          <button className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50 transition">
            <Download className="h-4 w-4" /> Download
          </button>
          <button className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50 transition">
            <History className="h-4 w-4" /> Log History
          </button>
          <button className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50 transition">
            <Share2 className="h-4 w-4" /> Share
          </button>
          <button className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50 transition">
            <Maximize2 className="h-4 w-4" /> Expand All Annotations
          </button>
        </div>
      </div>

      {/* Main content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left panel — create annotation */}
        <div style={{ width: leftWidth }} className="flex-shrink-0 overflow-y-auto border-r border-slate-200 bg-white px-4 py-4">
          <h2 className="mb-3 text-sm font-semibold text-slate-700">Timestamps</h2>
          <div className="mb-4 space-y-3">
            <TimestampInput
              label="Start"
              value={createStart}
              onChange={handleCreateStartChange}
              hasError={Boolean(createErrors.start)}
            />
            <TimestampInput
              label="End"
              value={createEnd}
              onChange={handleCreateEndChange}
              hasError={Boolean(createErrors.end)}
            />
          </div>
          {createErrors.start && <p className="mb-2 text-xs text-red-500">{createErrors.start}</p>}
          {createErrors.end && <p className="mb-2 text-xs text-red-500">{createErrors.end}</p>}

          <h2 className="mb-2 mt-2 text-sm font-semibold text-slate-700">Annotation Class</h2>

          <div className="mb-2 flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-2 py-1.5 focus-within:ring-2 focus-within:ring-indigo-200">
            <Search className="h-4 w-4 flex-shrink-0 text-slate-400" />
            <input
              value={classSearch}
              onChange={(e) => setClassSearch(e.target.value)}
              placeholder="Search or select label"
              className="w-full text-sm outline-none"
            />
            {classSearch && (
              <button
                type="button"
                onClick={() => setClassSearch("")}
                className="rounded p-0.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
                aria-label="Clear label search"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          <div className="mb-2 flex flex-col gap-1">
            {filteredDefaultClasses.map((annotationClass) => {
              const isSelected = selectedClassType === annotationClass.name;
              const customSummary =
                annotationClass.name === "Custom Label" && selectedCustomLabel
                  ? selectedCustomLabel.name
                  : null;

              return (
                <button
                  key={annotationClass.name}
                  type="button"
                  onClick={() => handleSelectClassType(annotationClass.name)}
                  className={`flex items-center justify-between gap-3 rounded-lg px-2 py-2 text-left text-sm transition ${isSelected
                    ? "bg-indigo-50 text-indigo-700"
                    : "text-slate-700 hover:bg-slate-50"
                    }`}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span
                      className="h-2.5 w-2.5 flex-shrink-0 rounded-full"
                      style={{
                        backgroundColor:
                          annotationClass.name === "Custom Label" && selectedCustomLabel
                            ? selectedCustomLabel.color || annotationClass.color
                            : annotationClass.color,
                      }}
                    />
                    <span>{annotationClass.name}</span>
                  </span>

                  {customSummary && (
                    <span className="max-w-[120px] truncate text-xs text-indigo-500">
                      {customSummary}
                    </span>
                  )}
                </button>
              );
            })}

            {filteredCustomLabels.map((label) => {
              const isSelected =
                selectedClassType === "Custom Label" && selectedCustomLabelId === label.id;

              return (
                <button
                  key={label.id}
                  type="button"
                  onClick={() => {
                    handleSelectCustomLabel(label);
                    setClassSearch("");
                  }}
                  className={`flex items-center justify-between gap-3 rounded-lg px-2 py-2 text-left text-sm transition ${isSelected
                    ? "bg-indigo-50 text-indigo-700"
                    : "text-slate-700 hover:bg-slate-50"
                    }`}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span
                      className="h-2.5 w-2.5 flex-shrink-0 rounded-full"
                      style={{ backgroundColor: label.color || "#3b82f6" }}
                    />
                    <span className="truncate">{label.name}</span>
                  </span>
                  <span className="text-[10px] uppercase tracking-wide text-slate-400">Custom</span>
                </button>
              );
            })}

            {normalizedClassSearch &&
              filteredDefaultClasses.length === 0 &&
              filteredCustomLabels.length === 0 && (
                <p className="px-2 py-2 text-xs text-slate-400">No matching labels.</p>
              )}
          </div>

          <button
            type="button"
            onClick={() => {
              setSelectedClassType("Custom Label");
              openCustomLabelModal("create");
            }}
            className="mb-3 flex w-full items-center justify-between gap-2 rounded-lg border border-dashed border-slate-300 bg-white px-3 py-2 text-sm text-slate-500 transition hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-600"
          >
            <span className="flex items-center gap-2">
              <Plus className="h-4 w-4" />
              Create New Label
            </span>
            <span className="flex h-7 w-7 items-center justify-center rounded-lg border border-slate-200 bg-white">
              <Plus className="h-4 w-4" />
            </span>
          </button>

          {selectedClassType === "Custom Label" && selectedCustomLabel && (
            <div
              className={`mb-4 rounded-lg border px-3 py-2 ${createErrors.label ? "border-red-300 bg-red-50" : "border-slate-200 bg-slate-50"
                }`}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[10px] font-medium uppercase tracking-wide text-slate-400">
                    Selected custom label
                  </p>
                  <div className="mt-1 flex items-center gap-2">
                    <span
                      className="h-2.5 w-2.5 flex-shrink-0 rounded-full"
                      style={{ backgroundColor: selectedCustomLabel.color || "#3b82f6" }}
                    />
                    <span className="truncate text-sm font-medium text-slate-700">
                      {selectedCustomLabel.name}
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => openCustomLabelModal("create")}
                  className="flex-shrink-0 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-600 transition hover:bg-slate-50"
                >
                  Change
                </button>
              </div>
            </div>
          )}

          {createErrors.label && (
            <p className="mb-2 text-xs text-red-500">{createErrors.label}</p>
          )}

          <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-400">Comments</label>
          <textarea
            value={createComment}
            onChange={(e) => setCreateComment(e.target.value)}
            rows={3}
            className={`mb-2 w-full rounded-lg border px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-indigo-300 ${createErrors.comment ? "border-red-400" : "border-slate-200"
              }`}
            placeholder="Add a note about this annotation..."
          />
          {createErrors.comment && <p className="mb-2 text-xs text-red-500">{createErrors.comment}</p>}
          {createWarning && <p className="mb-2 text-xs text-amber-600">{createWarning}</p>}

          <button
            onClick={handleCreateAnnotation}
            className="w-full rounded-lg bg-indigo-600 py-2 text-sm font-medium text-white hover:bg-indigo-700 transition"
          >
            Save Annotation
          </button>
          <p className="mt-2 text-xs text-slate-400">
            Drag across the waveform to populate the timestamps, then refine them here if needed.
          </p>
        </div>

        {/* Drag handle — resize left panel */}
        <div
          onMouseDown={() => (resizingRef.current = "left")}
          className="w-1.5 flex-shrink-0 cursor-col-resize bg-slate-100 hover:bg-indigo-200 transition"
        />

        {/* Center — waveform + annotation list */}
        <div className="flex flex-1 flex-col overflow-hidden">
          <div className="border-b border-slate-200 bg-white px-6 py-4">
            <div className="mb-3 flex items-center justify-between gap-4">
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
                  Audio visualisation
                </p>
                <p className="mt-1 text-sm text-slate-500">
                  Click to seek, or drag across the waveform to select a new annotation region.
                </p>
              </div>
              <div className="whitespace-nowrap text-sm tabular-nums text-slate-500">
                {formatTimestamp(currentTime)} / {formatTimestamp(duration)}
              </div>
            </div>

            {waveformError && (
              <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
                {waveformError}
              </div>
            )}

            <div className="overflow-hidden rounded-xl border border-slate-200 bg-slate-50">
              <div className="flex items-center justify-between border-b border-slate-200 bg-white px-3 py-2">
                <span className="text-xs font-medium uppercase tracking-wide text-slate-400">
                  Waveform
                </span>
                <span className="text-[11px] tabular-nums text-slate-400">
                  {visibleRange.end > visibleRange.start
                    ? `${formatTimestamp(visibleRange.start)} – ${formatTimestamp(visibleRange.end)}`
                    : "Full timeline"}
                </span>
              </div>

              <div className="relative">
                <div ref={waveformRef} className="w-full px-2 py-3" />
              </div>

              <div className="border-y border-slate-200 bg-white px-3 py-2 text-xs font-medium uppercase tracking-wide text-slate-400">
                Spectrogram
              </div>

              <div
                ref={spectrogramViewportRef}
                className="w-full overflow-hidden bg-slate-950"
              >
                <div
                  className="relative min-w-full"
                  style={{
                    width:
                      appliedPxPerSec > 0 && duration > 0
                        ? `${Math.max(1, duration * appliedPxPerSec)}px`
                        : "100%",
                  }}
                >
                  <div ref={spectrogramRef} className="w-full" />

                  {duration > 0 && activeSelection && (
                    <div
                      className="pointer-events-none absolute inset-y-0 z-10 border-x-2 border-indigo-300 bg-indigo-400/20"
                      style={{
                        left: `${(activeSelection.start / duration) * 100}%`,
                        width: `${((activeSelection.end - activeSelection.start) / duration) * 100}%`,
                      }}
                      aria-hidden="true"
                    />
                  )}

                  {duration > 0 && (
                    <div
                      className="pointer-events-none absolute inset-y-0 z-20 w-0.5 bg-white/90"
                      style={{
                        left: `${Math.min(100, Math.max(0, (currentTime / duration) * 100))}%`,
                      }}
                      aria-hidden="true"
                    />
                  )}
                </div>
              </div>
            </div>

            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-3">
                <button
                  onClick={() => wavesurferRef.current?.playPause()}
                  disabled={!audioReady}
                  className="rounded-lg bg-indigo-600 px-5 py-2 text-sm font-medium text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-indigo-300"
                >
                  {isPlaying ? "⏸ Pause" : "▶ Play"}
                </button>
                <button
                  onClick={handleStopPlayback}
                  disabled={!audioReady}
                  className="rounded-lg border border-slate-200 px-5 py-2 text-sm text-slate-600 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-300"
                >
                  ■ Stop
                </button>
                <button
                  onClick={handlePlaySelection}
                  disabled={!audioReady}
                  className="rounded-lg border border-slate-200 px-5 py-2 text-sm text-slate-600 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-300"
                >
                  ▶ Play Selection
                </button>
                {!audioReady && !waveformError && (
                  <span className="text-xs text-slate-400">Loading waveform and spectrogram…</span>
                )}
              </div>

              <div className="flex items-center gap-2">
                <ZoomOut className="h-4 w-4 text-slate-400" />
                <button
                  type="button"
                  onClick={handleZoomOut}
                  disabled={!audioReady || zoomLevel === ZOOM_LEVELS[0]}
                  className="rounded-md border border-slate-200 px-2 py-1 text-xs text-slate-600 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-300"
                  aria-label="Zoom out"
                  title="Zoom out"
                >
                  −
                </button>
                <div
                  className="min-w-[72px] rounded-md border border-slate-200 bg-slate-50 px-3 py-1 text-center text-xs font-medium tabular-nums text-slate-600"
                  aria-label="Current audio visualisation zoom"
                >
                  {zoomLevel === 1 ? "Fit" : `${zoomLevel}×`}
                </div>
                <button
                  type="button"
                  onClick={handleZoomIn}
                  disabled={!audioReady || zoomLevel === ZOOM_LEVELS[ZOOM_LEVELS.length - 1]}
                  className="rounded-md border border-slate-200 px-2 py-1 text-xs text-slate-600 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-300"
                  aria-label="Zoom in"
                  title="Zoom in"
                >
                  +
                </button>
                <ZoomIn className="h-4 w-4 text-slate-400" />
              </div>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto px-6 py-4">
            <div className="mb-3 flex items-center justify-between gap-4">
              <h2 className="text-sm font-semibold text-slate-700">
                Annotations ({annotations.length})
              </h2>
              <div className="flex items-center gap-2 rounded-lg border border-slate-200 px-2 py-1.5">
                <Search className="h-4 w-4 text-slate-400" />
                <input
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  placeholder="Search annotations..."
                  className="text-sm outline-none"
                />
              </div>
            </div>

            {annotations.length === 0 ? (
              <div className="rounded-xl border border-dashed border-slate-300 p-8 text-center text-slate-400">
                No annotations yet — use the form on the left to create one.
              </div>
            ) : (
              <div className="overflow-hidden rounded-xl border border-slate-200">
                <table className="w-full text-left text-sm">
                  <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="px-3 py-2">Start Time</th>
                      <th className="px-3 py-2">End Time</th>
                      <th className="px-3 py-2">Label</th>
                      <th className="px-3 py-2">User</th>
                      <th className="px-3 py-2">Comments</th>
                      <th className="px-3 py-2">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {annotations
                      .filter((a) => {
                        const term = searchTerm.trim().toLowerCase();
                        if (!term) return true;
                        return (
                          (a.label || "").toLowerCase().includes(term) ||
                          (a.comment || "").toLowerCase().includes(term)
                        );
                      })
                      .map((ann) => {
                        const dotColor = ann.annotationClass?.color || "#94a3b8";
                        return (
                          <tr
                            key={ann.id}
                            className="border-t border-slate-100 bg-white transition hover:bg-slate-50"
                          >
                            <td className="px-3 py-2 text-slate-700 tabular-nums">{formatTimestamp(ann.startTime)}</td>
                            <td className="px-3 py-2 text-slate-700 tabular-nums">{formatTimestamp(ann.endTime)}</td>
                            <td className="px-3 py-2">
                              <span className="flex items-center gap-2 text-slate-800">
                                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: dotColor }} />
                                {ann.label}
                              </span>
                            </td>
                            <td className="px-3 py-2">
                              <div className="flex h-6 w-6 items-center justify-center rounded-full bg-indigo-100 text-[10px] font-semibold text-indigo-700">
                                {userInitials}
                              </div>
                            </td>
                            <td className="max-w-[220px] truncate px-3 py-2 text-slate-500">{ann.comment}</td>
                            <td className="px-3 py-2">
                              <div className="flex items-center gap-1">
                                <button
                                  onClick={() => handleEditOpen(ann)}
                                  className="rounded-lg p-1.5 text-slate-400 hover:bg-indigo-50 hover:text-indigo-600 transition"
                                  title="Edit annotation"
                                  aria-label={`Edit ${ann.label || "annotation"}`}
                                >
                                  <Pencil className="h-4 w-4" />
                                </button>
                                <button
                                  onClick={() => handleDeleteClick(ann)}
                                  className="rounded-lg p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-500 transition"
                                  title="Delete annotation"
                                  aria-label={`Delete ${ann.label || "annotation"}`}
                                >
                                  <Trash2 className="h-4 w-4" />
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        {selectedAnnotation && isEditing && (
          <>
            {/* Drag handle — resize edit panel */}
            <div
              onMouseDown={() => (resizingRef.current = "right")}
              className="w-1.5 flex-shrink-0 cursor-col-resize bg-slate-100 hover:bg-indigo-200 transition"
            />

            {/* Right panel — only opens after Edit is selected from the annotation list */}
            <div style={{ width: rightWidth }} className="flex-shrink-0 overflow-y-auto border-l border-slate-200 bg-white px-4 py-4">
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-slate-700">Edit Annotation</h2>
                <button onClick={handleClosePanel} className="text-slate-400 hover:text-slate-600 transition" aria-label="Close edit panel">
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div className="flex flex-col gap-4">
                <TimestampInput
                  label="Start Time"
                  value={editStart}
                  onChange={handleEditStartChange}
                  hasError={Boolean(editErrors.start)}
                />
                {editErrors.start && <p className="text-xs text-red-500">{editErrors.start}</p>}

                <TimestampInput
                  label="End Time"
                  value={editEnd}
                  onChange={handleEditEndChange}
                  hasError={Boolean(editErrors.end)}
                />
                {editErrors.end && <p className="text-xs text-red-500">{editErrors.end}</p>}

                <div>
                  <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-400">
                    Label *
                  </label>

                  <select
                    value={
                      editAnnotationClass?.type === "custom"
                        ? editAnnotationClass.id
                        : editLabel
                    }
                    onChange={(e) => handleEditLabelChange(e.target.value)}
                    className={`w-full rounded-lg border bg-white px-3 py-2 text-sm text-slate-700 outline-none focus:ring-2 focus:ring-indigo-300 ${editErrors.label ? "border-red-400" : "border-slate-200"
                      }`}
                  >
                    <option value="Default Label">Default Label</option>

                    {customLabels.map((label) => (
                      <option key={label.id} value={label.id}>
                        {label.name}
                      </option>
                    ))}

                    <option value="Miscellaneous">Miscellaneous</option>
                    <option value="__custom__">+ Create New Label…</option>
                  </select>

                  {editAnnotationClass && (
                    <div className="mt-2 flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                      <span
                        className="h-2.5 w-2.5 flex-shrink-0 rounded-full"
                        style={{
                          backgroundColor: editAnnotationClass.color || "#94a3b8",
                        }}
                      />
                      <span className="min-w-0 flex-1 truncate text-sm text-slate-600">
                        {editLabel}
                      </span>

                      {editAnnotationClass.type === "custom" && (
                        <button
                          type="button"
                          onClick={() => openCustomLabelModal("edit")}
                          className="flex-shrink-0 text-xs font-medium text-indigo-600 hover:text-indigo-700"
                        >
                          Change
                        </button>
                      )}
                    </div>
                  )}

                  {editErrors.label && (
                    <p className="mt-1 text-xs text-red-500">{editErrors.label}</p>
                  )}
                </div>

                <div>
                  <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-400">Comments</label>
                  <textarea
                    value={editComment}
                    onChange={(e) => setEditComment(e.target.value)}
                    rows={4}
                    className={`w-full rounded-lg border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-300 ${editErrors.comment ? "border-red-400" : "border-slate-200"
                      }`}
                    placeholder="Add a note about this annotation..."
                  />
                  {editErrors.comment && <p className="mt-1 text-xs text-red-500">{editErrors.comment}</p>}
                </div>

                {editWarning && <p className="text-xs text-amber-600">{editWarning}</p>}

                <div className="flex gap-2 pt-2">
                  <button
                    onClick={handleSaveEdit}
                    className="flex-1 rounded-lg bg-indigo-600 py-2 text-sm font-medium text-white hover:bg-indigo-700 transition"
                  >
                    Save
                  </button>
                  <button
                    onClick={handleCancelEdit}
                    className="flex-1 rounded-lg border border-slate-200 py-2 text-sm text-slate-600 hover:bg-slate-50 transition"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Custom label selection / creation modal */}
      {showCustomLabelModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-white/20 px-4 backdrop-blur-sm">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="custom-label-modal-title"
            className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-xl"
          >
            <div className="mb-4 flex items-start justify-between gap-4">
              <div>
                <h3 id="custom-label-modal-title" className="text-lg font-semibold text-slate-800">
                  {customLabelModalMode === "edit"
                    ? "Change Annotation Label"
                    : "Select Custom Label"}
                </h3>
                <p className="mt-1 text-sm text-slate-500">
                  {customLabelModalMode === "edit"
                    ? "Select an existing custom label or create a new one for this annotation."
                    : "Search existing project labels or create a new one."}
                </p>
              </div>
              <button
                type="button"
                onClick={closeCustomLabelModal}
                disabled={isCreatingLabel}
                className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600 disabled:cursor-not-allowed disabled:opacity-50"
                aria-label="Close custom label panel"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="mb-3 flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2">
              <Search className="h-4 w-4 flex-shrink-0 text-slate-400" />
              <input
                value={customLabelSearch}
                onChange={(e) => setCustomLabelSearch(e.target.value)}
                placeholder="Search custom labels..."
                className="w-full text-sm outline-none"
                autoFocus
              />
            </div>

            <div className="max-h-56 overflow-y-auto rounded-xl border border-slate-200">
              {customLabels.filter((label) =>
                (label.name || "")
                  .toLowerCase()
                  .includes(customLabelSearch.trim().toLowerCase())
              ).length === 0 ? (
                <div className="px-4 py-8 text-center text-sm text-slate-400">
                  {customLabels.length === 0
                    ? "No custom labels yet. Create the first one below."
                    : "No labels match your search."}
                </div>
              ) : (
                <div className="divide-y divide-slate-100">
                  {customLabels
                    .filter((label) =>
                      (label.name || "")
                        .toLowerCase()
                        .includes(customLabelSearch.trim().toLowerCase())
                    )
                    .map((label) => {
                      const isSelected =
                        customLabelModalMode === "edit"
                          ? editAnnotationClass?.type === "custom" &&
                          editAnnotationClass?.id === label.id
                          : label.id === selectedCustomLabelId;

                      return (
                        <button
                          key={label.id}
                          type="button"
                          onClick={() => handleSelectCustomLabel(label)}
                          className={`flex w-full items-center justify-between gap-3 px-4 py-3 text-left text-sm transition ${isSelected ? "bg-indigo-50" : "bg-white hover:bg-slate-50"
                            }`}
                        >
                          <span className="flex min-w-0 items-center gap-3">
                            <span
                              className="h-3 w-3 flex-shrink-0 rounded-full"
                              style={{ backgroundColor: label.color || "#3b82f6" }}
                            />
                            <span
                              className={`truncate ${isSelected
                                ? "font-medium text-indigo-700"
                                : "text-slate-700"
                                }`}
                            >
                              {label.name}
                            </span>
                          </span>
                          {isSelected && (
                            <span className="text-xs font-medium text-indigo-600">Selected</span>
                          )}
                        </button>
                      );
                    })}
                </div>
              )}
            </div>

            <div className="my-5 border-t border-slate-200" />

            <div>
              <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-400">
                Create New Label
              </label>
              <div className="flex gap-2">
                <input
                  value={newLabelName}
                  onChange={(e) => {
                    setNewLabelName(e.target.value);
                    setCustomLabelError("");
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !isCreatingLabel) {
                      e.preventDefault();
                      handleCreateCustomLabel();
                    }
                  }}
                  maxLength={100}
                  placeholder="e.g. Koala bellow call"
                  className={`min-w-0 flex-1 rounded-lg border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-300 ${customLabelError ? "border-red-400" : "border-slate-200"
                    }`}
                />
                <button
                  type="button"
                  onClick={handleCreateCustomLabel}
                  disabled={isCreatingLabel}
                  className="flex flex-shrink-0 items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-indigo-300"
                >
                  <Plus className="h-4 w-4" />
                  {isCreatingLabel ? "Creating..." : "Create"}
                </button>
              </div>
              {customLabelError && (
                <p className="mt-1 text-xs text-red-500">{customLabelError}</p>
              )}
              <p className="mt-2 text-xs text-slate-400">
                Custom labels are saved to this project and can be reused for future annotations.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirmation modal */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-white/20 backdrop-blur-sm">
          <div className="w-96 rounded-2xl bg-white p-6 shadow-xl">
            <h3 className="mb-2 text-lg font-semibold text-slate-800">Delete Annotation</h3>
            <p className="mb-6 text-sm text-slate-500">
              Are you sure you want to delete{" "}
              <span className="font-medium text-slate-700">"{annotationToDelete?.label}"</span>? This cannot be undone.
            </p>
            <div className="flex gap-3">
              <button
                onClick={handleConfirmDelete}
                className="flex-1 rounded-lg bg-red-600 py-2 text-sm font-medium text-white hover:bg-red-700 transition"
              >
                Delete
              </button>
              <button
                onClick={handleCancelDelete}
                className="flex-1 rounded-lg border border-slate-200 py-2 text-sm text-slate-600 hover:bg-slate-50 transition"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
