import { useState, useEffect, useRef, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { auth, db, realtimeDb } from "../services/firebase";
import { doc, getDoc, collection, addDoc, updateDoc, serverTimestamp, onSnapshot, query, orderBy, writeBatch } from "firebase/firestore";
import { ref as databaseRef, onValue, onDisconnect, set, remove, runTransaction as runRealtimeTransaction, serverTimestamp as realtimeServerTimestamp } from "firebase/database";
import WaveSurfer from "wavesurfer.js";
import RegionsPlugin from "wavesurfer.js/dist/plugins/regions.js";
import Spectrogram from "wavesurfer.js/dist/plugins/spectrogram.js";
import { Download, History, Share2, Maximize2, Search, Plus, X, Pencil, Trash2, ZoomIn, ZoomOut, ChevronDown, Scissors, FileText, Archive, Play, Pause } from "lucide-react";
import JSZip from "jszip";
import MiscellaneousLabelModal from "../components/MiscellaneousLabelModal";
import ShareProjectModal from "../components/ShareProjectModal";


// Built-in annotation class choices.
// User-level custom labels are created and selected through the Custom Label modal.
const DEFAULT_CLASSES = [
  { name: "Atlas Label", color: "#22c55e" },
  { name: "Others", color: "#f97316" },
  { name: "Custom Label", color: "#3b82f6" },
];
const PALETTE = ["#a855f7", "#ec4899", "#14b8a6", "#eab308", "#ef4444", "#06b6d4"];

// Fixed zoom steps make Zoom In / Zoom Out deterministic.
// 1 = Fit the entire recording to the available width.
const ZOOM_LEVELS = [1, 1.5, 2, 3, 4, 6, 8];

// Half a millisecond — used for float-safe timestamp comparison so that
// values that should be equal (but differ by binary-representation noise) are treated as the same.
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

const getAnnotationAuthorInitials = (annotation) => {
  return getInitials(
    annotation.authorName ||
    annotation.authorEmail ||
    "Unknown"
  );
};


const authorColorPalette = [
  "bg-blue-100 text-blue-700 ring-blue-300",
  "bg-purple-100 text-purple-700 ring-purple-300",
  "bg-emerald-100 text-emerald-700 ring-emerald-300",
  "bg-amber-100 text-amber-700 ring-amber-300",
  "bg-pink-100 text-pink-700 ring-pink-300",
  "bg-cyan-100 text-cyan-700 ring-cyan-300",
  "bg-rose-100 text-rose-700 ring-rose-300",
  "bg-violet-100 text-violet-700 ring-violet-300",
];

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

  if (comment && comment.trim().length > 2000) errors.comment = "Comment must be under 2000 characters";

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


// Download feature
// Download audio segment
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

  // A PCM WAV requires at least the 44-byte header plus actual audio data
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

  // WAV must contain RIFF at bytes 0-3 and WAVE at bytes 8-11
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
      // Nothing else required
    }
  }
};

// Browser download function
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

// Format Firestore createdAt
const formatExportDate = (value) => {
  if (!value) return null;

  if (typeof value.toDate === "function") {
    const date = value.toDate();
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();

  return typeof value === "string" ? value : null;
};

// Download specific annotation
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


// Comments may contain commas, "quotes" or line breaks
const escapeCsvValue = (value) => {
  if (value === null || value === undefined) return "";

  const text = String(value);

  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;

  return text;
};

// Generate CSV for one annotation
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

// Validate the one generated annotation export
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

// Download annotation and audio segment
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


// Download all annotations
// Generate CSV for all annotations
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

// Validate all the generated annotation export
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
  const [currentUserName, setCurrentUserName] = useState("");
  const [currentUserEmail, setCurrentUserEmail] = useState("");
  const [userInitials, setUserInitials] = useState("U");
  const [activeCollaborators, setActiveCollaborators] = useState([]);
  const [collaboratorSelections, setCollaboratorSelections] = useState([]);
  const [editLockNotice, setEditLockNotice] = useState("");
  const [syncStatus, setSyncStatus] = useState("connected");
  const [syncMessage, setSyncMessage] = useState("");
  const [audioUrl, setAudioUrl] = useState(null);
  const [fileName, setFileName] = useState("");
  const [sharedWith, setSharedWith] = useState([]);
  const [sharedPermissions, setSharedPermissions] = useState([]);
  const [projectRole, setProjectRole] = useState("viewer");
  const [showShareModal, setShowShareModal] = useState(false);
  const [lastAccessError, setLastAccessError] = useState("");
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
  const [showLogHistory, setShowLogHistory] = useState(false);  // annotation history viewer state.
  const [annotationHistory, setAnnotationHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [audioReady, setAudioReady] = useState(false);
  const [waveformError, setWaveformError] = useState("");

  // Shared waveform/spectrogram synchronisation state.
  const [activeSelection, setActiveSelection] = useState(null);

  // Zoom model:
  // 1x = fit the entire audio into the current waveform width.
  // Higher values zoom relative to that fitted width, regardless of audio length or screen size.
  const [zoomLevel, setZoomLevel] = useState(1);
  const [appliedPxPerSec, setAppliedPxPerSec] = useState(0);
  const [visibleRange, setVisibleRange] = useState({ start: 0, end: 0 });

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const canEditAnnotations = currentUserId === ownerId || projectRole === "editor";

  const waveformRef = useRef(null);
  const spectrogramRef = useRef(null);
  const spectrogramViewportRef = useRef(null);
  const wavesurferRef = useRef(null);
  const regionsRef = useRef(null);
  const activeRegionRef = useRef(null);
  const spectrogramDragRef = useRef({
    isDragging: false,
    anchorTime: 0,
    region: null,
  });
  const syncingRegionRef = useRef(false);
  const editingRegionRef = useRef(false);
  const activeEditLockRef = useRef(null);
  const authorColorMapRef = useRef(new Map());
  const availableAuthorColorsRef = useRef([]);
  const hasConnectedOnceRef = useRef(false);
  const restoreMessageTimeoutRef = useRef(null);
  const collaboratorSelectionWriteTimeoutRef = useRef(null);

  const getAuthorColor = (authorId) => {
    if (!authorId) {
      return "bg-slate-100 text-slate-500 ring-slate-300";
    }

    if (authorColorMapRef.current.has(authorId)) {
      return authorColorMapRef.current.get(authorId);
    }

    if (availableAuthorColorsRef.current.length === 0) {
      availableAuthorColorsRef.current = [...authorColorPalette]
        .sort(() => Math.random() - 0.5);
    }

    const color = availableAuthorColorsRef.current.shift();
    authorColorMapRef.current.set(authorId, color);
    return color;
  };

  // Convert the existing collaborator colour assignment into an overlay colour
  // for live selections. This keeps ADP-115 visually consistent with the
  // collaborator avatars and annotation-author colours already used on the page.
  const getCollaboratorOverlayColor = (userId) => {
    const classes = getAuthorColor(userId);

    if (classes.includes("purple")) return { border: "#9333ea", fill: "rgba(147, 51, 234, 0.30)" };
    if (classes.includes("emerald")) return { border: "#059669", fill: "rgba(5, 150, 105, 0.30)" };
    if (classes.includes("amber")) return { border: "#d97706", fill: "rgba(217, 119, 6, 0.30)" };
    if (classes.includes("pink")) return { border: "#db2777", fill: "rgba(219, 39, 119, 0.30)" };
    if (classes.includes("cyan")) return { border: "#0891b2", fill: "rgba(8, 145, 178, 0.30)" };
    if (classes.includes("rose")) return { border: "#e11d48", fill: "rgba(225, 29, 72, 0.30)" };
    if (classes.includes("violet")) return { border: "#7c3aed", fill: "rgba(124, 58, 237, 0.30)" };
    if (classes.includes("blue")) return { border: "#2563eb", fill: "rgba(37, 99, 235, 0.30)" };

    return { border: "#475569", fill: "rgba(71, 85, 105, 0.30)" };
  };

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

  // Annotation class selection
  // Atlas Label and Others are built-in classes.
  // Custom labels are stored per user in Firestore and selected through a modal.
  const [selectedClassType, setSelectedClassType] = useState("Atlas Label");
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
  const [expandedCommentMode, setExpandedCommentMode] = useState(null); // "create" | "edit" | null
  const [leftWidth, setLeftWidth] = useState(400);
  const [rightWidth, setRightWidth] = useState(320);
  const resizingRef = useRef(null); // "left" | "right" | null


  // Download state
  const [showDownloadMenu, setShowDownloadMenu] = useState(false);
  const [showAnnotationFormatOptions, setShowAnnotationFormatOptions] = useState(false);
  const [showCombinedFormatOptions, setShowCombinedFormatOptions] = useState(false);
  const [showAllAnnotationsFormatOptions, setShowAllAnnotationsFormatOptions] = useState(false);
  const [showAllCombinedFormatOptions, setShowAllCombinedFormatOptions] = useState(false);
  const [exportSelectedAnnotationId, setExportSelectedAnnotationId] = useState(null);
  const [isExporting, setIsExporting] = useState(false);
  const [exportFeedback, setExportFeedback] = useState(null);
  const downloadMenuRef = useRef(null);

  // Track component mount state for async state updates
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (scrollRafRef.current) {
        cancelAnimationFrame(scrollRafRef.current);
        scrollRafRef.current = null;
      }
      if (restoreMessageTimeoutRef.current) {
        clearTimeout(restoreMessageTimeoutRef.current);
        restoreMessageTimeoutRef.current = null;
      }
      if (collaboratorSelectionWriteTimeoutRef.current) {
        clearTimeout(collaboratorSelectionWriteTimeoutRef.current);
        collaboratorSelectionWriteTimeoutRef.current = null;
      }
    };
  }, []);

  // Keep the zoom-level ref in sync with state so the window resize handler
  // reads the freshest value without being re-registered on every zoom.
  useEffect(() => {
    zoomLevelRef.current = zoomLevel;
  }, [zoomLevel]);


  // Load project
  useEffect(() => {
    const loadProject = async () => {
      try {
        const user = auth.currentUser;
        if (!user) {
          navigate("/login");
          return;
        }
        const projectRef = doc(db, "users", ownerId, "projects", projectId);
        const [projectSnap, currentUserSnap] = await Promise.all([
          getDoc(projectRef),
          getDoc(doc(db, "users", user.uid)),
        ]);
        if (!isMountedRef.current) return;

        const currentUserProfile = currentUserSnap.exists() ? currentUserSnap.data() : {};
        const profileName = [currentUserProfile.firstName, currentUserProfile.lastName]
          .filter(Boolean)
          .join(" ")
          .trim();
        const resolvedUserName =
          profileName || user.displayName || user.email?.split("@")[0] || "Unknown User";

        setCurrentUserId(user.uid);
        setCurrentUserName(resolvedUserName);
        setCurrentUserEmail(user.email || currentUserProfile.email || "");
        setUserInitials(getInitials(resolvedUserName || user.email));

        if (projectSnap.exists()) {
          const data = projectSnap.data();
          const projectPermissions = Array.isArray(data.shared_permissions)
            ? data.shared_permissions
            : [];
          setFileName(data.project_title);
          setAudioUrl(data.download_url);
          setSharedWith(Array.isArray(data.shared_with) ? data.shared_with : []);
          setSharedPermissions(projectPermissions);
          const normalizedUserEmail = (
            user.email || currentUserProfile.email || ""
          ).toLowerCase();
          const userPermission = projectPermissions.find(
            (permission) =>
              permission.email?.toLowerCase() === normalizedUserEmail
          );
          setProjectRole(user.uid === ownerId ? "editor" : userPermission?.role || "viewer");
          const lastAccessedRef =
            user.uid === ownerId
              ? projectRef
              : normalizedUserEmail
                ? doc(
                  db,
                  "shared_projects",
                  normalizedUserEmail,
                  "projects",
                  `${ownerId}_${projectId}`
                )
                : null;

          if (lastAccessedRef) {
            updateDoc(lastAccessedRef, {
              [`last_accessed_by.${user.uid}`]: serverTimestamp(),
            }).catch((err) => {
              console.error("Failed to update last accessed date:", err);
              if (isMountedRef.current) {
                setLastAccessError(
                  `Last accessed time could not be saved (${err.code || "unknown error"}).`
                );
              }
            });
          } else {
            console.error("Failed to update last accessed date: signed-in user has no email.");
            setLastAccessError("Last accessed time could not be saved: signed-in user has no email.");
          }
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

  useEffect(() => {
    if (!currentUserId || !ownerId || !projectId) return;

    const projectRef = doc(db, "users", ownerId, "projects", projectId);
    const unsubscribe = onSnapshot(
      projectRef,
      (projectSnap) => {
        if (!isMountedRef.current) return;
        if (!projectSnap.exists()) {
          setError("Project not found.");
          return;
        }

        const data = projectSnap.data();
        const nextSharedWith = Array.isArray(data.shared_with) ? data.shared_with : [];
        const nextPermissions = Array.isArray(data.shared_permissions)
          ? data.shared_permissions
          : [];
        const normalizedEmail = currentUserEmail.toLowerCase();
        const permission = nextPermissions.find(
          (item) => item.email?.toLowerCase() === normalizedEmail
        );

        setFileName(data.project_title || "");
        setAudioUrl(data.download_url || null);
        setSharedWith(nextSharedWith);
        setSharedPermissions(nextPermissions);
        setProjectRole(
          currentUserId === ownerId
            ? "editor"
            : permission?.role || "viewer"
        );
      },
      (snapshotError) => {
        console.error("Failed to refresh project permissions:", snapshotError);
        if (!isMountedRef.current) return;
        if (currentUserId !== ownerId) setProjectRole("viewer");
        setSyncStatus("error");
        setSyncMessage(
          "Project permissions could not be refreshed. Editing is disabled until the project reconnects."
        );
      }
    );

    return () => unsubscribe();
  }, [currentUserId, currentUserEmail, ownerId, projectId]);

  // Track users who are currently viewing this annotation project.
  useEffect(() => {
    if (!currentUserId || !ownerId || !projectId) return;

    const projectPresenceRef = databaseRef(
      realtimeDb,
      `presence/${ownerId}/${projectId}`
    );
    const currentUserPresenceRef = databaseRef(
      realtimeDb,
      `presence/${ownerId}/${projectId}/${currentUserId}`
    );
    const connectedRef = databaseRef(realtimeDb, ".info/connected");

    const unsubscribePresence = onValue(projectPresenceRef, (snapshot) => {
      if (!isMountedRef.current) return;

      const presenceData = snapshot.val() || {};
      const users = Object.entries(presenceData)
        .map(([id, data]) => ({
          id,
          ...data,
        }))
        .filter((user) => user.online === true);

      setActiveCollaborators(users);
    });

    const unsubscribeConnection = onValue(connectedRef, async (snapshot) => {
      if (!isMountedRef.current) return;

      const isConnected = snapshot.val() === true;

      if (!isConnected) {
        if (hasConnectedOnceRef.current) {
          setSyncStatus("disconnected");
          setSyncMessage(
            "Connection lost — real-time updates are temporarily unavailable. Changes may not be synchronised with collaborators."
          );
        }
        return;
      }

      if (hasConnectedOnceRef.current) {
        setSyncStatus("restored");
        setSyncMessage("Connection restored — real-time collaboration is active again.");

        if (restoreMessageTimeoutRef.current) {
          clearTimeout(restoreMessageTimeoutRef.current);
        }

        restoreMessageTimeoutRef.current = setTimeout(() => {
          if (!isMountedRef.current) return;
          setSyncStatus("connected");
          setSyncMessage("");
          restoreMessageTimeoutRef.current = null;
        }, 4000);
      } else {
        hasConnectedOnceRef.current = true;
        setSyncStatus("connected");
        setSyncMessage("");
      }

      try {
        await onDisconnect(currentUserPresenceRef).remove();
        await set(currentUserPresenceRef, {
          userId: currentUserId,
          name: currentUserName || currentUserEmail || "Unknown User",
          email: currentUserEmail || "",
          online: true,
          lastSeen: realtimeServerTimestamp(),
        });
      } catch (error) {
        console.error("Failed to update collaborator presence:", error);
        if (isMountedRef.current) {
          setSyncStatus("error");
          setSyncMessage(
            "Real-time collaboration could not reconnect completely. Please check your connection and try again."
          );
        }
      }
    });

    return () => {
      unsubscribePresence();
      unsubscribeConnection();
      remove(currentUserPresenceRef).catch((error) => {
        console.error("Failed to clear collaborator presence:", error);
      });
    };
  }, [
    currentUserId,
    currentUserName,
    currentUserEmail,
    ownerId,
    projectId,
  ]);

  // ADP-115: listen for temporary selections made by other collaborators.
  // These are presence-like UI hints only; they are never stored as annotations.
  useEffect(() => {
    if (!currentUserId || !ownerId || !projectId) return;

    const selectionsRef = databaseRef(
      realtimeDb,
      `collaboratorSelections/${ownerId}/${projectId}`
    );

    const unsubscribe = onValue(selectionsRef, (snapshot) => {
      if (!isMountedRef.current) return;

      const data = snapshot.val() || {};
      const selections = Object.entries(data)
        .map(([userId, value]) => ({ userId, ...value }))
        .filter((selection) =>
          selection.userId !== currentUserId &&
          Number.isFinite(Number(selection.start)) &&
          Number.isFinite(Number(selection.end)) &&
          Number(selection.end) > Number(selection.start)
        );

      setCollaboratorSelections(selections);
    }, (error) => {
      console.error("Failed to load collaborator selections:", error);
    });

    return () => {
      unsubscribe();
      setCollaboratorSelections([]);
    };
  }, [currentUserId, ownerId, projectId]);

  // ADP-115: publish this user's current selection. A short throttle keeps
  // dragging responsive without writing to Realtime Database on every pixel.
  useEffect(() => {
    if (!currentUserId || !ownerId || !projectId) return;

    const currentSelectionRef = databaseRef(
      realtimeDb,
      `collaboratorSelections/${ownerId}/${projectId}/${currentUserId}`
    );

    onDisconnect(currentSelectionRef).remove().catch((error) => {
      console.error("Failed to register collaborator selection cleanup:", error);
    });

    if (collaboratorSelectionWriteTimeoutRef.current) {
      clearTimeout(collaboratorSelectionWriteTimeoutRef.current);
    }

    collaboratorSelectionWriteTimeoutRef.current = setTimeout(() => {
      collaboratorSelectionWriteTimeoutRef.current = null;

      if (
        activeSelection &&
        Number.isFinite(Number(activeSelection.start)) &&
        Number.isFinite(Number(activeSelection.end)) &&
        Number(activeSelection.end) > Number(activeSelection.start)
      ) {
        set(currentSelectionRef, {
          userId: currentUserId,
          name: currentUserName || currentUserEmail || "Another collaborator",
          email: currentUserEmail || "",
          start: Number(activeSelection.start),
          end: Number(activeSelection.end),
          editingAnnotationId: isEditing ? selectedAnnotation?.id || null : null,
          updatedAt: realtimeServerTimestamp(),
        }).catch((error) => {
          console.error("Failed to publish collaborator selection:", error);
        });
      } else {
        remove(currentSelectionRef).catch((error) => {
          console.error("Failed to clear collaborator selection:", error);
        });
      }
    }, 80);

    return () => {
      if (collaboratorSelectionWriteTimeoutRef.current) {
        clearTimeout(collaboratorSelectionWriteTimeoutRef.current);
        collaboratorSelectionWriteTimeoutRef.current = null;
      }
    };
  }, [
    activeSelection,
    currentUserId,
    currentUserName,
    currentUserEmail,
    ownerId,
    projectId,
    isEditing,
    selectedAnnotation?.id,
    syncStatus,
  ]);

  // Remove this user's temporary selection when leaving the annotation page.
  useEffect(() => {
    return () => {
      if (!currentUserId || !ownerId || !projectId) return;

      const currentSelectionRef = databaseRef(
        realtimeDb,
        `collaboratorSelections/${ownerId}/${projectId}/${currentUserId}`
      );

      remove(currentSelectionRef).catch((error) => {
        console.error("Failed to clear collaborator selection on page exit:", error);
      });
    };
  }, [currentUserId, ownerId, projectId]);

  // Release any annotation checkout lock when leaving this page.
  // Keep onDisconnect armed while the explicit release is attempted. If the
  // page disappears before the transaction completes, Firebase can still
  // remove the lock when this client disconnects.
  useEffect(() => {
    return () => {
      const lockRef = activeEditLockRef.current;
      if (!lockRef || !currentUserId) return;

      runRealtimeTransaction(lockRef, (currentLock) => {
        if (currentLock?.userId === currentUserId) return null;
        return;
      }).catch((error) => {
        console.error("Failed to clear annotation lock on page exit:", error);
      });
      activeEditLockRef.current = null;
    };
  }, [currentUserId, ownerId, projectId]);

  // Load project annotations in real time
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
    },
      (error) => {
        console.error("Failed to synchronise annotations:", error);
        if (!isMountedRef.current) return;
        setSyncStatus("error");
        setSyncMessage(
          "Annotations could not be synchronised in real time. Please check your connection. Firebase will retry automatically."
        );
      }
    );
    return () => unsubscribe();
  }, [ownerId, projectId]);

  // Load annotation history only while the Log History modal is open.
  useEffect(() => {
    if (!showLogHistory || !ownerId || !projectId) return;

    setHistoryLoading(true);
    setHistoryError("");

    const historyQuery = query(
      collection(db, "users", ownerId, "projects", projectId, "annotationHistory"),
      orderBy("timestamp", "desc")
    );

    const unsubscribe = onSnapshot(
      historyQuery,
      (snapshot) => {
        if (!isMountedRef.current) return;

        setAnnotationHistory(
          snapshot.docs.map((historyDoc) => ({
            id: historyDoc.id,
            ...historyDoc.data(),
          }))
        );
        setHistoryLoading(false);
      },
      (error) => {
        console.error("Failed to load annotation history:", error);
        if (!isMountedRef.current) return;
        setHistoryError(
          "Unable to load annotation history. Check your Firebase access and Firestore permissions."
        );
        setHistoryLoading(false);
      }
    );

    return () => unsubscribe();
  }, [showLogHistory, ownerId, projectId]);

  // Close the edit panel if the annotation currently being edited no longer exists.
  useEffect(() => {
    if (!isEditing || !selectedAnnotation?.id) return;

    const annotationStillExists = annotations.some(
      (annotation) => annotation.id === selectedAnnotation.id
    );

    if (!annotationStillExists) {
      clearEditRegion();
      setSelectedAnnotation(null);
      setIsEditing(false);
      setEditErrors({});
      setEditWarning("");
    }
  }, [annotations, isEditing, selectedAnnotation]);

  // Load user-level custom labels in real time
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

  // Initialise shared WaveSurfer instance
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

      const rawStart = Number(region.start.toFixed(3));
      const rawEnd = Number(region.end.toFixed(3));

      const start = Math.min(rawStart, rawEnd);
      const end = Math.max(rawStart, rawEnd);

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

    const unsubRegionUpdate = regions.on("region-update", (region) => {
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
      unsubRegionUpdate?.();
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

  // Apply zoom level relative to the current fit
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

  // Reapply zoom level when the browser window is resized
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

  const getSpectrogramTimeFromPointer = (event) => {
    const viewport = spectrogramViewportRef.current;

    if (!viewport || duration <= 0) {
      return 0;
    }

    const rect = viewport.getBoundingClientRect();

    const x =
      event.clientX -
      rect.left +
      viewport.scrollLeft;

    const totalWidth = Math.max(
      viewport.scrollWidth,
      rect.width
    );

    const ratio = x / totalWidth;
    const time = ratio * duration;

    return Math.min(
      duration,
      Math.max(0, time)
    );
  };

  const handleSpectrogramPointerDown = (event) => {
    if (!audioReady || event.button !== 0) return;

    event.preventDefault();

    const anchorTime =
      getSpectrogramTimeFromPointer(event);

    spectrogramDragRef.current = {
      isDragging: true,
      anchorTime,
      region: null,
    };

    event.currentTarget.setPointerCapture?.(
      event.pointerId
    );
  };

  const handleSpectrogramPointerMove = (event) => {
    const drag = spectrogramDragRef.current;

    if (!drag.isDragging) return;

    const regions = regionsRef.current;

    if (!regions) return;

    const pointerTime =
      getSpectrogramTimeFromPointer(event);

    const start = Math.min(
      drag.anchorTime,
      pointerTime
    );

    const end = Math.max(
      drag.anchorTime,
      pointerTime
    );

    if (end - start < TIME_EPSILON) {
      return;
    }

    if (!drag.region) {
      const previous = activeRegionRef.current;

      if (previous) {
        previous.remove();
      }

      const newRegion = regions.addRegion({
        start,
        end,
        color: "rgba(99, 102, 241, 0.25)",
        drag: true,
        resize: true,
      });

      drag.region = newRegion;
      activeRegionRef.current = newRegion;
    } else {
      drag.region.setOptions({
        start,
        end,
      });
    }

    const normalisedStart =
      Number(start.toFixed(3));

    const normalisedEnd =
      Number(end.toFixed(3));

    setActiveSelection({
      start: normalisedStart,
      end: normalisedEnd,
    });

    if (editingRegionRef.current) {
      setEditStart(normalisedStart);
      setEditEnd(normalisedEnd);
    } else {
      setCreateStart(normalisedStart);
      setCreateEnd(normalisedEnd);
    }
  };

  const handleSpectrogramPointerUp = (event) => {
    const drag = spectrogramDragRef.current;

    if (!drag.isDragging) return;

    event.currentTarget.releasePointerCapture?.(
      event.pointerId
    );

    spectrogramDragRef.current = {
      isDragging: false,
      anchorTime: 0,
      region: null,
    };
  };

  const handleSpectrogramPointerCancel = () => {
    spectrogramDragRef.current = {
      isDragging: false,
      anchorTime: 0,
      region: null,
    };
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
      : selectedClassType === "Others"
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

    if (className === "Others") {
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
      setSelectedClassType("Others");
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

  const buildAnnotationHistoryRecord = ({
    action,
    annotationId,
    before = null,
    after = null,
  }) => ({
    action,
    annotationId,
    userId: currentUserId,
    userName: currentUserName,
    userEmail: currentUserEmail,
    timestamp: serverTimestamp(),
    before,
    after,
  });

  const handleCreateAnnotation = async () => {
    if (!currentUserId || !canEditAnnotations) return;

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

    if (selectedClassType === "Others" && !selectedMiscellaneousLabel) {
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

    const annotationData = {
      startTime: start,
      endTime: end,
      label,
      annotationClass,
      comment: createComment.trim(),
      authorId: currentUserId,
      authorName: currentUserName,
      authorEmail: currentUserEmail,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      updatedById: currentUserId,
    };

    try {
      const annotationRef = doc(
        collection(db, "users", ownerId, "projects", projectId, "annotations")
      );

      const historyRef = doc(
        collection(db, "users", ownerId, "projects", projectId, "annotationHistory")
      );

      const batch = writeBatch(db);

      batch.set(annotationRef, annotationData);

      batch.set(
        historyRef,
        buildAnnotationHistoryRecord({
          action: "created",
          annotationId: annotationRef.id,
          before: null,
          after: {
            startTime: start,
            endTime: end,
            label,
            annotationClass,
            comment: createComment.trim(),
          },
        })
      );

      await batch.commit();

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

  const releaseAnnotationLock = async () => {
    const lockRef = activeEditLockRef.current;
    if (!lockRef || !currentUserId) return;

    try {
      const result = await runRealtimeTransaction(lockRef, (currentLock) => {
        if (!currentLock || currentLock.userId === currentUserId) return null;
        return;
      });

      // Only cancel the disconnect cleanup after the explicit release has
      // completed (or if the lock no longer belongs to this user). This avoids
      // leaving a permanent lock when the connection drops during cleanup.
      const remainingLock = result.snapshot.val();
      if (result.committed || remainingLock?.userId !== currentUserId) {
        await onDisconnect(lockRef).cancel();
        activeEditLockRef.current = null;
      }
    } catch (error) {
      // Do not cancel onDisconnect here. It is our fallback cleanup if the
      // explicit transaction failed because the connection disappeared.
      console.error("Failed to release annotation lock:", error);
    }
  };

  const handleEditOpen = async (annotation) => {
    if (!canEditAnnotations || !currentUserId || !ownerId || !projectId || !annotation?.id) return;

    setEditLockNotice("");

    const lockRef = databaseRef(
      realtimeDb,
      `annotationLocks/${ownerId}/${projectId}/${annotation.id}`
    );

    try {
      const result = await runRealtimeTransaction(lockRef, (currentLock) => {
        if (!currentLock || currentLock.userId === currentUserId) {
          return {
            userId: currentUserId,
            name: currentUserName || currentUserEmail || "Another collaborator",
            email: currentUserEmail || "",
            annotationId: annotation.id,
            lockedAt: Date.now(),
          };
        }

        return;
      });

      if (!result.committed) {
        const existingLock = result.snapshot.val();
        const editorName =
          existingLock?.name || existingLock?.email || "Another collaborator";
        setEditLockNotice(
          `${editorName} is currently editing this annotation. You can continue working on other annotations.`
        );
        return;
      }

      activeEditLockRef.current = lockRef;
      await onDisconnect(lockRef).remove();
    } catch (error) {
      console.error("Failed to acquire annotation lock:", error);
      setEditLockNotice(
        "Unable to reserve this annotation for editing. Please try again."
      );
      return;
    }

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
    setEditLockNotice("");
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

    if (className === "Others") {
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

  // Save annotation edits to Firestore
  const handleSaveEdit = async () => {
    if (!canEditAnnotations || !selectedAnnotation) return;

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

    const beforeData = {
      startTime: selectedAnnotation.startTime,
      endTime: selectedAnnotation.endTime,
      label: selectedAnnotation.label,
      annotationClass: selectedAnnotation.annotationClass || null,
      comment: selectedAnnotation.comment || "",
    };

    const afterData = {
      startTime: start,
      endTime: end,
      label: editLabel.trim(),
      annotationClass:
        editAnnotationClass || {
          name: editLabel.trim(),
          color: "#94a3b8",
          type: "default",
        },
      comment: editComment.trim(),
    };

    try {
      const annotationRef = doc(
        db,
        "users",
        ownerId,
        "projects",
        projectId,
        "annotations",
        selectedAnnotation.id
      );

      const historyRef = doc(
        collection(db, "users", ownerId, "projects", projectId, "annotationHistory")
      );

      const batch = writeBatch(db);

      batch.update(annotationRef, {
        ...afterData,
        updatedAt: serverTimestamp(),
        updatedById: currentUserId,
      });

      batch.set(
        historyRef,
        buildAnnotationHistoryRecord({
          action: "updated",
          annotationId: selectedAnnotation.id,
          before: beforeData,
          after: afterData,
        })
      );

      await batch.commit();

      if (!isMountedRef.current) return;

      await releaseAnnotationLock();

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

  const handleCancelEdit = async () => {
    await releaseAnnotationLock();
    clearEditRegion();
    setSelectedAnnotation(null);
    setIsEditing(false);
    setEditErrors({});
    setEditWarning("");
  };

  const handleClosePanel = async () => {
    await releaseAnnotationLock();
    clearEditRegion();
    setSelectedAnnotation(null);
    setIsEditing(false);
    setEditErrors({});
    setEditWarning("");
  };

  const handleDeleteClick = (annotation) => {
    if (!canEditAnnotations) return;
    setAnnotationToDelete(annotation);
    setShowDeleteConfirm(true);
  };

  const handleConfirmDelete = async () => {
    if (!canEditAnnotations || !annotationToDelete) return;

    try {
      const annotationRef = doc(
        db,
        "users",
        ownerId,
        "projects",
        projectId,
        "annotations",
        annotationToDelete.id
      );

      const historyRef = doc(
        collection(db, "users", ownerId, "projects", projectId, "annotationHistory")
      );

      const batch = writeBatch(db);

      batch.delete(annotationRef);

      batch.set(
        historyRef,
        buildAnnotationHistoryRecord({
          action: "deleted",
          annotationId: annotationToDelete.id,
          before: {
            startTime: annotationToDelete.startTime,
            endTime: annotationToDelete.endTime,
            label: annotationToDelete.label,
            annotationClass: annotationToDelete.annotationClass || null,
            comment: annotationToDelete.comment || "",
          },
          after: null,
        })
      );

      await batch.commit();

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

  // Determine selected annotation for download
  const exportSelectedAnnotation = annotations.find((annotation) => annotation.id === exportSelectedAnnotationId) || null;

  // Close download menu on outside click or Escape
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


  // Clear export selection if the annotation is deleted in real time
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

  // Download audio segment handler
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

  // Download annotation handler
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

  // Download annotation and audio segment handler
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


  // Download all annotations handler
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


  // Download all annotations and audio segments handler
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
      <div className="relative flex items-center justify-between border-b border-slate-200 bg-white px-6 py-3">
        <div className="flex items-center gap-4">
          <button
            onClick={() => navigate("/dashboard")}
            className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50 transition"
          >
            ← Dashboard
          </button>
          <h1 className="text-lg font-semibold text-slate-800">{fileName}</h1>
        </div>

        <div style={{ left: `${leftWidth + 6}px` }}
          className="absolute flex items-center gap-2 text-sm text-slate-500">
          <div className="flex -space-x-2">
            {activeCollaborators.map((collaborator) => (
              <div
                key={collaborator.id}
                title={collaborator.name || collaborator.email || "Unknown user"}
                className={`flex h-8 w-8 items-center justify-center rounded-full ring-2 ring-white text-xs font-semibold ${getAuthorColor(collaborator.id)}`}
              >
                {getInitials(collaborator.name || collaborator.email)}
              </div>
            ))}
          </div>
          <span>
            {activeCollaborators.length}{" "}
            {activeCollaborators.length === 1 ? "collaborator" : "collaborators"}
          </span>
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
          <button
            type="button"
            onClick={() => setShowLogHistory(true)}
            className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50 transition"
          >
            <History className="h-4 w-4" /> Log History
          </button>
          {currentUserId === ownerId && (
            <button
              type="button"
              onClick={() => setShowShareModal(true)}
              className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-600 transition hover:bg-slate-50"
            >
              <Share2 className="h-4 w-4" /> Share
            </button>
          )}
          <button className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50 transition">
            <Maximize2 className="h-4 w-4" /> Expand All Annotations
          </button>
        </div>
      </div>

      {lastAccessError && (
        <div role="alert" className="border-b border-amber-200 bg-amber-50 px-6 py-2 text-sm text-amber-800">
          {lastAccessError} Check the Firestore permissions for this project.
        </div>
      )}

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

      {/* Real-time collaboration status */}
      {syncMessage && (
        <div
          className={`border-b px-6 py-2 text-sm ${syncStatus === "restored"
            ? "border-green-200 bg-green-50 text-green-700"
            : "border-amber-200 bg-amber-50 text-amber-800"
            }`}
          role="status"
        >
          <div className="flex items-center justify-between gap-4">
            <span>{syncMessage}</span>
            {syncStatus !== "disconnected" && (
              <button
                type="button"
                onClick={() => {
                  setSyncStatus("connected");
                  setSyncMessage("");
                }}
                className="rounded p-1 opacity-60 transition hover:bg-black/5 hover:opacity-100"
                aria-label="Dismiss synchronisation message"
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
        <div style={{ width: leftWidth }} className={`${isEditing ? "hidden" : ""} flex-shrink-0 overflow-y-auto border-r border-slate-200 bg-white px-4 py-4`}>
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

          {canEditAnnotations && (
            <>
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
                    annotationClass.name === "Others" && selectedMiscellaneousLabel
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

              {selectedClassType === "Others" && selectedMiscellaneousLabel && (
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

              <div className="mb-1 flex items-center justify-between gap-2">
                <label className="block text-xs font-medium uppercase tracking-wide text-slate-400">Comments</label>
                <button
                  type="button"
                  onClick={() => setExpandedCommentMode("create")}
                  className="flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-indigo-600 transition hover:bg-indigo-50"
                >
                  <Maximize2 className="h-3.5 w-3.5" />
                  Expand
                </button>
              </div>
              <textarea
                value={createComment}
                onChange={(e) => setCreateComment(e.target.value)}
                maxLength={2000}
                className={`mb-1 min-h-[260px] w-full resize-y rounded-lg border px-3 py-2 text-sm leading-6 outline-none focus:ring-2 focus:ring-indigo-300 ${createErrors.comment ? "border-red-400" : "border-slate-200"
                  }`}
                placeholder="Add a detailed note about this annotation..."
              />
              <div className="mb-2 flex items-center justify-between gap-2">
                {createErrors.comment ? (
                  <p className="text-xs text-red-500">{createErrors.comment}</p>
                ) : (
                  <span />
                )}
                <span className="text-xs tabular-nums text-slate-400">{createComment.length} / 2000</span>
              </div>
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
            </>
          )}
          {!canEditAnnotations && (
            <p className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">
              Select or drag on the waveform to view times. Viewer access does not allow changing annotations.
            </p>
          )}
        </div>

        {/* Drag handle — resize left panel */}
        <div
          onMouseDown={() => (resizingRef.current = "left")}
          className={`${isEditing ? "hidden" : ""} w-1.5 flex-shrink-0 cursor-col-resize bg-slate-100 hover:bg-indigo-200 transition`}
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

                {duration > 0 && collaboratorSelections.map((selection) => {
                  const start = Math.max(0, Math.min(duration, Number(selection.start)));
                  const end = Math.max(start, Math.min(duration, Number(selection.end)));
                  if (end <= start) return null;

                  const viewStart = Math.max(0, Number(visibleRange.start) || 0);
                  const viewEnd =
                    Number(visibleRange.end) > viewStart
                      ? Math.min(duration, Number(visibleRange.end))
                      : duration;
                  const viewDuration = Math.max(TIME_EPSILON, viewEnd - viewStart);

                  const clippedStart = Math.max(start, viewStart);
                  const clippedEnd = Math.min(end, viewEnd);
                  if (clippedEnd <= clippedStart) return null;

                  const overlayColor = getCollaboratorOverlayColor(selection.userId);
                  const collaboratorName =
                    selection.name || selection.email || "Collaborator";

                  return (
                    <div
                      key={`waveform-${selection.userId}`}
                      className="pointer-events-none absolute inset-y-0 z-[15] border-x-[3px]"
                      style={{
                        left: `${((clippedStart - viewStart) / viewDuration) * 100}%`,
                        width: `${((clippedEnd - clippedStart) / viewDuration) * 100}%`,
                        borderColor: overlayColor.border,
                        backgroundColor: overlayColor.fill,
                        boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.85), 0 0 0 1px rgba(15,23,42,0.55)",
                      }}
                      aria-label={`${collaboratorName} is editing from ${formatTimestamp(start)} to ${formatTimestamp(end)}`}
                    >
                      <div
                        className="absolute left-1 top-1 max-w-[180px] truncate rounded px-2 py-1 text-[10px] font-semibold text-slate-900 shadow-sm"
                        style={{ backgroundColor: overlayColor.border }}
                      >
                        {collaboratorName} is editing...
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="border-y border-slate-200 bg-white px-3 py-2 text-xs font-medium uppercase tracking-wide text-slate-400">
                Spectrogram
              </div>

              <div
                ref={spectrogramViewportRef}
                onPointerDown={handleSpectrogramPointerDown}
                onPointerMove={handleSpectrogramPointerMove}
                onPointerUp={handleSpectrogramPointerUp}
                onPointerCancel={handleSpectrogramPointerCancel}
                className="w-full cursor-crosshair overflow-hidden bg-slate-950"
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
                      className="pointer-events-none absolute inset-y-0 z-10 border border-cyan-300 bg-cyan-300/[0.08] shadow-[0_0_4px_rgba(103,232,249,0.85)]"
                      style={{
                        left: `${(activeSelection.start / duration) * 100}%`,
                        width: `${((activeSelection.end - activeSelection.start) / duration) * 100}%`,
                      }}
                      aria-hidden="true"
                    />
                  )}

                  {duration > 0 && collaboratorSelections.map((selection) => {
                    const start = Math.max(0, Math.min(duration, Number(selection.start)));
                    const end = Math.max(start, Math.min(duration, Number(selection.end)));
                    if (end <= start) return null;

                    const overlayColor = getCollaboratorOverlayColor(selection.userId);
                    const collaboratorName = selection.name || selection.email || "Collaborator";

                    return (
                      <div
                        key={selection.userId}
                        className="pointer-events-none absolute inset-y-0 z-[15] border-x-[3px]"
                        style={{
                          left: `${(start / duration) * 100}%`,
                          width: `${((end - start) / duration) * 100}%`,
                          borderColor: overlayColor.border,
                          backgroundColor: overlayColor.fill,
                          boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.85), 0 0 0 1px rgba(15,23,42,0.55)",
                        }}
                        aria-label={`${collaboratorName} is editing from ${formatTimestamp(start)} to ${formatTimestamp(end)}`}
                      >
                        <div
                          className="absolute left-1 top-1 max-w-[180px] truncate rounded px-2 py-1 text-[10px] font-semibold text-slate-900 shadow-sm"
                          style={{ backgroundColor: overlayColor.border }}
                        >
                          {collaboratorName} is editing...
                        </div>
                      </div>
                    );
                  })}

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
                  className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-5 py-2 text-sm font-medium text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-indigo-300"
                >
                  {isPlaying ? (
                    <>
                      <Pause className="h-4 w-4" />
                      Pause
                    </>
                  ) : (
                    <>
                      <Play className="h-4 w-4" />
                      Play
                    </>
                  )}
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
                      <th className="px-3 py-2">Author</th>
                      <th className="px-3 py-2">Comments</th>
                      {canEditAnnotations && <th className="px-3 py-2">Actions</th>}
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
                        const hasAuthor = Boolean(ann.authorId);
                        const authorStyle = getAuthorColor(ann.authorId);
                        const authorTitle = hasAuthor
                          ? ann.authorName || ann.authorEmail || "Unknown author"
                          : "Unknown author";
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
                              <div
                                className={`flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-semibold ${authorStyle}`}
                                title={authorTitle}
                              >
                                {getAnnotationAuthorInitials(ann)}
                              </div>
                            </td>
                            <td className="max-w-[220px] truncate px-3 py-2 text-slate-500">{ann.comment}</td>
                            {canEditAnnotations && (
                              <td className="px-3 py-2">
                                <div className="flex items-center gap-1">
                                  <button
                                    type="button"
                                    onClick={() => handleEditOpen(ann)}
                                    className="rounded-lg p-1.5 text-slate-400 transition hover:bg-indigo-50 hover:text-indigo-600"
                                    title="Edit annotation"
                                    aria-label={`Edit ${ann.label || "annotation"}`}
                                  >
                                    <Pencil className="h-4 w-4" />
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => handleDeleteClick(ann)}
                                    className="rounded-lg p-1.5 text-slate-400 transition hover:bg-red-50 hover:text-red-500"
                                    title="Delete annotation"
                                    aria-label={`Delete ${ann.label || "annotation"}`}
                                  >
                                    <Trash2 className="h-4 w-4" />
                                  </button>
                                </div>
                              </td>
                            )}
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
            {/* Edit panel resize handle — occupies the same left-side slot as Add */}
            <div
              onMouseDown={() => (resizingRef.current = "left")}
              className="order-[-1] w-1.5 flex-shrink-0 cursor-col-resize bg-slate-100 hover:bg-indigo-200 transition"
            />

            {/* Edit replaces Add in the same left position and uses the same width */}
            <div
              style={{ width: leftWidth }}
              className="order-[-2] flex-shrink-0 overflow-y-auto border-r border-slate-200 bg-white px-4 py-4"
            >
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
                          : annotationClass.name === "Others"
                            ? isMisc
                            : !isCustom && !isMisc && editLabel === annotationClass.name;

                      const summary =
                        annotationClass.name === "Custom Label" && isCustom
                          ? editLabel
                          : annotationClass.name === "Others" && isMisc
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
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <label className="block text-xs font-medium uppercase tracking-wide text-slate-400">Comments</label>
                    <button
                      type="button"
                      onClick={() => setExpandedCommentMode("edit")}
                      className="flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-indigo-600 transition hover:bg-indigo-50"
                    >
                      <Maximize2 className="h-3.5 w-3.5" />
                      Expand
                    </button>
                  </div>
                  <textarea
                    value={editComment}
                    onChange={(e) => setEditComment(e.target.value)}
                    maxLength={2000}
                    className={`min-h-[220px] w-full resize-y rounded-lg border px-3 py-2 text-sm leading-6 outline-none focus:ring-2 focus:ring-indigo-300 ${editErrors.comment ? "border-red-400" : "border-slate-200"
                      }`}
                    placeholder="Add a detailed note about this annotation..."
                  />
                  <div className="mt-1 flex items-center justify-between gap-2">
                    {editErrors.comment ? (
                      <p className="text-xs text-red-500">{editErrors.comment}</p>
                    ) : (
                      <span />
                    )}
                    <span className="text-xs tabular-nums text-slate-400">{editComment.length} / 2000</span>
                  </div>
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

      {editLockNotice && (
        <div className="fixed left-1/2 top-5 z-[100] w-[min(92vw,520px)] -translate-x-1/2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 shadow-lg">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-amber-800">Annotation currently in progress</p>
              <p className="mt-1 text-sm text-amber-700">{editLockNotice}</p>
            </div>
            <button
              type="button"
              onClick={() => setEditLockNotice("")}
              className="rounded-md px-2 py-1 text-sm text-amber-700 hover:bg-amber-100"
              aria-label="Dismiss annotation lock notice"
            >
              ×
            </button>
          </div>
        </div>
      )}

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

      {/* Expanded comment editor */}
      {expandedCommentMode && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/35 p-6 backdrop-blur-sm">
          <div className="flex h-[75vh] w-full max-w-4xl flex-col rounded-2xl bg-white p-6 shadow-2xl">
            <div className="mb-4 flex items-center justify-between gap-4">
              <div>
                <h3 className="text-lg font-semibold text-slate-800">Annotation Comment</h3>
                <p className="mt-1 text-sm text-slate-500">
                  Write a detailed note while keeping the audio workspace unchanged.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setExpandedCommentMode(null)}
                className="rounded-lg p-2 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
                aria-label="Close expanded comment editor"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <textarea
              autoFocus
              value={expandedCommentMode === "create" ? createComment : editComment}
              onChange={(e) => {
                if (expandedCommentMode === "create") {
                  setCreateComment(e.target.value);
                } else {
                  setEditComment(e.target.value);
                }
              }}
              maxLength={2000}
              className="min-h-0 flex-1 resize-none rounded-xl border border-slate-200 p-4 text-sm leading-6 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-200"
              placeholder="Write your annotation comment..."
            />

            <div className="mt-3 flex items-center justify-between gap-4">
              <span className="text-xs text-slate-400">
                The text is kept in sync with the annotation form.
              </span>
              <div className="flex items-center gap-3">
                <span className="text-xs tabular-nums text-slate-400">
                  {(expandedCommentMode === "create" ? createComment : editComment).length} / 2000
                </span>
                <button
                  type="button"
                  onClick={() => setExpandedCommentMode(null)}
                  className="rounded-lg bg-indigo-600 px-5 py-2 text-sm font-medium text-white transition hover:bg-indigo-700"
                >
                  Done
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ADP-123: Annotation log history modal */}
      {showLogHistory && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/30 p-4 backdrop-blur-sm">
          <div className="flex max-h-[85vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
              <div>
                <h3 className="text-lg font-semibold text-slate-800">Annotation Log History</h3>
                <p className="mt-1 text-sm text-slate-500">
                  Created, edited and deleted annotation changes for this project.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowLogHistory(false)}
                className="rounded-lg p-2 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
                aria-label="Close annotation log history"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="overflow-y-auto p-6">
              {historyLoading ? (
                <p className="py-10 text-center text-sm text-slate-500">Loading annotation history...</p>
              ) : historyError ? (
                <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                  {historyError}
                </div>
              ) : annotationHistory.length === 0 ? (
                <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-10 text-center text-sm text-slate-500">
                  No annotation history has been recorded yet.
                </div>
              ) : (
                <div className="overflow-x-auto rounded-xl border border-slate-200">
                  <table className="min-w-full divide-y divide-slate-200 text-left text-sm">
                    <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                      <tr>
                        <th className="px-4 py-3">Date / Time</th>
                        <th className="px-4 py-3">Action</th>
                        <th className="px-4 py-3">User</th>
                        <th className="px-4 py-3">Annotation</th>
                        <th className="px-4 py-3">Change</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 bg-white">
                      {annotationHistory.map((entry) => {
                        const entryDate = entry.timestamp?.toDate?.();
                        const displayDate = entryDate
                          ? entryDate.toLocaleString()
                          : "Pending timestamp";
                        const annotationData = entry.after || entry.before || {};
                        const actionLabel =
                          entry.action === "created"
                            ? "Created"
                            : entry.action === "updated"
                              ? "Updated"
                              : entry.action === "deleted"
                                ? "Deleted"
                                : entry.action || "Unknown";

                        return (
                          <tr key={entry.id} className="align-top">
                            <td className="whitespace-nowrap px-4 py-3 text-slate-600">
                              {displayDate}
                            </td>
                            <td className="px-4 py-3">
                              <span className="inline-flex rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-700">
                                {actionLabel}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-slate-600">
                              <div className="font-medium text-slate-700">
                                {entry.userName || entry.userEmail || "Unknown user"}
                              </div>
                              {entry.userName && entry.userEmail && (
                                <div className="mt-0.5 text-xs text-slate-400">{entry.userEmail}</div>
                              )}
                            </td>
                            <td className="px-4 py-3 text-slate-600">
                              <div className="font-medium text-slate-700">
                                {annotationData.label || "Unlabelled annotation"}
                              </div>
                              {Number.isFinite(Number(annotationData.startTime)) &&
                                Number.isFinite(Number(annotationData.endTime)) && (
                                  <div className="mt-1 text-xs tabular-nums text-slate-400">
                                    {formatTimestamp(annotationData.startTime)} → {formatTimestamp(annotationData.endTime)}
                                  </div>
                                )}
                            </td>
                            <td className="min-w-[260px] px-4 py-3 text-slate-600">
                              {entry.action === "updated" ? (
                                <div className="space-y-1 text-xs">
                                  <div>
                                    <span className="font-semibold text-slate-500">Before:</span>{" "}
                                    {entry.before?.label || "Unlabelled"}, {formatTimestamp(entry.before?.startTime)} → {formatTimestamp(entry.before?.endTime)}
                                  </div>
                                  <div>
                                    <span className="font-semibold text-slate-500">After:</span>{" "}
                                    {entry.after?.label || "Unlabelled"}, {formatTimestamp(entry.after?.startTime)} → {formatTimestamp(entry.after?.endTime)}
                                  </div>
                                </div>
                              ) : entry.action === "deleted" ? (
                                <span className="text-xs">Annotation deleted</span>
                              ) : (
                                <span className="text-xs">Annotation created</span>
                              )}
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

      <ShareProjectModal
        isOpen={showShareModal}
        onClose={() => setShowShareModal(false)}
        projectId={projectId}
        ownerId={ownerId}
        projectTitle={fileName}
        ownerName={currentUserName}
        sharedWith={sharedWith}
        sharedPermissions={sharedPermissions}
        onSharedWithChange={(nextSharedWith, nextSharedPermissions) => {
          setSharedWith(nextSharedWith);
          setSharedPermissions(nextSharedPermissions);
        }}
      />
    </div>
  );
}
