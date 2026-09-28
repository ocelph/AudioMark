import { useState, useEffect, useRef, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { auth, db } from "../services/firebase";
import { doc, getDoc, collection, addDoc, updateDoc, deleteDoc, serverTimestamp, onSnapshot, query, orderBy } from "firebase/firestore";
import WaveSurfer from "wavesurfer.js";
import RegionsPlugin from "wavesurfer.js/dist/plugins/regions.js";
import Spectrogram from "wavesurfer.js/dist/plugins/spectrogram.js";
import { Download, History, Share2, Maximize2, Search, Plus, X, Pencil, Trash2, ZoomIn, ZoomOut, ChevronDown, Scissors, FileText, Archive } from "lucide-react";
import JSZip from "jszip";
import MiscellaneousLabelModal from "../components/MiscellaneousLabelModal";


// Built-in annotation class choices.
// User-level custom labels are created and selected through the Custom Label modal.
const DEFAULT_CLASSES = [
  { name: "Default Label", color: "#22c55e" },
  { name: "Custom Label", color: "#3b82f6" },
  { name: "Miscellaneous", color: "#f97316" },
];
const PALETTE = ["#a855f7", "#ec4899", "#14b8a6", "#eab308", "#ef4444", "#06b6d4"];

// Fixed zoom steps make Zoom In / Zoom Out deterministic.
// 1 = Fit the entire recording to the available width.
const ZOOM_LEVELS = [1, 1.5, 2, 3, 4, 6, 8];

// Half a millisecond — used for float-safe timestamp comparison so that
// values that should be equal (but differ by binary-representation noise)
// are treated as the same.
const TIME_EPSILON = 0.0005;
const isSameTime = (a, b) => Math.abs(Number(a) - Number(b)) < TIME_EPSILON;

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
// edge case (exact duplicate time range — blocked). Duplicate detection uses
// an epsilon comparison so that float representation noise doesn't cause
// two identical-looking annotations to slip through as "different".
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
      (a) => a.id !== excludeId && isSameTime(a.startTime, start) && isSameTime(a.endTime, end)
    );
    if (duplicate) errors.end = "An annotation with this exact time range already exists";
  }

  return errors;
};

// Soft edge case — overlapping ranges are allowed, but we warn about them.
const findOverlap = (annotations, start, end, excludeId) =>
  annotations.find((a) => a.id !== excludeId && start < a.endTime && end > a.startTime);


// ------------------ DOWNLOAD FEATURE ------------------
// ---------- Download audio segment ---------
// Load and decode the original recording
const sanitizeFilePart = (value) => {
  const cleaned = String(value || "")
    .trim()
    .replace(/[^a-z0-9-_]+/gi, "_")
    .replace(/^_+|_+$/g, "");

  return cleaned || "export";
};

const formatSecondsForFileName = (seconds) => {
  const numeric = Number(seconds);

  if (!Number.isFinite(numeric)) {
    return "0_000";
  }

  return numeric.toFixed(3).replace(".", "_");
};

const getAudioContextClass = () => {
  return window.AudioContext || window.webkitAudioContext;
};

// Load and decode the original recording
const loadAndDecodeAudio = async (audioUrl) => {
  if (!audioUrl) {
    throw new Error("The project's audio file is unavailable.");
  }

  const response = await fetch(audioUrl);

  if (!response.ok) {
    throw new Error(
      `Unable to retrieve the audio file (${response.status}).`
    );
  }

  const sourceArrayBuffer = await response.arrayBuffer();

  if (sourceArrayBuffer.byteLength === 0) {
    throw new Error("The source audio file is empty.");
  }

  const AudioContextClass = getAudioContextClass();

  if (!AudioContextClass) {
    throw new Error(
      "Audio extraction is not supported by this browser."
    );
  }

  const audioContext = new AudioContextClass();

  try {
    const decodedAudio = await audioContext.decodeAudioData(
      sourceArrayBuffer.slice(0)
    );

    if (
      !decodedAudio ||
      decodedAudio.length === 0 ||
      decodedAudio.numberOfChannels === 0 ||
      decodedAudio.duration <= 0
    ) {
      throw new Error("The source audio file could not be decoded.");
    }

    return decodedAudio;
  } finally {
    try {
      await audioContext.close();
    } catch {
      // Nothing else is required if closing the temporary context fails.
    }
  }
};

// WAV Generator (creates actual RIFF, WAVE, PCM 16-bit)
const writeAscii = (view, offset, text) => {
  for (let i = 0; i < text.length; i++) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
};

const encodeWav = (channelData, sampleRate) => {
  if (!Array.isArray(channelData) || channelData.length === 0) {
    throw new Error("No audio channels were available.");
  }

  const numberOfChannels = channelData.length;
  const frameCount = channelData[0].length;

  if (frameCount === 0) {
    throw new Error("The extracted audio segment is empty.");
  }

  const bytesPerSample = 2;
  const blockAlign = numberOfChannels * bytesPerSample;
  const dataLength = frameCount * blockAlign;

  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);

  // RIFF header
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataLength, true);
  writeAscii(view, 8, "WAVE");

  // fmt chunk
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numberOfChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(
    28,
    sampleRate * blockAlign,
    true
  );
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // 16-bit PCM

  // data chunk
  writeAscii(view, 36, "data");
  view.setUint32(40, dataLength, true);

  let offset = 44;

  for (let frame = 0; frame < frameCount; frame++) {
    for (
      let channel = 0;
      channel < numberOfChannels;
      channel++
    ) {
      let sample = channelData[channel][frame];

      if (!Number.isFinite(sample)) {
        sample = 0;
      }

      sample = Math.max(-1, Math.min(1, sample));

      const pcmValue =
        sample < 0
          ? Math.round(sample * 0x8000)
          : Math.round(sample * 0x7fff);

      view.setInt16(offset, pcmValue, true);
      offset += 2;
    }
  }

  return new Blob([buffer], {
    type: "audio/wav",
  });
};

// Extract only the selected segment using start and end timestamps
const extractSegmentAsWav = (
  decodedAudio,
  startTime,
  endTime
) => {
  const start = Number(startTime);
  const end = Number(endTime);

  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    throw new Error(
      "The annotation contains invalid timestamps."
    );
  }

  if (start < 0) {
    throw new Error(
      "The annotation start time cannot be negative."
    );
  }

  if (end <= start) {
    throw new Error(
      "The annotation end time must be greater than its start time."
    );
  }

  const timeTolerance = 0.01;

  if (start >= decodedAudio.duration) {
    throw new Error("The annotation starts outside the source audio.");
  }

  if (end > decodedAudio.duration + timeTolerance) {
    throw new Error("The annotation extends beyond the source audio duration.");
  }

  const safeStart = start;
  const safeEnd = Math.min(end, decodedAudio.duration);

  const sampleRate = decodedAudio.sampleRate;

  const startSample = Math.floor(
    safeStart * sampleRate
  );

  const endSample = Math.min(
    decodedAudio.length,
    Math.ceil(safeEnd * sampleRate)
  );

  if (endSample <= startSample) {
    throw new Error(
      "The extracted audio segment contains no samples."
    );
  }

  const channelData = [];

  for (
    let channel = 0;
    channel < decodedAudio.numberOfChannels;
    channel++
  ) {
    const sourceChannel =
      decodedAudio.getChannelData(channel);

    channelData.push(
      sourceChannel.slice(
        startSample,
        endSample
      )
    );
  }

  const blob = encodeWav(
    channelData,
    sampleRate
  );

  const actualDuration =
    (endSample - startSample) / sampleRate;

  return {
    blob,
    duration: actualDuration,
  };
};

// Verify the generated WAV
const verifyGeneratedWav = async (
  blob,
  expectedDuration
) => {
  if (!(blob instanceof Blob)) {
    throw new Error("No audio file was generated.");
  }

  // A PCM WAV requires at least the 44-byte header
  // plus actual audio data.
  if (blob.size <= 44) {
    throw new Error(
      "The generated audio file is empty."
    );
  }

  const headerBuffer =
    await blob.slice(0, 12).arrayBuffer();

  const bytes = new Uint8Array(headerBuffer);

  const readText = (start, length) =>
    String.fromCharCode(
      ...bytes.slice(start, start + length)
    );

  // WAV must contain RIFF at bytes 0-3
  // and WAVE at bytes 8-11.
  if (
    readText(0, 4) !== "RIFF" ||
    readText(8, 4) !== "WAVE"
  ) {
    throw new Error(
      "The generated audio file has an invalid WAV header."
    );
  }

  const AudioContextClass = getAudioContextClass();

  if (!AudioContextClass) {
    throw new Error(
      "Audio verification is not supported by this browser."
    );
  }

  const audioContext = new AudioContextClass();

  try {
    const generatedArrayBuffer =
      await blob.arrayBuffer();

    const decoded =
      await audioContext.decodeAudioData(
        generatedArrayBuffer
      );

    if (
      !decoded ||
      decoded.length === 0 ||
      decoded.numberOfChannels === 0 ||
      decoded.duration <= 0
    ) {
      throw new Error(
        "The generated audio file could not be decoded."
      );
    }

    if (Number.isFinite(expectedDuration)) {
      const tolerance = 0.02;

      if (
        Math.abs(
          decoded.duration - expectedDuration
        ) > tolerance
      ) {
        throw new Error(
          "The generated audio duration does not match the selected annotation."
        );
      }
    }

    return true;
  } finally {
    try {
      await audioContext.close();
    } catch {
      // Nothing else required.
    }
  }
};

// broswer download function
const downloadBlob = (blob, filename) => {
  const objectUrl =
    URL.createObjectURL(blob);

  const link =
    document.createElement("a");

  link.href = objectUrl;
  link.download = filename;

  document.body.appendChild(link);
  link.click();
  link.remove();

  setTimeout(() => {
    URL.revokeObjectURL(objectUrl);
  }, 1000);
};

// Convert Firestore's createdAt
const formatExportDate = (value) => {
  if (!value) return null;

  if (typeof value.toDate === "function") {
    const date = value.toDate();
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();

  return typeof value === "string" ? value : null;
};

// ---------- Download specific annotation ---------
// Build the annotation export object (start/end timestamps, label, comment, duration, creation time)
const buildAnnotationExportRecord = (annotation) => {
  if (!annotation) throw new Error("No annotation was selected.");

  const startTime = Number(annotation.startTime);
  const endTime = Number(annotation.endTime);

  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime) {
    throw new Error("The selected annotation contains invalid timestamps.");
  }

  return {
    startTimeSeconds: startTime,
    startTime: formatTimestamp(startTime),
    endTimeSeconds: endTime,
    endTime: formatTimestamp(endTime),
    durationSeconds: Number((endTime - startTime).toFixed(3)),
    label: annotation.label || "",
    comment: annotation.comment || "",
    createdAt: formatExportDate(annotation.createdAt),
  };
};


// comments may contain commas, "quotes" or line breaks
const escapeCsvValue = (value) => {
  if (value === null || value === undefined) return "";

  const text = String(value);

  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;

  return text;
};

// csv generator for one annotation
const buildAnnotationCsv = (record) => {
  const row = {
    startTimeSeconds: record.startTimeSeconds,
    startTime: record.startTime,
    endTimeSeconds: record.endTimeSeconds,
    endTime: record.endTime,
    durationSeconds: record.durationSeconds,
    label: record.label,
    comment: record.comment,
    createdAt: record.createdAt || "",
  };

  const headers = Object.keys(row);
  const values = headers.map((header) => escapeCsvValue(row[header]));

  return `${headers.join(",")}\r\n${values.join(",")}`;
};

// validate the one generated annotation export
const verifyAnnotationExport = (content, format) => {
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new Error("The generated annotation export is empty.");
  }

  if (format === "json") {
    let parsed;

    try {
      parsed = JSON.parse(content);
    } catch {
      throw new Error("The generated JSON file is invalid.");
    }

    if (
      !parsed ||
      typeof parsed !== "object" ||
      !parsed.startTime ||
      !parsed.endTime ||
      typeof parsed.label !== "string"
    ) {
      throw new Error("The generated JSON file is missing annotation information.");
    }

    return true;
  }

  if (format === "csv") {
    const lines = content.split(/\r?\n/);

    if (
      lines.length < 2 ||
      !lines[0].includes("startTime") ||
      !lines[0].includes("endTime") ||
      !lines[0].includes("label")
    ) {
      throw new Error("The generated CSV file is invalid.");
    }

    return true;
  }

  throw new Error("Unsupported annotation export format.");
};

// ---------- Download annotation and audio segment ---------
const verifyGeneratedZip = async (zipBlob, expectedFileNames) => {
  if (!(zipBlob instanceof Blob) || zipBlob.size === 0) {
    throw new Error("The generated ZIP file is empty.");
  }

  let loadedZip;

  try {
    loadedZip = await JSZip.loadAsync(zipBlob);
  } catch {
    throw new Error("The generated ZIP file is invalid.");
  }

  for (const fileName of expectedFileNames) {
    const file = loadedZip.file(fileName);

    if (!file) {
      throw new Error(`The ZIP file is missing ${fileName}.`);
    }

    const fileData = await file.async("uint8array");

    if (fileData.length === 0) {
      throw new Error(`The ZIP file contains an empty file: ${fileName}.`);
    }
  }

  return true;
};


// ---------- Download all annotations ---------
// csv generator for al annotations
const buildAllAnnotationsCsv = (records) => {
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error("There are no annotations to export.");
  }

  const headers = [
    "startTimeSeconds",
    "startTime",
    "endTimeSeconds",
    "endTime",
    "durationSeconds",
    "label",
    "comment",
    "createdAt",
  ];

  const rows = records.map((record) => {
    const row = {
      startTimeSeconds: record.startTimeSeconds,
      startTime: record.startTime,
      endTimeSeconds: record.endTimeSeconds,
      endTime: record.endTime,
      durationSeconds: record.durationSeconds,
      label: record.label,
      comment: record.comment,
      createdAt: record.createdAt || "",
    };

    return headers.map((header) => escapeCsvValue(row[header])).join(",");
  });

  return `${headers.join(",")}\r\n${rows.join("\r\n")}`;
};

// validate all the generated annotation export
const verifyAllAnnotationsExport = (content, format, expectedCount) => {
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new Error("The generated annotations export is empty.");
  }

  if (!Number.isInteger(expectedCount) || expectedCount <= 0) {
    throw new Error("There are no annotations to export.");
  }

  if (format === "json") {
    let parsed;

    try {
      parsed = JSON.parse(content);
    } catch {
      throw new Error("The generated JSON file is invalid.");
    }

    if (!Array.isArray(parsed)) {
      throw new Error("The generated JSON file does not contain an annotation list.");
    }

    if (parsed.length !== expectedCount) {
      throw new Error("The generated JSON file does not contain all annotations.");
    }

    const allValid = parsed.every(
      (record) =>
        record &&
        typeof record === "object" &&
        record.startTime &&
        record.endTime &&
        typeof record.label === "string"
    );

    if (!allValid) {
      throw new Error("The generated JSON file contains invalid annotation data.");
    }

    return true;
  }

  if (format === "csv") {
    const firstLine = content.split(/\r?\n/, 1)[0];

    if (
      !firstLine.includes("startTime") ||
      !firstLine.includes("endTime") ||
      !firstLine.includes("label") ||
      !firstLine.includes("comment")
    ) {
      throw new Error("The generated CSV file is invalid.");
    }

    return true;
  }

  throw new Error("Unsupported annotation export format.");
};




export default function AnnotationPage() {
  const { ownerId, projectId } = useParams();
  const navigate = useNavigate();

  const [currentUserId, setCurrentUserId] = useState(null);
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

  // Guards against React state updates after unmount. Any async WaveSurfer
  // callback (ready, timeupdate, error, etc.) checks this before calling
  // setState to avoid the classic "state update on unmounted component" warning.
  const isMountedRef = useRef(true);

  // Tracks regions we created programmatically (e.g. when opening the edit
  // panel) so we can skip the "region-created" handler for them. Without this
  // guard, the handler could double-sync the form and cause visible jitter.
  const programmaticRegionsRef = useRef(new WeakSet());

  // Holds any pending requestAnimationFrame id for the spectrogram scroll
  // mirror. Batching per animation frame prevents scroll drift when the user
  // scrolls the waveform very rapidly.
  const scrollRafRef = useRef(null);

  // Latest zoom level captured in a ref. The window resize handler needs to
  // read the current zoom without being re-subscribed every time zoom changes.
  const zoomLevelRef = useRef(1);

  // Annotation class selection.
  // Default and Miscellaneous are built-in classes.
  // Custom labels are stored per user in Firestore and selected through a modal.
  const [selectedClassType, setSelectedClassType] = useState("Default Label");
  const [classSearch, setClassSearch] = useState("");
  const [editClassSearch, setEditClassSearch] = useState("");
  const [customLabels, setCustomLabels] = useState([]);
  const [selectedCustomLabelId, setSelectedCustomLabelId] = useState("");
  const [showCustomLabelModal, setShowCustomLabelModal] = useState(false);
  const [showMiscellaneousModal, setShowMiscellaneousModal] = useState(false);
  const [miscellaneousModalMode, setMiscellaneousModalMode] = useState("create");
  const [selectedMiscellaneousLabel, setSelectedMiscellaneousLabel] = useState(null);
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


  // Download function states
  const [showDownloadMenu, setShowDownloadMenu] = useState(false);
  const [showAnnotationFormatOptions, setShowAnnotationFormatOptions] = useState(false);
  const [showCombinedFormatOptions, setShowCombinedFormatOptions] = useState(false);
  const [showAllAnnotationsFormatOptions, setShowAllAnnotationsFormatOptions] = useState(false);
  const [showAllCombinedFormatOptions, setShowAllCombinedFormatOptions] = useState(false);
  const [exportSelectedAnnotationId, setExportSelectedAnnotationId] = useState(null);
  const [isExporting, setIsExporting] = useState(false);
  const [exportFeedback, setExportFeedback] = useState(null);
  const downloadMenuRef = useRef(null);

  // Mount / unmount marker for async setState guards.
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (scrollRafRef.current) {
        cancelAnimationFrame(scrollRafRef.current);
        scrollRafRef.current = null;
      }
    };
  }, []);

  // Keep the zoom-level ref in sync with state so the window resize handler
  // reads the freshest value without being re-registered on every zoom.
  useEffect(() => {
    zoomLevelRef.current = zoomLevel;
  }, [zoomLevel]);


  // Load project (the project doc doubles as the "file" — one project = one recording)
  useEffect(() => {
    const loadProject = async () => {
      try {
        const user = auth.currentUser;
        if (!user) {
          navigate("/login");
          return;
        }
        const projectSnap = await getDoc(doc(db, "users", ownerId, "projects", projectId));
        if (!isMountedRef.current) return;
        if (projectSnap.exists()) {
          const data = projectSnap.data();
          setFileName(data.project_title);
          setAudioUrl(data.download_url);
          setCurrentUserId(user.uid);
          setUserInitials(getInitials(user.displayName || user.email));
        } else {
          setError("Project not found.");
        }
      } catch (err) {
        console.error("Error loading project:", err);
        if (isMountedRef.current) setError("Failed to load project.");
      } finally {
        if (isMountedRef.current) setLoading(false);
      }
    };
    loadProject();
  }, [ownerId, projectId, navigate]);

  // Load project annotations in real time from the project owner path.
  useEffect(() => {
    if (!ownerId) return;
    const q = query(
      collection(db, "users", ownerId, "projects", projectId, "annotations"),
      orderBy("createdAt", "asc")
    );
    const unsubscribe = onSnapshot(q, (snapshot) => {
      if (!isMountedRef.current) return;
      const data = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
      setAnnotations(data);
    });
    return () => unsubscribe();
  }, [ownerId, projectId]);

  // Load user-level custom labels in real time.
  useEffect(() => {
    if (!currentUserId) return;

    const labelsRef = collection(db, "users", currentUserId, "labels");
    const unsubscribe = onSnapshot(
      labelsRef,
      (snapshot) => {
        if (!isMountedRef.current) return;
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
  }, [currentUserId]);

  // Initialise one shared WaveSurfer instance for both visualisations.
  // The spectrogram uses the same audio/timeline. Region overlays, zoom and
  // scrolling are also mirrored so the two panes behave as one linked view.
  useEffect(() => {
    if (!audioUrl || !waveformRef.current || !spectrogramRef.current || !currentUserId) return;

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
      if (!isMountedRef.current) return;

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
      if (!isMountedRef.current) return;
      setCurrentTime(time);
    });

    // Keep track of the visible time window while zooming/scrolling.
    // The spectrogram scroll mirror is batched per animation frame so that
    // rapid scrolling on the waveform doesn't cause the spectrogram viewport
    // to visibly lag or drift.
    const unsubScroll = ws.on("scroll", (visibleStartTime, visibleEndTime) => {
      if (!isMountedRef.current) return;

      setVisibleRange({
        start: Number.isFinite(visibleStartTime) ? visibleStartTime : 0,
        end: Number.isFinite(visibleEndTime) ? visibleEndTime : ws.getDuration(),
      });

      if (scrollRafRef.current !== null) return;

      scrollRafRef.current = requestAnimationFrame(() => {
        scrollRafRef.current = null;

        const waveWrapper = ws.getWrapper?.();
        if (waveWrapper && spectrogramViewportRef.current) {
          spectrogramViewportRef.current.scrollLeft = waveWrapper.scrollLeft;
        }
      });
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
      // Regions created programmatically (e.g. when the user opens the edit
      // panel) are tracked in a WeakSet and skipped here so we don't
      // double-sync the form or accidentally remove the region we just added.
      if (programmaticRegionsRef.current.has(region)) {
        programmaticRegionsRef.current.delete(region);
        return;
      }

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

    const unsubPlay = ws.on("play", () => {
      if (isMountedRef.current) setIsPlaying(true);
    });
    const unsubPause = ws.on("pause", () => {
      if (isMountedRef.current) setIsPlaying(false);
    });

    const unsubFinish = ws.on("finish", () => {
      if (!isMountedRef.current) return;
      setIsPlaying(false);
      setCurrentTime(ws.getDuration());
    });

    const unsubError = ws.on("error", (err) => {
      console.error("WaveSurfer failed to load audio:", err);
      if (!isMountedRef.current) return;
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

      if (scrollRafRef.current !== null) {
        cancelAnimationFrame(scrollRafRef.current);
        scrollRafRef.current = null;
      }

      activeRegionRef.current = null;
      setActiveSelection(null);
      regionsRef.current = null;
      wavesurferRef.current = null;
      ws.destroy();
    };
  }, [audioUrl, currentUserId]);

  const handleStopPlayback = () => {
    const ws = wavesurferRef.current;
    if (!ws) return;

    ws.pause();
    ws.setTime(0);
    setCurrentTime(0);
    setIsPlaying(false);
  };

  // Applies a zoom level relative to a freshly-measured fit.
  // Wrapped in useCallback because it's referenced by the window resize
  // effect below, and we want the effect to see a stable reference.
  const applyZoomLevel = useCallback((level) => {
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
  }, [audioReady, duration]);

  // Re-apply the current zoom level whenever the browser window is resized.
  // This keeps "Fit" (1x) genuinely fitting the current viewport width
  // instead of leaving stale pixels-per-second values from an earlier size.
  useEffect(() => {
    if (!audioReady || duration <= 0) return;

    let debounceId = null;
    const handleResize = () => {
      if (debounceId) clearTimeout(debounceId);
      debounceId = setTimeout(() => {
        applyZoomLevel(zoomLevelRef.current);
      }, 150);
    };

    window.addEventListener("resize", handleResize);
    return () => {
      if (debounceId) clearTimeout(debounceId);
      window.removeEventListener("resize", handleResize);
    };
  }, [audioReady, duration, applyZoomLevel]);

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
    try {
      region.setOptions({ start, end });
    } finally {
      // Use a microtask to release the guard AFTER any synchronous
      // region-updated event has finished, and also on the next tick to
      // cover async firings — whichever happens, we won't feed our own
      // programmatic update back into the form.
      Promise.resolve().then(() => {
        syncingRegionRef.current = false;
      });
    }

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
      : selectedClassType === "Miscellaneous"
        ? selectedMiscellaneousLabel
          ? {
            name: selectedMiscellaneousLabel.name,
            color: "#f97316",
            type: "miscellaneous",
            source: "audioset",
            sourceId: selectedMiscellaneousLabel.id,
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
      setSelectedMiscellaneousLabel(null);
      openCustomLabelModal("create");
      return;
    }

    if (className === "Miscellaneous") {
      setMiscellaneousModalMode("create");
      setShowMiscellaneousModal(true);
      return;
    }

    setSelectedClassType(className);
    setSelectedCustomLabelId("");
    setSelectedMiscellaneousLabel(null);
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

  const handleSelectMiscellaneousLabel = (sound) => {
    const annotationClass = {
      name: sound.name,
      color: "#f97316",
      type: "miscellaneous",
      source: "audioset",
      sourceId: sound.id,
    };

    if (miscellaneousModalMode === "edit") {
      setEditLabel(sound.name);
      setEditAnnotationClass(annotationClass);
      setEditErrors((prev) => ({ ...prev, label: undefined }));
    } else {
      setSelectedClassType("Miscellaneous");
      setSelectedMiscellaneousLabel(sound);
      setSelectedCustomLabelId("");
      setCreateErrors((prev) => ({ ...prev, label: undefined }));
    }

    setShowMiscellaneousModal(false);
  };

  const handleCreateCustomLabel = async () => {
    if (!currentUserId) return;

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
      const labelsRef = collection(db, "users", currentUserId, "labels");

      const docRef = await addDoc(labelsRef, {
        name: trimmed,
        color,
        createdAt: serverTimestamp(),
      });

      if (!isMountedRef.current) return;

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
      if (isMountedRef.current) setCustomLabelError("Failed to create the label. Please try again.");
    } finally {
      if (isMountedRef.current) setIsCreatingLabel(false);
    }
  };

  const handleCreateAnnotation = async () => {
    if (!ownerId || !currentUserId) return;

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

    if (selectedClassType === "Miscellaneous" && !selectedMiscellaneousLabel) {
      errors.label = "Select a predefined sound label.";
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
      await addDoc(collection(db, "users", ownerId, "projects", projectId, "annotations"), {
        startTime: start,
        endTime: end,
        label,
        annotationClass,
        comment: createComment.trim(),
        createdAt: serverTimestamp(),
      });

      if (!isMountedRef.current) return;

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

    // Mark this region as programmatic so the "region-created" handler
    // ignores it. The WeakSet drops the reference automatically when the
    // region is removed, so we don't need to clean it up manually.
    programmaticRegionsRef.current.add(region);

    activeRegionRef.current = region;
    setActiveSelection({
      start: Number(start.toFixed(3)),
      end: Number(end.toFixed(3)),
    });

    // Release the sync guard on the next microtask so any synchronous
    // region-updated fired by addRegion has finished first.
    Promise.resolve().then(() => {
      syncingRegionRef.current = false;
    });

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
    setEditClassSearch("");
    editingRegionRef.current = true;
    setIsEditing(true);
    showEditAnnotationRegion(annotation);
  };

  const handleEditSelectClassType = (className) => {
    setEditErrors((prev) => ({ ...prev, label: undefined }));

    if (className === "Custom Label") {
      openCustomLabelModal("edit");
      return;
    }

    if (className === "Miscellaneous") {
      setMiscellaneousModalMode("edit");
      setShowMiscellaneousModal(true);
      return;
    }

    const builtInClass = DEFAULT_CLASSES.find(
      (annotationClass) => annotationClass.name === className
    );

    if (builtInClass) {
      setEditLabel(builtInClass.name);
      setEditAnnotationClass({
        ...builtInClass,
        type: "default",
      });
    }
  };

  const handleEditSelectCustomLabel = (label) => {
    setEditLabel(label.name);
    setEditAnnotationClass({
      id: label.id,
      name: label.name,
      color: label.color || "#3b82f6",
      type: "custom",
    });
    setEditErrors((prev) => ({ ...prev, label: undefined }));
    setEditClassSearch("");
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
      await updateDoc(doc(db, "users", ownerId, "projects", projectId, "annotations", selectedAnnotation.id), {
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

      if (!isMountedRef.current) return;

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
      await deleteDoc(doc(db, "users", ownerId, "projects", projectId, "annotations", annotationToDelete.id));
      if (!isMountedRef.current) return;

      if (exportSelectedAnnotationId === annotationToDelete.id) {
        setExportSelectedAnnotationId(null);
      }

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

  const normalizedEditClassSearch = editClassSearch.trim().toLowerCase();
  const filteredEditDefaultClasses = DEFAULT_CLASSES.filter((annotationClass) =>
    annotationClass.name.toLowerCase().includes(normalizedEditClassSearch)
  );
  const filteredEditCustomLabels = normalizedEditClassSearch
    ? customLabels.filter((label) =>
      (label.name || "").toLowerCase().includes(normalizedEditClassSearch)
    )
    : [];

  // determine which annotation is selected for download
  const exportSelectedAnnotation = annotations.find((annotation) => annotation.id === exportSelectedAnnotationId) || null;

  // close the dropdown if user clicks elsewhere or presses escape
  useEffect(() => {
    if (!showDownloadMenu) return;

    const handleOutsideClick = (event) => {
      if (downloadMenuRef.current && !downloadMenuRef.current.contains(event.target)) {
        setShowDownloadMenu(false);
        setShowAnnotationFormatOptions(false);
        setShowCombinedFormatOptions(false);
        setShowAllAnnotationsFormatOptions(false);
        setShowAllCombinedFormatOptions(false);
      }
    };

    const handleEscape = (event) => {
      if (event.key === "Escape") {
        setShowDownloadMenu(false);
        setShowAnnotationFormatOptions(false);
        setShowCombinedFormatOptions(false);
        setShowAllAnnotationsFormatOptions(false);
        setShowAllCombinedFormatOptions(false);
      }
    };

    document.addEventListener("mousedown", handleOutsideClick);
    document.addEventListener("keydown", handleEscape);

    return () => {
      document.removeEventListener("mousedown", handleOutsideClick);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [showDownloadMenu]);


  // clear export selection if the annotation is deleted (because of real time Firestore storage)
  useEffect(() => {
    if (!exportSelectedAnnotationId) return;

    const stillExists = annotations.some(
      (annotation) =>
        annotation.id === exportSelectedAnnotationId
    );

    if (!stillExists) {
      setExportSelectedAnnotationId(null);
    }
  }, [annotations, exportSelectedAnnotationId,]);

  // actual Download Audio Segment handler
  const handleDownloadAudioSegment = async () => {
    if (!exportSelectedAnnotation) {
      setExportFeedback({
        type: "error",
        message:
          "Select an annotation before downloading an audio segment.",
      });

      return;
    }

    if (!audioUrl) {
      setExportFeedback({
        type: "error",
        message:
          "The project's audio file is unavailable.",
      });

      return;
    }

    setShowDownloadMenu(false);
    setShowAnnotationFormatOptions(false);
    setShowCombinedFormatOptions(false);
    setShowAllAnnotationsFormatOptions(false);
    setShowAllCombinedFormatOptions(false);
    setIsExporting(true);

    setExportFeedback({ type: "loading", message: "Generating audio segment...", });

    try {
      // 1. Download + decode the project's original recording.
      const decodedAudio = await loadAndDecodeAudio(audioUrl);


      // 2. Extract the samples belonging to the selected annotation.
      const { blob, duration: extractedDuration, } = extractSegmentAsWav(decodedAudio, exportSelectedAnnotation.startTime, exportSelectedAnnotation.endTime);


      // 3. Verify the newly generated WAV before allowing it to download.
      await verifyGeneratedWav(blob, extractedDuration);


      // 4. Build a safe filename.
      const projectPart = sanitizeFilePart(fileName);
      const labelPart = sanitizeFilePart(exportSelectedAnnotation.label);
      const startPart = formatSecondsForFileName(exportSelectedAnnotation.startTime);
      const endPart = formatSecondsForFileName(exportSelectedAnnotation.endTime);
      const exportFileName = `${projectPart}_${labelPart}_` + `${startPart}s-${endPart}s.wav`;


      // 5. Only now start the browser download.
      downloadBlob(blob, exportFileName);

      setExportFeedback({
        type: "success",
        message:
          "Audio segment generated successfully. Download started.",
      });
    } catch (err) {
      console.error(
        "Failed to export audio segment:",
        err
      );

      setExportFeedback({
        type: "error",
        message:
          err?.message ||
          "The audio segment could not be generated.",
      });
    } finally {
      setIsExporting(false);
    }
  };

  // actual Download Annotation Segment handler
  const handleDownloadAnnotation = async (format) => {
    if (!exportSelectedAnnotation) {
      setExportFeedback({ type: "error", message: "Select an annotation before exporting annotation data." });
      return;
    }

    if (format !== "json" && format !== "csv") {
      setExportFeedback({ type: "error", message: "Unsupported annotation export format." });
      return;
    }

    setShowDownloadMenu(false);
    setShowAnnotationFormatOptions(false);
    setShowCombinedFormatOptions(false);
    setShowAllAnnotationsFormatOptions(false);
    setShowAllCombinedFormatOptions(false);
    setIsExporting(true);

    setExportFeedback({ type: "loading", message: `Generating ${format.toUpperCase()} annotation export...` });

    try {
      // 1. Build a clean export record from the selected annotation.
      const record = buildAnnotationExportRecord(exportSelectedAnnotation);

      // 2. Convert the record to the requested format.
      let content;
      let mimeType;

      if (format === "json") {
        content = JSON.stringify(record, null, 2);
        mimeType = "application/json;charset=utf-8";
      } else {
        content = buildAnnotationCsv(record);
        mimeType = "text/csv;charset=utf-8";
      }

      // 3. Verify the generated data before downloading.
      verifyAnnotationExport(content, format);

      // UTF-8 BOM helps spreadsheet applications correctly read CSV characters.
      const fileContent = format === "csv" ? `\uFEFF${content}` : content;
      const blob = new Blob([fileContent], { type: mimeType });

      if (blob.size === 0) throw new Error(`The generated ${format.toUpperCase()} file is empty.`);

      // 4. Build a safe filename.
      const projectPart = sanitizeFilePart(fileName);
      const labelPart = sanitizeFilePart(exportSelectedAnnotation.label);
      const startPart = formatSecondsForFileName(exportSelectedAnnotation.startTime);
      const endPart = formatSecondsForFileName(exportSelectedAnnotation.endTime);
      const exportFileName = `${projectPart}_${labelPart}_${startPart}s-${endPart}s_annotation.${format}`;

      // 5. Start the browser download.
      downloadBlob(blob, exportFileName);

      setExportFeedback({
        type: "success",
        message: `${format.toUpperCase()} annotation generated successfully. Download started.`,
      });
    } catch (err) {
      console.error("Failed to export annotation:", err);

      setExportFeedback({
        type: "error",
        message: err?.message || "The annotation export could not be generated.",
      });
    } finally {
      setIsExporting(false);
    }
  };

  // actual Download Annotation & Audio Segment handler
  const handleDownloadAudioAndAnnotation = async (format) => {
    if (!exportSelectedAnnotation) {
      setExportFeedback({ type: "error", message: "Select an annotation before exporting audio and annotation data." });
      return;
    }

    if (!audioUrl) {
      setExportFeedback({ type: "error", message: "The project's audio file is unavailable." });
      return;
    }

    if (format !== "json" && format !== "csv") {
      setExportFeedback({ type: "error", message: "Unsupported annotation export format." });
      return;
    }

    setShowDownloadMenu(false);
    setShowAnnotationFormatOptions(false);
    setShowCombinedFormatOptions(false);
    setShowAllAnnotationsFormatOptions(false);
    setShowAllCombinedFormatOptions(false);
    setIsExporting(true);

    setExportFeedback({ type: "loading", message: "Generating audio and annotation ZIP..." });

    try {
      // 1. Load and decode the project's original recording.
      const decodedAudio = await loadAndDecodeAudio(audioUrl);

      // 2. Extract and verify the selected audio segment.
      const { blob: audioBlob, duration: extractedDuration } = extractSegmentAsWav(
        decodedAudio,
        exportSelectedAnnotation.startTime,
        exportSelectedAnnotation.endTime
      );

      await verifyGeneratedWav(audioBlob, extractedDuration);

      // 3. Generate and verify the annotation data.
      const annotationRecord = buildAnnotationExportRecord(exportSelectedAnnotation);

      let annotationContent;

      if (format === "json") {
        annotationContent = JSON.stringify(annotationRecord, null, 2);
      } else {
        annotationContent = `\uFEFF${buildAnnotationCsv(annotationRecord)}`;
      }

      verifyAnnotationExport(format === "csv" ? annotationContent.replace(/^\uFEFF/, "") : annotationContent, format);

      // 4. Build filenames shared by the WAV, annotation file and ZIP.
      const projectPart = sanitizeFilePart(fileName);
      const labelPart = sanitizeFilePart(exportSelectedAnnotation.label);
      const startPart = formatSecondsForFileName(exportSelectedAnnotation.startTime);
      const endPart = formatSecondsForFileName(exportSelectedAnnotation.endTime);
      const baseName = `${projectPart}_${labelPart}_${startPart}s-${endPart}s`;

      const audioFileName = `${baseName}_audio.wav`;
      const annotationFileName = `${baseName}_annotation.${format}`;
      const zipFileName = `${baseName}_audio_and_annotation.zip`;

      // 5. Add both files to the ZIP.
      const zip = new JSZip();

      zip.file(audioFileName, audioBlob);
      zip.file(annotationFileName, annotationContent);

      // 6. Generate the ZIP.
      const zipBlob = await zip.generateAsync({
        type: "blob",
        compression: "DEFLATE",
        compressionOptions: { level: 6 },
      });

      // 7. Verify the ZIP before downloading it.
      await verifyGeneratedZip(zipBlob, [audioFileName, annotationFileName]);

      // 8. Start the browser download.
      downloadBlob(zipBlob, zipFileName);

      setExportFeedback({
        type: "success",
        message: "Audio and annotation ZIP generated successfully. Download started.",
      });
    } catch (err) {
      console.error("Failed to export audio and annotation ZIP:", err);

      setExportFeedback({
        type: "error",
        message: err?.message || "The audio and annotation ZIP could not be generated.",
      });
    } finally {
      setIsExporting(false);
    }
  };


  // actual Download All Annotations handler
  const handleDownloadAllAnnotations = async (format) => {
    if (annotations.length === 0) {
      setExportFeedback({ type: "error", message: "There are no annotations to export." });
      return;
    }

    if (format !== "json" && format !== "csv") {
      setExportFeedback({ type: "error", message: "Unsupported annotation export format." });
      return;
    }

    setShowDownloadMenu(false);
    setShowAnnotationFormatOptions(false);
    setShowCombinedFormatOptions(false);
    setShowAllAnnotationsFormatOptions(false);
    setShowAllCombinedFormatOptions(false);
    setIsExporting(true);
    setExportFeedback({ type: "loading", message: `Generating ${format.toUpperCase()} export for all annotations...` });

    try {
      // 1. Convert every project annotation into the same export structure used for individual exports.
      const records = annotations.map((annotation) => buildAnnotationExportRecord(annotation));

      // 2. Generate the requested file format.
      let content;
      let mimeType;

      if (format === "json") {
        content = JSON.stringify(records, null, 2);
        mimeType = "application/json;charset=utf-8";
      } else {
        content = buildAllAnnotationsCsv(records);
        mimeType = "text/csv;charset=utf-8";
      }

      // 3. Verify the generated export before downloading it.
      verifyAllAnnotationsExport(content, format, records.length);

      // 4. Add a UTF-8 BOM to CSV for better spreadsheet compatibility.
      const fileContent = format === "csv" ? `\uFEFF${content}` : content;
      const blob = new Blob([fileContent], { type: mimeType });

      if (blob.size === 0) {
        throw new Error(`The generated ${format.toUpperCase()} file is empty.`);
      }

      // 5. Build the filename and start the browser download.
      const projectPart = sanitizeFilePart(fileName);
      const exportFileName = `${projectPart}_all_annotations.${format}`;

      downloadBlob(blob, exportFileName);

      setExportFeedback({
        type: "success",
        message: `All ${records.length} annotations were generated successfully as ${format.toUpperCase()}. Download started.`,
      });
    } catch (err) {
      console.error("Failed to export all annotations:", err);

      setExportFeedback({
        type: "error",
        message: err?.message || "The annotations export could not be generated.",
      });
    } finally {
      setIsExporting(false);
    }
  };


  // actual Download All Annotations & Audio segments handler
  const handleDownloadAllAnnotationsAndAudio = async (format) => {
    if (annotations.length === 0) {
      setExportFeedback({ type: "error", message: "There are no annotations to export." });
      return;
    }

    if (!audioUrl) {
      setExportFeedback({ type: "error", message: "The project's audio file is unavailable." });
      return;
    }

    if (format !== "json" && format !== "csv") {
      setExportFeedback({ type: "error", message: "Unsupported annotation export format." });
      return;
    }

    setShowDownloadMenu(false);
    setShowAnnotationFormatOptions(false);
    setShowCombinedFormatOptions(false);
    setShowAllAnnotationsFormatOptions(false);
    setShowAllCombinedFormatOptions(false);
    setIsExporting(true);
    setExportFeedback({ type: "loading", message: "Preparing all annotation and audio segments..." });

    try {
      // 1. Download and decode the source recording ONCE.
      const decodedAudio = await loadAndDecodeAudio(audioUrl);

      // 2. Create the ZIP.
      const zip = new JSZip();
      const expectedFileNames = [];

      // 3. Generate one WAV + annotation file for every annotation.
      for (let index = 0; index < annotations.length; index++) {
        const annotation = annotations[index];

        setExportFeedback({
          type: "loading",
          message: `Generating segment ${index + 1} of ${annotations.length}...`,
        });

        // Build and validate the annotation record.
        const annotationRecord = buildAnnotationExportRecord(annotation);

        // Extract and verify this annotation's WAV.
        const { blob: audioBlob, duration: extractedDuration } = extractSegmentAsWav(
          decodedAudio,
          annotation.startTime,
          annotation.endTime
        );

        await verifyGeneratedWav(audioBlob, extractedDuration);

        // Generate annotation JSON or CSV.
        let annotationContent;

        if (format === "json") {
          annotationContent = JSON.stringify(annotationRecord, null, 2);
          verifyAnnotationExport(annotationContent, "json");
        } else {
          const csvContent = buildAnnotationCsv(annotationRecord);
          verifyAnnotationExport(csvContent, "csv");
          annotationContent = `\uFEFF${csvContent}`;
        }

        // Build unique matching filenames.
        const numberPart = String(index + 1).padStart(3, "0");
        const labelPart = sanitizeFilePart(annotation.label);
        const startPart = formatSecondsForFileName(annotation.startTime);
        const endPart = formatSecondsForFileName(annotation.endTime);
        const baseName = `${numberPart}_${labelPart}_${startPart}s-${endPart}s`;

        const audioFileName = `${baseName}_audio.wav`;
        const annotationFileName = `${baseName}_annotation.${format}`;

        const audioPath = `segments/${audioFileName}`;
        const annotationPath = `segments/${annotationFileName}`;

        // Add both files to the ZIP.
        zip.file(audioPath, audioBlob);
        zip.file(annotationPath, annotationContent);

        expectedFileNames.push(audioPath, annotationPath);
      }

      setExportFeedback({ type: "loading", message: "Packaging and verifying ZIP file..." });

      // 4. Generate the finished ZIP.
      const zipBlob = await zip.generateAsync({
        type: "blob",
        compression: "DEFLATE",
        compressionOptions: { level: 6 },
      });

      // 5. Verify every expected file exists and is non-empty.
      await verifyGeneratedZip(zipBlob, expectedFileNames);

      // 6. Download only after everything succeeds.
      const projectPart = sanitizeFilePart(fileName);
      const zipFileName = `${projectPart}_all_annotations_and_audio.zip`;

      downloadBlob(zipBlob, zipFileName);

      setExportFeedback({
        type: "success",
        message: `All ${annotations.length} audio segments and annotations were generated successfully. Download started.`,
      });
    } catch (err) {
      console.error("Failed to export all annotations and audio:", err);

      setExportFeedback({
        type: "error",
        message: err?.message || "The annotations and audio ZIP could not be generated.",
      });
    } finally {
      setIsExporting(false);
    }
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
          <div ref={downloadMenuRef} className="relative">
            <button type="button"
              onClick={() => {
                if (showDownloadMenu) {
                  setShowAnnotationFormatOptions(false);
                  setShowCombinedFormatOptions(false);
                  setShowAllAnnotationsFormatOptions(false);
                  setShowAllCombinedFormatOptions(false);
                }

                setShowDownloadMenu(!showDownloadMenu);
              }}
              disabled={isExporting}
              aria-expanded={showDownloadMenu}
              className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-600 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Download className="h-4 w-4" />

              {isExporting ? "Exporting..." : "Download"}
              <ChevronDown className={`h-3.5 w-3.5 transition ${showDownloadMenu ? "rotate-180" : ""}`} />
            </button>

            {showDownloadMenu && (
              <div className="absolute right-0 top-full z-50 mt-2 w-80 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl">

                {/* Selected annotation summary */}
                <div className="border-b border-slate-100 px-4 py-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Export</p>

                  {exportSelectedAnnotation ? (
                    <p className="mt-1 truncate text-sm text-slate-600">Selected:{" "}
                      <span className="font-medium text-slate-800">{exportSelectedAnnotation.label}</span>
                    </p>
                  ) : (
                    <p className="mt-1 text-xs text-slate-400">Select an annotation below for segment exports.</p>
                  )}
                </div>

                <div className="p-2">
                  <button type="button" disabled={!exportSelectedAnnotation || isExporting} onClick={handleDownloadAudioSegment}
                    className="flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <Scissors className="mt-0.5 h-4 w-4 flex-shrink-0 text-indigo-500" />
                    <div>
                      <p className="text-sm font-medium text-slate-700">Download Audio Segment</p>
                      <p className="mt-0.5 text-xs text-slate-400">Export the selected annotation's audio as WAV.</p>
                    </div>
                  </button>


                  <div>
                    <button
                      type="button"
                      disabled={!exportSelectedAnnotation || isExporting}
                      onClick={() => {
                        setShowCombinedFormatOptions(false);
                        setShowAllAnnotationsFormatOptions(false);
                        setShowAllCombinedFormatOptions(false);
                        setShowAnnotationFormatOptions((previous) => !previous);
                      }}
                      className="flex w-full items-start justify-between gap-3 rounded-lg px-3 py-2.5 text-left transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <span className="flex items-start gap-3">
                        <FileText className="mt-0.5 h-4 w-4 flex-shrink-0 text-indigo-500" />
                        <span>
                          <span className="block text-sm font-medium text-slate-700">Download Annotation</span>
                          <span className="mt-0.5 block text-xs text-slate-400">Export the selected annotation as JSON or CSV.</span>
                        </span>
                      </span>

                      <ChevronDown className={`mt-0.5 h-4 w-4 flex-shrink-0 text-slate-400 transition ${showAnnotationFormatOptions ? "rotate-180" : ""}`} />
                    </button>

                    {showAnnotationFormatOptions && exportSelectedAnnotation && (
                      <div className="mx-3 mb-2 ml-10 grid grid-cols-2 gap-2">
                        <button
                          type="button"
                          onClick={() => handleDownloadAnnotation("json")}
                          disabled={isExporting}
                          className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-600 transition hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-700 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          JSON
                        </button>

                        <button
                          type="button"
                          onClick={() => handleDownloadAnnotation("csv")}
                          disabled={isExporting}
                          className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-600 transition hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-700 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          CSV
                        </button>
                      </div>
                    )}
                  </div>


                  <div>
                    <button
                      type="button"
                      disabled={!exportSelectedAnnotation || isExporting}
                      onClick={() => {
                        setShowAnnotationFormatOptions(false);
                        setShowAllAnnotationsFormatOptions(false);
                        setShowAllCombinedFormatOptions(false);
                        setShowCombinedFormatOptions((previous) => !previous);
                      }}
                      className="flex w-full items-start justify-between gap-3 rounded-lg px-3 py-2.5 text-left transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <span className="flex items-start gap-3">
                        <Archive className="mt-0.5 h-4 w-4 flex-shrink-0 text-indigo-500" />
                        <span>
                          <span className="block text-sm font-medium text-slate-700">Download Audio and Annotation</span>
                          <span className="mt-0.5 block text-xs text-slate-400">Export the selected audio and annotation together as ZIP.</span>
                        </span>
                      </span>

                      <ChevronDown className={`mt-0.5 h-4 w-4 flex-shrink-0 text-slate-400 transition ${showCombinedFormatOptions ? "rotate-180" : ""}`} />
                    </button>

                    {showCombinedFormatOptions && exportSelectedAnnotation && (
                      <div className="mx-3 mb-2 ml-10 grid grid-cols-2 gap-2">
                        <button
                          type="button"
                          onClick={() => handleDownloadAudioAndAnnotation("json")}
                          disabled={isExporting}
                          className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-600 transition hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-700 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          JSON
                        </button>

                        <button
                          type="button"
                          onClick={() => handleDownloadAudioAndAnnotation("csv")}
                          disabled={isExporting}
                          className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-600 transition hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-700 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          CSV
                        </button>
                      </div>
                    )}
                  </div>

                </div>

                <div className="border-t border-slate-100 p-2">

                  <div>
                    <button
                      type="button"
                      disabled={annotations.length === 0 || isExporting}
                      onClick={() => {
                        setShowAnnotationFormatOptions(false);
                        setShowCombinedFormatOptions(false);
                        setShowAllCombinedFormatOptions(false);
                        setShowAllAnnotationsFormatOptions((previous) => !previous);
                      }}
                      className="flex w-full items-start justify-between gap-3 rounded-lg px-3 py-2.5 text-left transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <span className="flex items-start gap-3">
                        <FileText className="mt-0.5 h-4 w-4 flex-shrink-0 text-indigo-500" />
                        <span>
                          <span className="block text-sm font-medium text-slate-700">Download All Annotations</span>
                          <span className="mt-0.5 block text-xs text-slate-400">Export all annotations as JSON or CSV.</span>
                        </span>
                      </span>

                      <ChevronDown className={`mt-0.5 h-4 w-4 flex-shrink-0 text-slate-400 transition ${showAllAnnotationsFormatOptions ? "rotate-180" : ""}`} />
                    </button>

                    {showAllAnnotationsFormatOptions && annotations.length > 0 && (
                      <div className="mx-3 mb-2 ml-10 grid grid-cols-2 gap-2">
                        <button
                          type="button"
                          onClick={() => handleDownloadAllAnnotations("json")}
                          disabled={isExporting}
                          className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-600 transition hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-700 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          JSON
                        </button>

                        <button
                          type="button"
                          onClick={() => handleDownloadAllAnnotations("csv")}
                          disabled={isExporting}
                          className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-600 transition hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-700 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          CSV
                        </button>
                      </div>
                    )}
                  </div>

                  <div>
                    <button
                      type="button"
                      disabled={annotations.length === 0 || isExporting}
                      onClick={() => {
                        setShowAnnotationFormatOptions(false);
                        setShowCombinedFormatOptions(false);
                        setShowAllAnnotationsFormatOptions(false);
                        setShowAllCombinedFormatOptions((previous) => !previous);
                      }}
                      className="flex w-full items-start justify-between gap-3 rounded-lg px-3 py-2.5 text-left transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <span className="flex items-start gap-3">
                        <Archive className="mt-0.5 h-4 w-4 flex-shrink-0 text-indigo-500" />
                        <span>
                          <span className="block text-sm font-medium text-slate-700">Download All Annotations and Audio</span>
                          <span className="mt-0.5 block text-xs text-slate-400">Package all audio segments and their annotation data together.</span>
                        </span>
                      </span>

                      <ChevronDown className={`mt-0.5 h-4 w-4 flex-shrink-0 text-slate-400 transition ${showAllCombinedFormatOptions ? "rotate-180" : ""}`} />
                    </button>

                    {showAllCombinedFormatOptions && annotations.length > 0 && (
                      <div className="mx-3 mb-2 ml-10 grid grid-cols-2 gap-2">
                        <button
                          type="button"
                          onClick={() => handleDownloadAllAnnotationsAndAudio("json")}
                          disabled={isExporting}
                          className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-600 transition hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-700 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          JSON
                        </button>

                        <button
                          type="button"
                          onClick={() => handleDownloadAllAnnotationsAndAudio("csv")}
                          disabled={isExporting}
                          className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-600 transition hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-700 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          CSV
                        </button>
                      </div>
                    )}
                  </div>

                </div>
              </div>
            )}
          </div>
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

      {/* Export feedback */}
      {exportFeedback && (
        <div
          className={`border-b px-6 py-2 text-sm ${exportFeedback.type === "success" ? "border-green-200 bg-green-50 text-green-700" : exportFeedback.type === "error" ? "border-red-200 bg-red-50 text-red-700" : "border-indigo-200 bg-indigo-50 text-indigo-700"
            }`}
        >
          <div className="flex items-center justify-between gap-4">
            <span>{exportFeedback.message}</span>

            {exportFeedback.type !== "loading" && (
              <button type="button" onClick={() => setExportFeedback(null)}
                className="rounded p-1 opacity-60 transition hover:bg-black/5 hover:opacity-100"
                aria-label="Dismiss export message"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>
      )}

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
              const miscellaneousSummary =
                annotationClass.name === "Miscellaneous" && selectedMiscellaneousLabel
                  ? selectedMiscellaneousLabel.name
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

                  {(customSummary || miscellaneousSummary) && (
                    <span className="max-w-[120px] truncate text-xs text-indigo-500">
                      {customSummary || miscellaneousSummary}
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
              setSelectedMiscellaneousLabel(null);
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

          {selectedClassType === "Miscellaneous" && selectedMiscellaneousLabel && (
            <div
              className={`mb-4 rounded-lg border px-3 py-2 ${createErrors.label ? "border-red-300 bg-red-50" : "border-slate-200 bg-slate-50"
                }`}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[10px] font-medium uppercase tracking-wide text-slate-400">
                    Selected predefined sound
                  </p>
                  <div className="mt-1 flex items-center gap-2">
                    <span className="h-2.5 w-2.5 flex-shrink-0 rounded-full bg-orange-500" />
                    <span className="truncate text-sm font-medium text-slate-700">
                      {selectedMiscellaneousLabel.name}
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => { setMiscellaneousModalMode("create"); setShowMiscellaneousModal(true); }}
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
                      <th className="w-12 px-3 py-2"><span className="sr-only">Select</span></th>
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
                            className={`border-t border-slate-100 transition ${exportSelectedAnnotationId === ann.id ? "bg-indigo-50" : "bg-white hover:bg-slate-50"}`}
                          >
                            <td className="px-3 py-2">
                              <input type="radio" name="export-annotation" checked={exportSelectedAnnotationId === ann.id}
                                onClick={() => setExportSelectedAnnotationId((prev) => prev === ann.id ? null : ann.id)}
                                onChange={() => { }}
                                aria-label={`Select ${ann.label || "annotation"} for export`}
                                className="h-4 w-4 cursor-pointer accent-indigo-600"
                              />
                            </td>
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
                  <label className="mb-2 block text-sm font-semibold text-slate-700">
                    Annotation Class
                  </label>

                  <div className="mb-2 flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-2 py-1.5 focus-within:ring-2 focus-within:ring-indigo-200">
                    <Search className="h-4 w-4 flex-shrink-0 text-slate-400" />
                    <input
                      value={editClassSearch}
                      onChange={(e) => setEditClassSearch(e.target.value)}
                      placeholder="Search or select label"
                      className="w-full text-sm outline-none"
                    />
                    {editClassSearch && (
                      <button
                        type="button"
                        onClick={() => setEditClassSearch("")}
                        className="rounded p-0.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
                        aria-label="Clear edit label search"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>

                  <div className="mb-2 flex flex-col gap-1">
                    {filteredEditDefaultClasses.map((annotationClass) => {
                      const isCustom = editAnnotationClass?.type === "custom";
                      const isMisc = editAnnotationClass?.type === "miscellaneous";
                      const isSelected =
                        annotationClass.name === "Custom Label"
                          ? isCustom
                          : annotationClass.name === "Miscellaneous"
                            ? isMisc
                            : !isCustom && !isMisc && editLabel === annotationClass.name;

                      const summary =
                        annotationClass.name === "Custom Label" && isCustom
                          ? editLabel
                          : annotationClass.name === "Miscellaneous" && isMisc
                            ? editLabel
                            : null;

                      return (
                        <button
                          key={annotationClass.name}
                          type="button"
                          onClick={() => handleEditSelectClassType(annotationClass.name)}
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
                                  annotationClass.name === "Custom Label" && isCustom
                                    ? editAnnotationClass?.color || annotationClass.color
                                    : annotationClass.color,
                              }}
                            />
                            <span>{annotationClass.name}</span>
                          </span>
                          {summary && (
                            <span className="max-w-[120px] truncate text-xs text-indigo-500">
                              {summary}
                            </span>
                          )}
                        </button>
                      );
                    })}

                    {filteredEditCustomLabels.map((label) => {
                      const isSelected =
                        editAnnotationClass?.type === "custom" &&
                        editAnnotationClass?.id === label.id;

                      return (
                        <button
                          key={label.id}
                          type="button"
                          onClick={() => handleEditSelectCustomLabel(label)}
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
                          <span className="text-[10px] uppercase tracking-wide text-slate-400">
                            Custom
                          </span>
                        </button>
                      );
                    })}

                    {normalizedEditClassSearch &&
                      filteredEditDefaultClasses.length === 0 &&
                      filteredEditCustomLabels.length === 0 && (
                        <p className="px-2 py-2 text-xs text-slate-400">No matching labels.</p>
                      )}
                  </div>

                  <button
                    type="button"
                    onClick={() => openCustomLabelModal("edit")}
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

                  {editAnnotationClass?.type === "custom" && (
                    <div className={`mb-3 rounded-lg border px-3 py-2 ${editErrors.label ? "border-red-300 bg-red-50" : "border-slate-200 bg-slate-50"
                      }`}>
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-[10px] font-medium uppercase tracking-wide text-slate-400">
                            Selected custom label
                          </p>
                          <div className="mt-1 flex items-center gap-2">
                            <span
                              className="h-2.5 w-2.5 flex-shrink-0 rounded-full"
                              style={{ backgroundColor: editAnnotationClass.color || "#3b82f6" }}
                            />
                            <span className="truncate text-sm font-medium text-slate-700">
                              {editLabel}
                            </span>
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => openCustomLabelModal("edit")}
                          className="flex-shrink-0 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-600 transition hover:bg-slate-50"
                        >
                          Change
                        </button>
                      </div>
                    </div>
                  )}

                  {editAnnotationClass?.type === "miscellaneous" && (
                    <div className={`mb-3 rounded-lg border px-3 py-2 ${editErrors.label ? "border-red-300 bg-red-50" : "border-slate-200 bg-slate-50"
                      }`}>
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-[10px] font-medium uppercase tracking-wide text-slate-400">
                            Selected predefined sound
                          </p>
                          <div className="mt-1 flex items-center gap-2">
                            <span className="h-2.5 w-2.5 flex-shrink-0 rounded-full bg-orange-500" />
                            <span className="truncate text-sm font-medium text-slate-700">
                              {editLabel}
                            </span>
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            setMiscellaneousModalMode("edit");
                            setShowMiscellaneousModal(true);
                          }}
                          className="flex-shrink-0 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-600 transition hover:bg-slate-50"
                        >
                          Change
                        </button>
                      </div>
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
      {showMiscellaneousModal && (
        <MiscellaneousLabelModal
          onSelect={handleSelectMiscellaneousLabel}
          onClose={() => setShowMiscellaneousModal(false)}
        />
      )}

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
                    : "Search your existing labels or create a new one."}
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
                Custom labels are saved to your account and can be reused across your projects.
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
